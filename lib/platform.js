import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { OnlineSwitchAccessory, PrinterAccessory, PrintingSwitchAccessory } from './accessories.js'
import { createCharacteristics } from './characteristics.js'
import { DashboardServer } from './dashboard-server.js'
import { MatterEnergyPublisher, normaliseEnergyConfig } from './energy.js'
import eveService from './fakegato/fakegato-history.js'
import { PrinterPoller } from './poller.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

const PLUGIN_NAME = '@homebridge-plugins/homebridge-printer'
const PLATFORM_NAME = 'Printer'

class PrinterPlatform {
  constructor(log, config, api) {
    this.log = log
    this.config = config || {}
    this.api = api
    this.version = pkg.version
    this.cached = new Map() // UUID -> PlatformAccessory
    this.handlers = []
    this.pollers = new Map() // printer id -> PrinterPoller
    this.devices = this.normaliseConfig(this.config)
    this.customChars = createCharacteristics(api.hap)
    this.pluginName = PLUGIN_NAME
    this.platformName = PLATFORM_NAME
    this.energy = new MatterEnergyPublisher(this)

    if (this.config.debug) {
      // Show debug output without having to start Homebridge with -D
      this.log = {
        info: (...a) => log.info(...a),
        warn: (...a) => log.warn(...a),
        error: (...a) => log.error(...a),
        success: (...a) => (log.success || log.info)(...a),
        debug: (...a) => log.info('[debug]', ...a),
      }
    }

    api.on('didFinishLaunching', () => this.didFinishLaunching())
    api.on('shutdown', () => this.shutdown())
  }

  normaliseConfig(config) {
    const list = Array.isArray(config.printers)
      ? config.printers
      : Array.isArray(config.printer)
        ? config.printer
        : []
    const seen = new Set()
    const out = []
    list.forEach((p, i) => {
      if (!p || !String(p.address || '').trim()) {
        this.log.warn(`Printer ${i + 1} has no IP address or .local name yet - add one in the plugin settings.`)
        return
      }
      const address = String(p.address).trim()
      // Name is optional: default to "Printer", "Printer 2", ...
      let name = String(p.name || '').trim()
      if (!name) {
        name = 'Printer'
        for (let n = 2; seen.has(name); n++) {
          name = `Printer ${n}`
        }
      }
      if (seen.has(name)) {
        this.log.warn(
          `${name}: two printers have the same name - give one of them a different name. Skipping the second.`,
        )
        return
      }
      seen.add(name)
      // Older configs used one "switchType" setting; NONE / CHARACTERISTIC meant "no switch"
      const legacyType = String(p.switchType || '').toUpperCase()
      const legacyNoSwitch = legacyType === 'NONE' || legacyType === 'CHARACTERISTIC'
      out.push({
        id: this.api.hap.uuid.generate(`hp-printer:${name}`),
        name,
        printingSwitch: typeof p.printingSwitch === 'boolean'
          ? p.printingSwitch
          : !legacyNoSwitch,
        printingName: `${name} Printing`,
        onlineSwitch: typeof p.onlineSwitch === 'boolean'
          ? p.onlineSwitch
          : !legacyNoSwitch,
        onlineName: `${name} Online`,
        onlineCharacteristic: legacyType === 'CHARACTERISTIC',
        energy: normaliseEnergyConfig(p),
        address,
        polling:
          Number.isFinite(Number(p.polling)) && Number(p.polling) > 0
            ? Math.max(2, Math.round(Number(p.polling)))
            : 5,
        marker: p.marker !== false,
        history: p.history !== false,
        lowInkThreshold:
          Number.isFinite(Number(p.lowInkThreshold)) && p.lowInkThreshold !== ''
            ? Math.min(99, Math.max(0, Number(p.lowInkThreshold)))
            : 10,
        manufacturer: p.manufacturer,
        model: p.model,
        serialNumber: p.serialNumber,
      })
    })
    return out
  }

  /** Homebridge 2 calls this for every Matter accessory restored from cache. */
  configureMatterAccessory(accessory) {
    this.energy.configureMatterAccessory(accessory)
  }

  /** Homebridge calls this for every accessory restored from cache. */
  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory)
  }

  getFakeGato() {
    if (this._fakegato !== undefined) {
      return this._fakegato
    }
    try {
      this._fakegato = eveService(this.api)
    } catch (err) {
      this.log.warn(`Eve history unavailable: ${err.message}`)
      this._fakegato = null
    }
    return this._fakegato
  }

  getOrCreate(uuid, name, toRegister) {
    let acc = this.cached.get(uuid)
    if (!acc) {
      acc = new this.api.platformAccessory(name, uuid)
      toRegister.push(acc)
      this.log.info(`Adding accessory: ${name}`)
    }
    acc.context.hpPrinter = true
    return acc
  }

  didFinishLaunching() {
    const wanted = new Set()
    const toRegister = []

    // "Matter only": publish the printer over Matter alone, no HomeKit accessories.
    // Only honoured when Matter is actually available, so nothing disappears by accident.
    const matterReason = this.energy.unavailableReason()
    const matterOnly = this.config.matterOnly === true && !matterReason
    if (this.config.matterOnly === true && matterReason) {
      this.log.warn(
        `"Matter only" is turned on, but ${matterReason}. Keeping the HomeKit accessories until Matter is available.`,
      )
    } else if (matterOnly) {
      this.log.info(
        '"Matter only" is on: the printer is published over Matter only (no HomeKit accessories). Ink levels are shown on the dashboard.',
      )
    }

    for (const device of this.devices) {
      const poller = new PrinterPoller(device, this.log)
      this.pollers.set(device.id, poller)

      if (matterOnly) {
        // No HomeKit accessory to keep the last-known ink levels in, so keep them in a file
        this.seedFromFile(device, poller)
        continue
      }

      // "<name>" accessory: printing sensor, fault/online status and ink tiles
      const statusUuid = device.id
      wanted.add(statusUuid)
      const acc = this.getOrCreate(statusUuid, device.name, toRegister)
      // Seed with the last known state so ink levels survive restarts while the printer is off
      const last = acc.context.lastState
      if (last && Array.isArray(last.markers)) {
        Object.assign(poller.state, {
          markers: last.markers,
          model: device.model || last.model || null,
          lastSeen: last.lastSeen || null,
        })
      }
      poller.on('update', (s) => {
        acc.context.lastState = { markers: s.markers, model: s.model, lastSeen: s.lastSeen }
      })
      this.handlers.push(new PrinterAccessory(this, acc, device, poller))

      // Switch 1: "<name> Online" - on while the printer is switched on and reachable.
      // With Matter, this is one combined "<name> Online" outlet that also carries the
      // energy reading (published by MatterEnergyPublisher), so no separate HomeKit switch.
      device.onlineViaMatter = device.onlineSwitch && device.energy.enabled && !this.energy.unavailableReason()
      if (device.onlineSwitch && !device.onlineViaMatter) {
        const uuid = this.api.hap.uuid.generate(`hp-printer:${device.name}:online`)
        wanted.add(uuid)
        const sw = this.getOrCreate(uuid, device.onlineName, toRegister)
        this.handlers.push(new OnlineSwitchAccessory(this, sw, device, poller))
      }

      // Switch 2: "<name> Printing" - on only while a job is printing
      if (device.printingSwitch) {
        const uuid = this.api.hap.uuid.generate(`hp-printer:${device.name}:printing`)
        wanted.add(uuid)
        const sw = this.getOrCreate(uuid, device.printingName, toRegister)
        this.handlers.push(new PrintingSwitchAccessory(this, sw, device, poller))
      }
    }

    if (toRegister.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister)
    }

    const stale = [
      ...this.cached.values(),
    ].filter(a => !wanted.has(a.UUID))
    if (stale.length) {
      stale.forEach(a => this.log.info(`Removing accessory: ${a.displayName}`))
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale)
    }

    for (const poller of this.pollers.values()) {
      poller.start()
    }

    this.energy.start(this.devices, this.pollers, { matterOnly }).catch(err => this.log.warn(`Matter: ${err.message}`))

    const dash = this.config.dashboard || {}
    if (dash.enabled !== false && this.devices.length) {
      this.dashboard = new DashboardServer({
        port: Number(dash.port) || 8587,
        host: dash.host || '0.0.0.0',
        log: this.log,
        getStatus: () => this.getStatus(),
        onRefresh: () => Promise.all([
          ...this.pollers.values(),
        ].map(p => p.poll())),
      })
      for (const poller of this.pollers.values()) {
        poller.on('update', () => this.dashboard.broadcast())
      }
      this.dashboard.start()
    }

    if (!this.devices.length) {
      this.log.warn(
        'No printers configured yet. Open Plugins → Printer → Settings and enter your printer\'s IP address or .local name.',
      )
    }
  }

  /** Last-known ink levels for Matter-only mode, kept in <storage>/hp-printer/state-<id>.json */
  seedFromFile(device, poller) {
    const file = path.join(this.api.user.storagePath(), 'hp-printer', `state-${device.id}.json`)
    try {
      const last = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (last && Array.isArray(last.markers)) {
        Object.assign(poller.state, {
          markers: last.markers,
          model: device.model || last.model || null,
          lastSeen: last.lastSeen || null,
        })
      }
    } catch (_) {
      /* first run */
    }
    let timer = null
    poller.on('update', (st) => {
      if (timer) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, JSON.stringify({ markers: st.markers, model: st.model, lastSeen: st.lastSeen }))
        } catch (err) {
          this.log.debug(`${device.name}: could not save state (${err.message})`)
        }
      }, 2000)
      if (timer.unref) {
        timer.unref()
      }
    })
  }

  getStatus() {
    return {
      plugin: PLUGIN_NAME,
      version: this.version,
      generated: new Date().toISOString(),
      printers: [
        ...this.pollers.values(),
      ].map((p) => {
        const energy = this.energy.status()[p.state.id]
        return energy
          ? { ...p.state, energy }
          : p.state
      }),
    }
  }

  shutdown() {
    this.energy.shutdown()
    for (const p of this.pollers.values()) {
      p.stop()
    }
    for (const h of this.handlers) {
      h.destroy()
    }
    if (this.dashboard) {
      this.dashboard.stop()
    }
  }
}

export { PLATFORM_NAME, PLUGIN_NAME, PrinterPlatform }
