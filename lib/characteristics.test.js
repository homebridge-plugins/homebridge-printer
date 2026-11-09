import { describe, expect, it } from 'vitest'

import { createCharacteristics } from './characteristics.js'

describe('the eve characteristics', () => {
  it('are real classes, as homebridge 2 needs', () => {
    class Characteristic {
      constructor(name, uuid, props) {
        Object.assign(this, { name, uuid, props })
      }

      getDefaultValue() {
        return 0
      }
    }
    const hap = {
      Characteristic,
      Formats: { BOOL: 'bool', UINT32: 'uint32' },
      Perms: { PAIRED_READ: 'pr', PAIRED_WRITE: 'pw', NOTIFY: 'ev' },
      Units: { SECONDS: 'seconds' },
    }
    const C = createCharacteristics(hap)
    const c = new C.EveTimesOpened()
    expect(c).toBeInstanceOf(Characteristic)
    expect(C.EveTimesOpened.UUID).toBe('E863F129-079E-48FF-8F27-9C2605A29F52')
    expect(c.props.format).toBe('uint32')
  })
})
