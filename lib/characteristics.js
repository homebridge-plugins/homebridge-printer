/**
 * Custom / Eve characteristics written as ES classes.
 *
 * The original plugin used `Characteristic.call(this, ...)` + util.inherits and
 * `Characteristic.Formats/Perms/Units`. HAP-NodeJS 1.x (Homebridge 2) turned
 * Characteristic/Service into real classes (so `.call` throws
 * "Class constructor ... cannot be invoked without 'new'") and removed the
 * static Formats/Perms/Units aliases. Everything here uses `class extends`
 * and `hap.Formats/Perms/Units`, which work on Homebridge 1.6+ and 2.x.
 */

const DEFS = [
  // name, displayName, UUID, format, unit, perms
  [
    'PrinterOnline',
    'Printer Online',
    '65ede48d-5d4e-4408-8a6f-feaa57b7320e',
    'BOOL',
    null,
    ['PAIRED_READ', 'NOTIFY'],
  ],
  [
    'EveResetTotal',
    'Reset Total',
    'E863F112-079E-48FF-8F27-9C2605A29F52',
    'UINT32',
    'SECONDS',
    ['PAIRED_READ', 'NOTIFY', 'PAIRED_WRITE'],
  ],
  [
    'EveLastActivation',
    'Last Activation',
    'E863F11A-079E-48FF-8F27-9C2605A29F52',
    'UINT32',
    'SECONDS',
    ['PAIRED_READ', 'NOTIFY'],
  ],
  [
    'EveTimesOpened',
    'Times Opened',
    'E863F129-079E-48FF-8F27-9C2605A29F52',
    'UINT32',
    null,
    ['PAIRED_READ', 'NOTIFY'],
  ],
  [
    'EveOpenDuration',
    'Open Duration',
    'E863F118-079E-48FF-8F27-9C2605A29F52',
    'UINT32',
    'SECONDS',
    ['PAIRED_READ', 'NOTIFY', 'PAIRED_WRITE'],
  ],
  [
    'EveClosedDuration',
    'Closed Duration',
    'E863F119-079E-48FF-8F27-9C2605A29F52',
    'UINT32',
    'SECONDS',
    ['PAIRED_READ', 'NOTIFY', 'PAIRED_WRITE'],
  ],
]

let cache = null

function createCharacteristics(hap) {
  if (cache) {
    return cache
  }
  const { Characteristic, Formats, Perms, Units } = hap
  cache = {}

  for (const [key, displayName, uuid, format, unit, perms] of DEFS) {
    const props = {
      format: Formats[format],
      perms: perms.map(p => Perms[p]),
    }
    if (unit) {
      props.unit = Units[unit]
    }

    const Klass = class extends Characteristic {
      constructor() {
        super(displayName, uuid, props)
        this.value = this.getDefaultValue()
      }
    }
    Object.defineProperty(Klass, 'name', { value: key })
    Klass.UUID = uuid
    cache[key] = Klass
  }
  return cache
}

export { createCharacteristics }
