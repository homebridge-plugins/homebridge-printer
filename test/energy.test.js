/**
 * Estimated energy over Matter: the plugin inside Homebridge's own API, with a stand-in
 * api.matter that keeps Homebridge's Matter rules (required fields, known cluster names,
 * no updates before registration, refusals while the Matter server starts, and cached
 * accessories restored before the plugin starts).
 */
import fs from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { normaliseEnergyConfig, powerState } from '../lib/energy.js'
import { createPrinter } from './fake-ipp-printer.js'
import { boot, homebridge, loadHomebridge, sleep, useStorage } from './harness.js'

const DASHBOARD = 18590
const CLUSTERS = new Set([
  'onOff',
  'electricalPowerMeasurement',
  'electricalEnergyMeasurement',
  'bridgedDeviceBasicInformation',
  'basicInformation',
  'identify',
])

let printer
let storage
let run

function makeMatter(api, { startingRefusals = 0, restored = [] } = {}) {
  const registered = new Map()
  const log = { errors: [], registerCalls: 0, unregistered: [] }
  let refusals = startingRefusals
  // like Homebridge: cached accessories are restored before the plugin starts, with
  // their state but empty handlers, and count as registered until the plugin registers them
  for (const a of restored) {
    registered.set(a.UUID, {
      ...a,
      state: {},
      partState: Object.fromEntries((a.parts || []).map(p => [
        p.id,
        structuredClone(p.clusters),
      ])),
      restored: true,
    })
  }
  const matter = {
    uuid: api.hap.uuid,
    deviceTypes: {
      OnOffOutlet: { name: 'OnOffPlugInUnitDevice' },
      BridgedNode: { name: 'BridgedNodeEndpoint' },
    },
    async registerPlatformAccessories(pluginName, platformName, accessories) {
      log.registerCalls++
      if (refusals-- > 0) {
        throw new Error('Cannot register Matter accessories yet - the Matter server for this bridge is still starting.')
      }
      for (const a of accessories) {
        for (const field of [
          'UUID',
          'displayName',
          'deviceType',
          'manufacturer',
          'model',
          'serialNumber',
        ]) {
          if (!a[field]) {
            log.errors.push(`missing ${field}`)
          }
        }
        for (const field of [
          'displayName',
          'model',
          'manufacturer',
          'serialNumber',
        ]) {
          if (String(a[field]).length > 32) {
            log.errors.push(`${field} longer than 32: ${a[field]}`)
          }
        }
        const parts = {}
        for (const part of a.parts || []) {
          for (const c of Object.keys(part.clusters || {})) {
            if (!CLUSTERS.has(c)) {
              log.errors.push(`unknown cluster ${c}`)
            }
          }
          parts[part.id] = structuredClone(part.clusters)
        }
        const existing = registered.get(a.UUID)
        if (existing && !existing.restored) {
          log.errors.push(`registered twice: ${a.displayName}`)
        }
        registered.set(a.UUID, {
          ...a,
          state: structuredClone(a.clusters || {}),
          partState: existing?.restored ? existing.partState : parts,
          restored: false,
        })
      }
    },
    async unregisterPlatformAccessories(pluginName, platformName, accessories) {
      for (const a of accessories) {
        registered.delete(a.UUID)
        log.unregistered.push(a.displayName)
      }
    },
    async updateAccessoryState(uuid, cluster, attrs, partId) {
      const a = registered.get(uuid)
      if (!a) {
        log.errors.push(`update before registration: ${cluster}`)
        throw new Error('not registered')
      }
      const target = partId ? a.partState[partId] : a.state
      if (!target || !(cluster in target)) {
        log.errors.push(`update to ${cluster} not declared on ${partId || 'accessory'}`)
        return
      }
      Object.assign(target[cluster], attrs)
    },
    async getAccessoryState(uuid, cluster, partId) {
      const a = registered.get(uuid)
      return partId ? a?.partState[partId]?.[cluster] : a?.state[cluster]
    },
  }
  return { matter, registered, log }
}

/** Starts the plugin with Matter on (or off), on Homebridge 2.5 (or another version). */
function start(config, { matterOn = true, version, startingRefusals, restored, cachedHap = [] } = {}) {
  let m
  run = boot(config, {
    setup: (api) => {
      m = makeMatter(api, { startingRefusals, restored })
      if (matterOn) {
        Object.defineProperty(api, 'matter', { value: m.matter, configurable: true })
      }
      api.isMatterEnabled = () => matterOn
      if (version) {
        Object.defineProperty(api, 'serverVersion', { value: version, configurable: true })
        api.versionGreaterOrEqual = v => v.localeCompare(version, undefined, { numeric: true }) <= 0
      }
    },
    cached: cachedHap,
    restore: (platform) => {
      for (const a of restored || []) {
        platform.configureMatterAccessory(a)
      }
    },
  })
  run.m = m
  return run
}

async function stop() {
  run.api.signalShutdown()
  await sleep(300)
}

function cfg(extra = {}, top = {}) {
  return {
    platform: 'Printer',
    printers: [
      {
        name: 'Study',
        address: printer.address,
        polling: 2,
        ...extra,
      },
    ],
    dashboard: { enabled: true, port: DASHBOARD, host: '127.0.0.1' },
    ...top,
  }
}

const part = async (uuid, cluster) => run.m.matter.getAccessoryState(uuid, cluster, 'outlet')

beforeAll(async () => {
  await loadHomebridge()
  storage = useStorage()
  printer = await createPrinter().listen()
})

afterAll(async () => {
  await printer.close()
})

describe('energy over matter', () => {
  let outlet

  it('retries while the matter server starts, then publishes one outlet with energy', async () => {
    start(cfg(), { startingRefusals: 1 })
    await sleep(1500)
    expect(run.m.log.registerCalls).toBe(1)
    expect(run.m.registered.size).toBe(0)

    await sleep(10_500)
    expect(run.m.log.registerCalls).toBe(2)
    outlet = [
      ...run.m.registered.values(),
    ][0]
    expect(outlet.displayName).toBe('Study Online')
    expect(outlet.deviceType.name).toBe('BridgedNodeEndpoint')
    expect(outlet.parts.map(p => p.deviceType.name)).toEqual(['OnOffPlugInUnitDevice'])
    expect(Object.keys(outlet.parts[0].clusters).sort()).toEqual([
      'electricalEnergyMeasurement',
      'electricalPowerMeasurement',
      'onOff',
    ])
    expect(run.registered.map(a => a.displayName)).toEqual(['Study', 'Study Printing'])
    expect(run.m.log.errors).toEqual([])
    expect(run.log.lines.some(l => l.includes('"Study Online" is published with energy'))).toBe(true)
  }, 30_000)

  it('shows the ready power, and the outlet on while the printer is online', async () => {
    await sleep(11_000)
    expect((await part(outlet.UUID, 'electricalPowerMeasurement')).activePower).toBe(2800)
    expect((await part(outlet.UUID, 'onOff')).onOff).toBe(true)
  }, 20_000)

  it('shows the printing power while a job prints', async () => {
    printer.print()
    await sleep(11_000)
    expect((await part(outlet.UUID, 'electricalPowerMeasurement')).activePower).toBe(10_000)
    const dash = await (await fetch(`http://127.0.0.1:${DASHBOARD}/api/status`)).json()
    expect(dash.printers[0].energy).toMatchObject({ state: 'printing', watts: 10 })

    printer.finish()
    await sleep(11_000)
    expect((await part(outlet.UUID, 'electricalPowerMeasurement')).activePower).toBe(2800)
  }, 30_000)

  it('puts the outlet back when it is tapped in the home app', async () => {
    await outlet.parts[0].handlers.onOff.off()
    await run.m.matter.updateAccessoryState(outlet.UUID, 'onOff', { onOff: false }, 'outlet')
    await sleep(1200)
    expect((await part(outlet.UUID, 'onOff')).onOff).toBe(true)
  })

  it('adds up the energy, and saves it on shutdown', async () => {
    const entry = run.platform.energy.entries[0]
    entry.meter.tick(entry.poller.state)
    run.platform.energy.pushEnergy(entry)
    await sleep(100)
    const before = (await part(outlet.UUID, 'electricalEnergyMeasurement')).cumulativeEnergyImported.energy
    entry.meter.tick(entry.poller.state, entry.meter.lastTick + 10 * 60 * 1000)
    run.platform.energy.pushEnergy(entry)
    await sleep(100)
    const after = (await part(outlet.UUID, 'electricalEnergyMeasurement')).cumulativeEnergyImported.energy
    // 10 minutes ready at 2.8 W is about 467 mWh
    expect(after - before).toBeGreaterThanOrEqual(460)
    expect(after - before).toBeLessThanOrEqual(480)

    await stop()
    const file = path.join(storage, 'hp-printer', `energy-${run.platform.devices[0].id}.json`)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).totalMWh).toBeGreaterThanOrEqual(after)
  })

  it('gives a restored outlet its handlers back, and removes an outlet from an older version', async () => {
    const flat = {
      UUID: run.api.hap.uuid.generate('hp-printer:Study:energy'),
      displayName: 'Study Online',
      deviceType: { name: 'OnOffPlugInUnitDevice' },
    }
    start(cfg(), {
      restored: [
        {
          ...outlet,
          parts: outlet.parts.map(p => ({ ...p, handlers: {} })),
        },
        flat,
      ],
    })
    await sleep(1500)
    expect(run.m.log.unregistered).toContain('Study Online')
    expect(run.m.registered.has(flat.UUID)).toBe(false)
    const again = run.m.registered.get(outlet.UUID)
    expect(again.restored).toBe(false)
    expect(typeof again.parts[0].handlers.onOff.off).toBe('function')
    expect(run.m.log.errors).toEqual([])
    await stop()
  })

  it('removes the outlet when energy is turned off', async () => {
    start(cfg({
      energy: { enabled: false },
    }), {
      restored: [outlet],
    })
    await sleep(1500)
    expect(run.m.registered.size).toBe(0)
    await stop()
  })

  it('explains how to turn matter on, and keeps the estimate on the dashboard', async () => {
    start(cfg(), { matterOn: false })
    await sleep(1500)
    expect(
      run.log.lines.some(l =>
        /Energy in Apple Home is off: Matter is not turned on.*Settings → Matter Settings/.test(l),
      ),
    ).toBe(true)
    const dash = await (await fetch(`http://127.0.0.1:${DASHBOARD}/api/status`)).json()
    expect(dash.printers[0].energy.estimated).toBe(true)
    expect(run.registered.some(a => a.displayName === 'Study Online')).toBe(true)
    await stop()
  })

  it('says homebridge 2.3 is needed on an older one', async () => {
    start(cfg(), { version: '2.2.1' })
    await sleep(800)
    expect(run.log.lines.some(l => l.includes('needs Homebridge 2.3.0 or newer (this is 2.2.1)'))).toBe(true)
    expect(run.m.registered.size).toBe(0)
    await stop()
  })

  it('calls the outlet energy when the online switch is turned off', async () => {
    start(cfg({ onlineSwitch: false }))
    await sleep(1500)
    expect([
      ...run.m.registered.values(),
    ][0].displayName).toBe('Study Energy')
    expect(run.registered.some(a => /Online/.test(a.displayName))).toBe(false)
    await stop()
  })
})

describe('matter only', () => {
  it('publishes only over matter and removes the homekit accessories', async () => {
    const old = new homebridge.PlatformAccessory('Study', run.api.hap.uuid.generate('hp-printer:Study'))
    old._associatedPlugin = '@homebridge-plugins/homebridge-printer'
    old._associatedPlatform = 'Printer'
    start(cfg({}, { matterOnly: true }), {
      cachedHap: [
        JSON.parse(JSON.stringify(homebridge.PlatformAccessory.serialize(old))),
      ],
    })
    await sleep(1800)
    const all = [
      ...run.m.registered.values(),
    ]
    const online = all.find(a => a.displayName === 'Study Online')
    const printing = all.find(a => a.displayName === 'Study Printing')
    expect(run.registered).toEqual([])
    expect(run.unregistered.map(a => a.displayName)).toContain('Study')
    expect('electricalPowerMeasurement' in online.parts[0].clusters).toBe(true)
    expect('electricalPowerMeasurement' in printing.parts[0].clusters).toBe(false)
    expect(run.m.log.errors).toEqual([])

    await sleep(3000)
    expect((await part(printing.UUID, 'onOff')).onOff).toBe(false)
    printer.print()
    await sleep(3500)
    expect((await part(printing.UUID, 'onOff')).onOff).toBe(true)
    printer.finish()
    await sleep(3500)
    expect((await part(printing.UUID, 'onOff')).onOff).toBe(false)

    const file = path.join(storage, 'hp-printer', `state-${run.platform.devices[0].id}.json`)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).markers).toHaveLength(2)
    await stop()
  }, 30_000)

  it('without energy, publishes a plain online outlet and the printing one', async () => {
    start(
      cfg(
        {
          energy: { enabled: false },
        },
        { matterOnly: true },
      ),
    )
    await sleep(1500)
    const online = [
      ...run.m.registered.values(),
    ].find(a => a.displayName === 'Study Online')
    expect('electricalPowerMeasurement' in online.parts[0].clusters).toBe(false)
    expect(run.m.registered.size).toBe(2)
    await stop()
  })

  it('keeps the homekit accessories when matter is not on, and says why', async () => {
    start(cfg({}, { matterOnly: true }), { matterOn: false })
    await sleep(1200)
    expect(run.registered.some(a => a.displayName === 'Study')).toBe(true)
    expect(run.log.lines.some(l => l.includes('"Matter only" is turned on, but Matter is not turned on'))).toBe(true)
    await stop()
  })
})

describe('the energy settings', () => {
  it('reads custom wattages, keeping the defaults for empty ones', () => {
    const c = normaliseEnergyConfig({
      energy: {
        printingWatts: 18,
        readyWatts: '3.5',
        sleepWatts: '',
        offWatts: 0,
      },
    })
    expect(c.watts).toEqual({
      printing: 18,
      ready: 3.5,
      sleep: 1.4,
      off: 0,
    })
  })

  it('uses sleep watts after the idle time, and off watts when unreachable', () => {
    const t0 = 1e12
    expect(powerState({ online: true, status: 'idle' }, t0, t0 + 6 * 60_000, 5)).toBe('sleep')
    expect(powerState({ online: false }, null, t0, 5)).toBe('off')
  })
})
