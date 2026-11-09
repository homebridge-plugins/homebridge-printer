/**
 * Estimated energy use for a printer, published to Apple Home through Homebridge's
 * Matter bridge (Homebridge 2.3+, iOS 27+ Home app "Electricity" view).
 *
 * Printers don't report how much power they draw, only what they are doing, so
 * the power is ESTIMATED from the printer's state using per-state wattages (HP's
 * published figures for the DeskJet 2800 series by default), and the running
 * total is the integral of that estimate over time.
 */

import fs from 'node:fs'
import path from 'node:path'

const MIN_HB = '2.3.0'
const POWER_UPDATE_MS = 10 * 1000 // matter.js throttles power reports to ~10 s anyway
const ENERGY_UPDATE_MS = 60 * 1000 // energy events are not throttled: update once a minute
const SAVE_MS = 60 * 1000
const PART_ID = 'outlet'

/** Defaults: HP DeskJet 2800e series data sheet (ready 2.8 W, sleep 1.4 W, off 0.3 W). Printing isn't published. */
const DEFAULT_WATTS = {
  printing: 10,
  ready: 2.8,
  sleep: 1.4,
  off: 0.3,
}

function num(v, d) {
  return v === '' || v === null || v === undefined || !Number.isFinite(Number(v))
    ? d
    : Math.max(0, Number(v))
}

function normaliseEnergyConfig(p) {
  const e = (p && typeof p.energy === 'object' && p.energy) || {}
  return {
    enabled: e.enabled !== false,
    watts: {
      printing: num(e.printingWatts, DEFAULT_WATTS.printing),
      ready: num(e.readyWatts, DEFAULT_WATTS.ready),
      sleep: num(e.sleepWatts, DEFAULT_WATTS.sleep),
      off: num(e.offWatts, DEFAULT_WATTS.off),
    },
    sleepAfterMinutes: num(e.sleepAfterMinutes, 5),
  }
}

/** Which power state the printer is in, from what IPP tells us. */
function powerState(state, idleSince, now, sleepAfterMinutes) {
  if (!state || !state.online) {
    return 'off'
  } // switched off, deep sleep off the network, or unreachable
  if (state.printing || state.status === 'processing') {
    return 'printing'
  }
  const reasons = (state.reasons || []).join(' ')
  if (/sleep|power-sav|standby/i.test(reasons)) {
    return 'sleep'
  }
  if (idleSince && now - idleSince >= sleepAfterMinutes * 60 * 1000) {
    return 'sleep'
  }
  return 'ready'
}

class EnergyMeter {
  /**
   * @param {{ id: string, watts: object, sleepAfterMinutes: number, file: string, log: object, name: string }} opts
   */
  constructor(opts) {
    this.opts = opts
    this.watts = opts.watts
    this.totalMWh = 0 // milliwatt-hours, Matter's unit
    this.since = Date.now() // when the running total started
    this.lastTick = null
    this.stateName = 'off'
    this.idleSince = null
    this.load()
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.opts.file, 'utf8'))
      if (Number.isFinite(saved.totalMWh) && saved.totalMWh >= 0) {
        this.totalMWh = saved.totalMWh
      }
      if (Number.isFinite(saved.since)) {
        this.since = saved.since
      }
    } catch (_) {
      /* first run */
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true })
      const tmp = `${this.opts.file}.tmp`
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          totalMWh: Math.round(this.totalMWh),
          since: this.since,
          savedAt: Date.now(),
        }),
      )
      fs.renameSync(tmp, this.opts.file)
    } catch (err) {
      this.opts.log.debug(`${this.opts.name}: could not save energy total (${err.message})`)
    }
  }

  get currentWatts() {
    return this.watts[this.stateName] || 0
  }

  /** Add the energy used since the last tick at the current wattage, then switch to the new state. */
  tick(state, now = Date.now()) {
    if (this.lastTick !== null && now > this.lastTick) {
      // Cap one gap at 10 minutes so a suspended/asleep host doesn't add a huge block at once
      const ms = Math.min(now - this.lastTick, 10 * 60 * 1000)
      this.totalMWh += (this.currentWatts * 1000 * ms) / 3600000
    }
    this.lastTick = now

    if (state) {
      const idle = state.online && !state.printing && state.status !== 'processing'
      if (!idle) {
        this.idleSince = null
      } else if (this.idleSince === null) {
        this.idleSince = now
      }
      this.stateName = powerState(state, this.idleSince, now, this.opts.sleepAfterMinutes)
    }
    return this.snapshot()
  }

  snapshot() {
    return {
      state: this.stateName,
      watts: this.currentWatts,
      kWh: Math.round(this.totalMWh) / 1e6,
      since: new Date(this.since).toISOString(),
      estimated: true,
    }
  }
}

/**
 * Publishes one Matter "outlet" per printer, carrying the estimated power and energy.
 * Apple Home shows watts on outlet tiles and adds bridged devices to the home's total.
 */
class MatterEnergyPublisher {
  constructor(platform) {
    this.platform = platform
    this.api = platform.api
    this.log = platform.log
    this.cached = new Map() // UUID -> cached Matter accessory
    this.entries = [] // { device, poller, meter, uuid }
    this.timers = []
  }

  /** Why energy can't be published here, or null if it can. */
  unavailableReason() {
    if (!this.api.versionGreaterOrEqual || !this.api.versionGreaterOrEqual(MIN_HB)) {
      return `needs Homebridge ${MIN_HB} or newer (this is ${this.api.serverVersion})`
    }
    const enabled = typeof this.api.isMatterEnabled === 'function'
      ? this.api.isMatterEnabled()
      : false
    if (!enabled || !this.api.matter) {
      return 'Matter is not turned on for the bridge this plugin runs on. In the Homebridge UI open Settings → Matter Settings, turn Matter on for the main bridge and restart, then add the Matter QR code from the Status page in the Home app (or, if this plugin runs as a child bridge, turn Matter on in its Child Bridge Config)'
    }
    return null
  }

  configureMatterAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory)
  }

  energyFile(device) {
    return path.join(this.api.user.storagePath(), 'hp-printer', `energy-${device.id}.json`)
  }

  /**
   * @param {object[]} devices
   * @param {Map} pollers
   * @param {{ matterOnly?: boolean }} [opts] matterOnly: also publish Printing over Matter, and Online
   *        even with energy turned off, because no HomeKit accessories are published.
   */
  async start(devices, pollers, opts = {}) {
    const matterOnly = !!opts.matterOnly
    const withEnergy = devices.filter(d => d.energy && d.energy.enabled)
    const wantsMatter = devices.some(
      d => (d.energy && d.energy.enabled) || (matterOnly && (d.onlineSwitch || d.printingSwitch)),
    )
    if (!wantsMatter) {
      return
    }
    // The estimate always runs (it is shown on the dashboard); Apple Home needs Matter.
    const reason = this.unavailableReason()
    if (reason && withEnergy.length) {
      this.log.info(`Energy in Apple Home is off: ${reason}. The estimate is still shown on the dashboard.`)
    }

    const matter = this.api.matter
    const uuidGen = matter ? matter.uuid : this.api.hap.uuid
    const toRegister = []
    for (const device of devices) {
      const poller = pollers.get(device.id)
      const energyOn = device.energy && device.energy.enabled

      // Switch 1: "<name> Online" outlet (carries the energy reading when energy is on)
      if (energyOn || (matterOnly && device.onlineSwitch)) {
        const meter = energyOn
          ? new EnergyMeter({
              id: device.id,
              name: device.name,
              watts: device.energy.watts,
              sleepAfterMinutes: device.energy.sleepAfterMinutes,
              file: this.energyFile(device),
              log: this.log,
            })
          : null
        const entry = {
          kind: 'online',
          device,
          poller,
          meter,
          uuid: uuidGen.generate(`hp-printer:${device.name}:outlet-v2`),
          lastPower: null,
          lastOn: null,
        }
        this.entries.push(entry)
        if (meter) {
          meter.tick(poller.state)
        }
        poller.on('update', state => this.pushPower(entry, meter
          ? meter.tick(state)
          : null))
        const name = (
          device.onlineSwitch
            ? device.onlineName || `${device.name} Online`
            : `${device.name} Energy`
        ).slice(0, 32)
        if (!reason) {
          toRegister.push(this.outletAccessory(entry, name, '-E'))
        }
      }

      // Switch 2: "<name> Printing" outlet, Matter-only mode
      if (matterOnly && device.printingSwitch) {
        const entry = {
          kind: 'printing',
          device,
          poller,
          meter: null,
          uuid: uuidGen.generate(`hp-printer:${device.name}:printing-v2`),
          lastPower: null,
          lastOn: null,
        }
        this.entries.push(entry)
        poller.on('update', () => this.pushPower(entry, null))
        if (!reason) {
          toRegister.push(
            this.outletAccessory(entry, (device.printingName || `${device.name} Printing`).slice(0, 32), '-P'),
          )
        }
      }
    }

    const metered = () => this.entries.filter(e => e.meter)
    const tickAll = () => metered().forEach(e => this.pushPower(e, e.meter.tick(e.poller.state)))
    const energyAll = () => metered().forEach(e => this.pushEnergy(e))
    const saveAll = () => metered().forEach(e => e.meter.save())
    this.timers.push(
      setInterval(tickAll, POWER_UPDATE_MS),
      setInterval(energyAll, ENERGY_UPDATE_MS),
      setInterval(saveAll, SAVE_MS),
    )
    this.timers.forEach(t => t.unref && t.unref())
    if (reason) {
      return
    }

    await this.register(toRegister)
    // Remove Matter accessories for printers that were removed or had a switch/energy turned off
    await this.removeStale(new Set(this.entries.map(e => e.uuid)))
  }

  /** Removes cached Matter accessories that are no longer wanted. */
  async removeStale(keep) {
    const stale = [
      ...this.cached.values(),
    ].filter(a => !keep.has(a.UUID))
    if (!stale.length || !this.api.matter) {
      return
    }
    try {
      await this.api.matter.unregisterPlatformAccessories(this.platform.pluginName, this.platform.platformName, stale)
      stale.forEach(a => this.log.info(`Removed Matter accessory: ${a.displayName}`))
    } catch (err) {
      this.log.warn(`Could not remove old Matter accessories: ${err.message}`)
    }
  }

  /** The value an entry's outlet shows: printer reachable (Online) or printing (Printing). */
  isOn(entry) {
    return entry.kind === 'printing'
      ? !!entry.poller.state.printing
      : !!entry.poller.state.online
  }

  /**
   * Composed shape, like certified Matter plugs and the Shelly plugin: a BridgedNode parent with
   * the outlet as its part. Apple Home shows live watts on the tile with this shape; a flat
   * bridged outlet only showed them in the accessory's details.
   */
  outletAccessory(entry, name, serialSuffix) {
    const matter = this.api.matter
    const { device, poller, meter } = entry
    const cached = this.cached.get(entry.uuid)
    const clusters = {
      onOff: {
        onOff: this.isOn(entry),
      },
    }
    if (meter) {
      clusters.electricalPowerMeasurement = {
        activePower: Math.round(meter.currentWatts * 1000),
      }
      clusters.electricalEnergyMeasurement = {
        cumulativeEnergyImported: {
          energy: Math.round(meter.totalMWh),
          startTimestamp: Math.floor(meter.since / 1000),
        },
      }
    }
    return {
      UUID: entry.uuid,
      displayName: name,
      deviceType: matter.deviceTypes.BridgedNode,
      manufacturer: String(device.manufacturer || 'HP').slice(0, 32),
      model: String(device.model || poller.state.model || 'Printer')
        .replace(/^HP\s+/i, '')
        .slice(0, 32),
      serialNumber: `${String(device.serialNumber || device.id.replace(/-/g, '').slice(0, 12)).slice(0, 29)}${serialSuffix}`,
      firmwareRevision: this.platform.version,
      context: (cached && cached.context) || {},
      parts: [
        {
          id: PART_ID,
          displayName: name,
          deviceType: matter.deviceTypes.OnOffOutlet,
          clusters,
          // Status only: a printer can't be switched or started over the network,
          // so a tap in Home is undone a moment later.
          handlers: {
            onOff: {
              on: async () => this.snapBack(entry),
              off: async () => this.snapBack(entry),
            },
          },
        },
      ],
    }
  }

  async register(accessories, attempt = 1) {
    try {
      await this.api.matter.registerPlatformAccessories(
        this.platform.pluginName,
        this.platform.platformName,
        accessories,
      )
      this.registered = true
      // Readings that arrived while registration was pending were never sent: send the current ones now
      for (const e of this.entries) {
        e.lastPower = null
        e.lastOn = null
        this.pushPower(e, e.meter
          ? e.meter.snapshot()
          : null)
        if (e.meter) {
          this.pushEnergy(e)
        }
      }
      accessories.forEach(a =>
        this.log.info(
          `Matter: "${a.displayName}" is published${
            this.entries.some(e => e.uuid === a.UUID && e.meter)
              ? ' with energy'
              : ''
          }.`,
        ),
      )
    } catch (err) {
      // Thrown while the bridge's Matter server is still starting: try again shortly
      if (attempt < 6) {
        this.log.debug(`Matter not ready yet (${err.message}); retrying in 10 s`)
        const t = setTimeout(() => this.register(accessories, attempt + 1), 10000)
        if (t.unref) {
          t.unref()
        }
      } else {
        this.log.warn(`Could not publish energy over Matter: ${err.message}. Restart Homebridge to try again.`)
      }
    }
  }

  async update(entry, cluster, attributes) {
    if (!this.registered) {
      return
    }
    try {
      await this.api.matter.updateAccessoryState(entry.uuid, cluster, attributes, PART_ID)
    } catch (err) {
      this.log.debug(`${entry.device.name}: energy update failed (${err.message})`)
    }
  }

  pushPower(entry, snap) {
    if (snap) {
      const mW = Math.round(snap.watts * 1000)
      if (mW !== entry.lastPower) {
        entry.lastPower = mW
        this.update(entry, 'electricalPowerMeasurement', { activePower: mW })
      }
    }
    const on = this.isOn(entry)
    if (on !== entry.lastOn) {
      entry.lastOn = on
      this.update(entry, 'onOff', { onOff: on })
    }
  }

  pushEnergy(entry) {
    this.update(entry, 'electricalEnergyMeasurement', {
      cumulativeEnergyImported: {
        energy: Math.round(entry.meter.totalMWh),
        startTimestamp: Math.floor(entry.meter.since / 1000),
        endTimestamp: Math.floor(Date.now() / 1000),
      },
    })
  }

  snapBack(entry) {
    // Handlers must not update state themselves; put the real value back just after.
    const t = setTimeout(() => {
      entry.lastOn = null
      this.pushPower(entry, entry.meter
        ? entry.meter.snapshot()
        : null)
    }, 800)
    if (t.unref) {
      t.unref()
    }
  }

  /** For the dashboard: id -> estimate */
  status() {
    const out = {}
    for (const e of this.entries) {
      if (e.meter) {
        out[e.device.id] = e.meter.snapshot()
      }
    }
    return out
  }

  shutdown() {
    this.timers.forEach(t => clearInterval(t))
    this.entries
      .filter(e => e.meter)
      .forEach((e) => {
        e.meter.tick(null)
        e.meter.save()
      })
  }
}

export { DEFAULT_WATTS, EnergyMeter, MatterEnergyPublisher, MIN_HB, normaliseEnergyConfig, powerState }
