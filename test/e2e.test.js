/**
 * End to end: the plugin inside Homebridge's own API and HAP, against a pretend printer.
 * Fresh start, printing, restart from the cache, the printer switched off, and the
 * switch options.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPrinter } from './fake-ipp-printer.js'
import { asHomeHubSeesIt, boot, homebridge, loadHomebridge, serialise, sleep, useStorage } from './harness.js'

const DASHBOARD = 18587
let printer
let run

function cfg(address, extra = {}) {
  return {
    platform: 'Printer',
    printers: [
      {
        name: 'My Printer',
        address,
        polling: 2,
        marker: true,
        lowInkThreshold: 10,
        history: true,
      },
    ],
    dashboard: { enabled: true, port: DASHBOARD, host: '127.0.0.1' },
    ...extra,
  }
}

const find = name => run.all.find(a => a.displayName === name)
const on = name => find(name).getService(run.hap.Service.Switch).getCharacteristic(run.hap.Characteristic.On).value
const contact = () => find('My Printer').getService(run.hap.Service.ContactSensor)
const inks = acc => acc.services.filter(s => s.UUID === run.hap.Service.FilterMaintenance.UUID)

beforeAll(async () => {
  await loadHomebridge()
  useStorage()
  printer = await createPrinter().listen()
})

afterAll(async () => {
  run?.api.signalShutdown()
  await printer.close()
})

describe('a printer in homebridge', () => {
  it('registers under its own names', () => {
    run = boot(cfg(printer.address))
    expect(run.names).toEqual({ pluginName: '@homebridge-plugins/homebridge-printer', platformName: 'Printer' })
  }, 20_000)

  it('shows the printer, its online and printing switches, and its ink', async () => {
    const C = run.hap.Characteristic
    expect(run.all.map(a => a.displayName).sort()).toEqual(['My Printer', 'My Printer Online', 'My Printer Printing'])
    await sleep(1500)

    expect(contact().getCharacteristic(C.StatusActive).value).toBe(true)
    expect(contact().getCharacteristic(C.ContactSensorState).value).toBe(0)
    expect(on('My Printer Printing')).toBe(false)
    expect(on('My Printer Online')).toBe(true)

    const ink = inks(find('My Printer'))
    const black = ink.find(s => /Black/.test(s.displayName))
    const tri = ink.find(s => /Tri/.test(s.displayName))
    expect(ink).toHaveLength(2)
    expect(black.getCharacteristic(C.FilterLifeLevel).value).toBe(8)
    expect(black.getCharacteristic(C.FilterChangeIndication).value).toBe(1)
    expect(tri.getCharacteristic(C.FilterLifeLevel).value).toBe(60)
    expect(tri.getCharacteristic(C.FilterChangeIndication).value).toBe(0)
    expect(find('My Printer').services.some(s => /History/.test(s.displayName))).toBe(true)

    const hub = await asHomeHubSeesIt(run.hap, run.all)
    expect(hub.count).toBe(3)
    expect(Array.isArray(hub.full)).toBe(true)
  }, 20_000)

  it('serves the dashboard', async () => {
    const status = await (await fetch(`http://127.0.0.1:${DASHBOARD}/api/status`)).json()
    expect(status.printers).toHaveLength(1)
    expect(status.printers[0].markers).toHaveLength(2)
    expect(await (await fetch(`http://127.0.0.1:${DASHBOARD}/`)).text()).toContain('dashboard.js')
  }, 20_000)

  it('turns printing on while a job prints, and off when it finishes', async () => {
    printer.print()
    await sleep(3500)
    expect(contact().getCharacteristic(run.hap.Characteristic.ContactSensorState).value).toBe(1)
    expect(on('My Printer Printing')).toBe(true)
    expect(on('My Printer Online')).toBe(true)
    expect(find('My Printer').context.timesPrinted).toBeGreaterThanOrEqual(1)

    printer.finish()
    await sleep(3500)
    expect(contact().getCharacteristic(run.hap.Characteristic.ContactSensorState).value).toBe(0)
    expect(on('My Printer Printing')).toBe(false)
  }, 20_000)

  it('keeps the same accessories over a restart, without duplicating anything', async () => {
    const cached = serialise(run.all)
    run.api.signalShutdown()
    await sleep(300)

    run = boot(cfg(printer.address), { cached })
    await sleep(1500)
    expect(run.all).toHaveLength(3)
    expect(run.unregistered).toHaveLength(0)
    expect(inks(find('My Printer'))).toHaveLength(2)
    expect(find('My Printer').services.filter(s => s.UUID === run.hap.Service.ContactSensor.UUID)).toHaveLength(1)
    expect((await asHomeHubSeesIt(run.hap, run.all)).count).toBe(3)
  }, 20_000)

  it('keeps an online switch made by an older version', async () => {
    const legacyUuid = run.hap.uuid.generate('hp-printer:My Printer:online')
    const cached = serialise(run.all).filter(s => s.UUID !== legacyUuid)
    const legacy = new homebridge.PlatformAccessory('My Printer Online', legacyUuid)
    legacy.addService(run.hap.Service.Switch, 'My Printer Online', 'online')
    legacy._associatedPlugin = '@homebridge-plugins/homebridge-printer'
    legacy._associatedPlatform = 'Printer'
    cached.push(...serialise([legacy]))
    run.api.signalShutdown()
    await sleep(300)

    run = boot(cfg(printer.address), { cached })
    await sleep(1500)
    const kept = run.all.find(a => a.UUID === legacyUuid)
    expect(run.unregistered).toHaveLength(0)
    expect(kept.services.filter(s => s.UUID === run.hap.Service.Switch.UUID)).toHaveLength(1)
    expect(on('My Printer Online')).toBe(true)
  }, 20_000)

  it('remembers the ink levels while the printer is off', async () => {
    const cached = serialise(run.all)
    run.api.signalShutdown()
    await sleep(300)

    run = boot(cfg('127.0.0.1:1'), { cached })
    await sleep(1500)
    const status = await (await fetch(`http://127.0.0.1:${DASHBOARD}/api/status`)).json()
    expect(status.printers[0].status).toBe('offline')
    expect(status.printers[0].markers).toHaveLength(2)
    const C = run.hap.Characteristic
    expect(contact().getCharacteristic(C.StatusActive).value).toBe(false)
    expect(contact().getCharacteristic(C.StatusFault).value).toBe(1)
    expect(on('My Printer Printing')).toBe(false)
    expect(on('My Printer Online')).toBe(false)
    expect(run.warnings).toEqual([])
    run.api.signalShutdown()
    await sleep(300)
  }, 20_000)

  it.each([
    [
      { onlineSwitch: false },
      ['Solo', 'Solo Printing'],
    ],
    [
      { printingSwitch: false },
      ['Solo', 'Solo Online'],
    ],
    [
      { onlineSwitch: false, printingSwitch: false },
      ['Solo'],
    ],
    [
      { switchType: 'NONE' },
      ['Solo'],
    ],
    [
      { switchType: 'SWITCH' },
      ['Solo', 'Solo Online', 'Solo Printing'],
    ],
  ])(
    'with %j, shows %j',
    async (options, names) => {
      run = boot({
        platform: 'Printer',
        printers: [
          { name: 'Solo', address: printer.address, ...options },
        ],
        dashboard: { enabled: false },
      })
      expect(run.all.map(a => a.displayName).sort()).toEqual(names)
      run.api.signalShutdown()
      await sleep(200)
    },
    20_000,
  )
})
