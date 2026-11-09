const NOW_EPOCH_OFFSET = 978307200 // seconds between 1970-01-01 and 2001-01-01 (Eve epoch)

class PrinterAccessory {
  /**
   * @param {import('./platform').PrinterPlatform} platform
   * @param {*} accessory  PlatformAccessory
   * @param {*} device     normalised printer config
   * @param {import('./poller').PrinterPoller} poller
   */
  constructor(platform, accessory, device, poller) {
    this.platform = platform
    this.api = platform.api
    this.log = platform.log
    this.hap = platform.api.hap
    this.C = platform.customChars
    this.accessory = accessory
    this.device = device
    this.poller = poller
    this.history = null

    const { Service, Characteristic } = this.hap

    accessory.on('identify', () => this.log.info(`${accessory.displayName}: identify requested`))

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, device.manufacturer || 'HP')
      .setCharacteristic(Characteristic.Model, device.model || 'Printer')
      .setCharacteristic(Characteristic.SerialNumber, device.serialNumber || device.id.slice(0, 12))
      .setCharacteristic(Characteristic.FirmwareRevision, platform.version)

    // ----- "Printing" contact sensor -------------------------------------------------------
    this.contact
      = accessory.getServiceById(Service.ContactSensor, 'contact')
        || accessory.getService(Service.ContactSensor)
        || accessory.addService(Service.ContactSensor, device.name, 'contact')
    this.ensureName(this.contact, device.name)

    for (const c of [Characteristic.StatusActive, Characteristic.StatusFault]) {
      if (!this.contact.testCharacteristic(c)) {
        this.contact.addCharacteristic(c)
      }
    }

    // Online state as a characteristic (visible in Eve / Controller apps)
    if (device.onlineCharacteristic) {
      if (!this.contact.testCharacteristic(this.C.PrinterOnline)) {
        this.contact.addCharacteristic(this.C.PrinterOnline)
      }
    } else if (this.contact.testCharacteristic(this.C.PrinterOnline)) {
      this.contact.removeCharacteristic(this.contact.getCharacteristic(this.C.PrinterOnline))
    }

    this.setupHistory()

    // ----- Ink / toner levels ----------------------------------------------------------------
    if (!device.marker) {
      this.removeMarkerServices([])
    }

    poller.on('update', state => this.update(state))
  }

  ensureName(service, name) {
    const { Characteristic } = this.hap
    service.setCharacteristic(Characteristic.Name, name)
    // iOS 16+ uses ConfiguredName for service labels inside grouped accessories
    if (Characteristic.ConfiguredName) {
      if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
        service.addCharacteristic(Characteristic.ConfiguredName)
      }
      service.updateCharacteristic(Characteristic.ConfiguredName, name)
    }
  }

  setupHistory() {
    const { Characteristic } = this.hap
    const C = this.C
    const eveChars = [
      C.EveLastActivation,
      C.EveTimesOpened,
      C.EveOpenDuration,
      C.EveClosedDuration,
      C.EveResetTotal,
    ]

    const FakeGato = this.platform.getFakeGato()
    if (!this.device.history || !FakeGato) {
      for (const c of eveChars) {
        if (this.contact.testCharacteristic(c)) {
          this.contact.removeCharacteristic(this.contact.getCharacteristic(c))
        }
      }
      return
    }

    for (const c of eveChars) {
      if (!this.contact.testCharacteristic(c)) {
        this.contact.addCharacteristic(c)
      }
    }
    const ctx = this.accessory.context
    ctx.timesPrinted = ctx.timesPrinted || 0
    this.contact.updateCharacteristic(C.EveTimesOpened, ctx.timesPrinted)

    this.contact.getCharacteristic(C.EveResetTotal).onSet(() => {
      ctx.timesPrinted = 0
      this.contact.updateCharacteristic(C.EveTimesOpened, 0)
      this.contact.updateCharacteristic(C.EveResetTotal, Math.round(Date.now() / 1000) - NOW_EPOCH_OFFSET)
      this.log.info(`${this.accessory.displayName}: Eve history counters reset`)
    })

    try {
      // the org's copy of fakegato, which also re-sends the last state every 10 minutes
      this.history = new FakeGato('door', this.accessory, {
        log: () => {},
      })
    } catch (err) {
      this.log.warn(`${this.accessory.displayName}: Eve history disabled (${err.message})`)
      this.history = null
      return
    }

    this.contact.getCharacteristic(Characteristic.ContactSensorState).on('change', ({ oldValue, newValue }) => {
      if (oldValue === newValue || !this.history) {
        return
      }
      const now = Math.round(Date.now() / 1000)
      const initial = Number(this.history.getInitialTime())
      const since = Number.isFinite(initial) && initial > 0
        ? Math.max(0, now - initial)
        : null
      if (newValue) {
        ctx.timesPrinted += 1
        this.contact.updateCharacteristic(C.EveTimesOpened, ctx.timesPrinted)
        if (since !== null) {
          this.contact.updateCharacteristic(C.EveLastActivation, since)
        }
      }
      this.history.addEntry({
        time: now,
        status: newValue ? 1 : 0,
      })
    })
  }

  removeMarkerServices(keepSubtypes) {
    const { Service } = this.hap
    const stale = this.accessory.services.filter(
      s => s.UUID === Service.FilterMaintenance.UUID && !keepSubtypes.includes(s.subtype),
    )
    for (const s of stale) {
      this.log.info(`${this.accessory.displayName}: removing ink service "${s.displayName}"`)
      this.accessory.removeService(s)
    }
    return stale.length > 0
  }

  syncMarkerServices(markers) {
    const { Service, Characteristic } = this.hap
    let changed = false
    const wanted = markers.map(m => `marker-${m.index}`)
    changed = this.removeMarkerServices(wanted) || changed

    for (const m of markers) {
      const subtype = `marker-${m.index}`
      let svc = this.accessory.getServiceById(Service.FilterMaintenance, subtype)
      if (!svc) {
        this.log.info(`${this.accessory.displayName}: adding ink service "${m.name}"`)
        svc = this.accessory.addService(Service.FilterMaintenance, m.name, subtype)
        changed = true
      }
      if (!svc.testCharacteristic(Characteristic.FilterLifeLevel)) {
        svc.addCharacteristic(Characteristic.FilterLifeLevel)
      }
      if (svc.displayName !== m.name || !svc._hpNamed) {
        this.ensureName(svc, m.name)
        svc._hpNamed = true
      }

      const level = m.level !== null
        ? m.level
        : m.someRemaining ? 50 : 0
      const threshold
        = m.low !== null && m.low > 0
          ? Math.max(m.low, this.device.lowInkThreshold)
          : this.device.lowInkThreshold
      const low = m.level !== null && m.level <= threshold
      svc.updateCharacteristic(Characteristic.FilterLifeLevel, level)
      svc.updateCharacteristic(
        Characteristic.FilterChangeIndication,
        low ? Characteristic.FilterChangeIndication.CHANGE_FILTER : Characteristic.FilterChangeIndication.FILTER_OK,
      )
    }
    if (changed) {
      this.api.updatePlatformAccessories([this.accessory])
    }
  }

  update(state) {
    const { Characteristic } = this.hap
    const printing = state.printing
    const fault = !state.online || state.status === 'stopped' || state.reasons.some(r => r.endsWith('-error'))

    this.contact.updateCharacteristic(
      Characteristic.ContactSensorState,
      printing
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_DETECTED,
    )
    this.contact.updateCharacteristic(Characteristic.StatusActive, state.online)
    this.contact.updateCharacteristic(
      Characteristic.StatusFault,
      fault ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT,
    )
    if (this.device.onlineCharacteristic) {
      this.contact.updateCharacteristic(this.C.PrinterOnline, state.online)
    }

    if (this.device.marker && state.markers.length) {
      this.syncMarkerServices(state.markers)
    }
  }

  destroy() {
    clearInterval(this.historyTimer)
  }
}

/**
 * "Printer Printing" switch: ON only while the printer is printing a job, OFF otherwise
 * (idle, asleep or switched off). It reports state only - tapping it in the
 * Home app snaps back to the real value, because a printer can't be started
 * or stopped over the network.
 */
class PrintingSwitchAccessory {
  constructor(platform, accessory, device, poller) {
    const { Service, Characteristic } = platform.api.hap
    this.accessory = accessory

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, device.manufacturer || 'HP')
      .setCharacteristic(Characteristic.Model, device.model || 'Printer')
      .setCharacteristic(Characteristic.SerialNumber, `${device.serialNumber || device.id.slice(0, 12)}-P`)
      .setCharacteristic(Characteristic.FirmwareRevision, platform.version)

    const name = device.printingName
    this.service
      = accessory.getServiceById(Service.Switch, 'printing') || accessory.addService(Service.Switch, name, 'printing')
    this.service.setCharacteristic(Characteristic.Name, name)
    if (Characteristic.ConfiguredName) {
      if (!this.service.testCharacteristic(Characteristic.ConfiguredName)) {
        this.service.addCharacteristic(Characteristic.ConfiguredName)
      }
      this.service.updateCharacteristic(Characteristic.ConfiguredName, name)
    }

    const isPrinting = state => !!state.printing
    const on = this.service.getCharacteristic(Characteristic.On)
    on.onGet(() => isPrinting(poller.state))
    on.onSet(() => {
      setTimeout(() => on.updateValue(isPrinting(poller.state)), 300)
    })

    let last = null
    poller.on('update', (state) => {
      const now = isPrinting(state)
      if (now !== last) {
        if (last !== null) {
          platform.log.info(`${name}: ${now ? 'printing started' : 'printing finished'}`)
        }
        last = now
      }
      on.updateValue(now)
    })
  }

  destroy() {}
}

/**
 * "Printer Online" switch: ON while the printer is switched on and answering on the
 * network, OFF when it is off, asleep or disconnected. Reports state only.
 */
class OnlineSwitchAccessory {
  constructor(platform, accessory, device, poller) {
    const { Service, Characteristic } = platform.api.hap
    this.accessory = accessory

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, device.manufacturer || 'HP')
      .setCharacteristic(Characteristic.Model, device.model || 'Printer')
      .setCharacteristic(Characteristic.SerialNumber, `${device.serialNumber || device.id.slice(0, 12)}-S`)
      .setCharacteristic(Characteristic.FirmwareRevision, platform.version)

    const name = device.onlineName
    this.service
      = accessory.getServiceById(Service.Switch, 'online')
        || accessory.getService(Service.Switch)
        || accessory.addService(Service.Switch, name, 'online')
    this.service.setCharacteristic(Characteristic.Name, name)
    if (Characteristic.ConfiguredName) {
      if (!this.service.testCharacteristic(Characteristic.ConfiguredName)) {
        this.service.addCharacteristic(Characteristic.ConfiguredName)
      }
      this.service.updateCharacteristic(Characteristic.ConfiguredName, name)
    }

    const on = this.service.getCharacteristic(Characteristic.On)
    on.onGet(() => !!poller.state.online)
    on.onSet(() => {
      setTimeout(() => on.updateValue(!!poller.state.online), 300)
    })

    let last = null
    poller.on('update', (state) => {
      const now = !!state.online
      if (now !== last) {
        if (last !== null) {
          platform.log.info(`${name}: printer is ${now ? 'on' : 'off / unreachable'}`)
        }
        last = now
      }
      on.updateValue(now)
    })
  }

  destroy() {}
}

export { OnlineSwitchAccessory, PrinterAccessory, PrintingSwitchAccessory }
