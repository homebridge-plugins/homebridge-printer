import { describe, expect, it } from 'vitest'

import { assemble, TYPE } from './discovery.js'

describe('finding printers on the network', () => {
  it('puts an hp printer together from its bonjour records', () => {
    const inst = 'HP DeskJet 2800e series [7A1B2C]._ipp._tcp.local'
    const [p] = assemble([
      { name: '_ipp._tcp.local', type: TYPE.PTR, data: inst },
      {
        name: inst.toLowerCase(),
        type: TYPE.SRV,
        data: { port: 631, target: 'hp7a1b2c.local' },
      },
      {
        name: inst.toLowerCase(),
        type: TYPE.TXT,
        data: { ty: 'HP DeskJet 2800e series', rp: 'ipp/print' },
      },
      { name: 'hp7a1b2c.local', type: TYPE.A, data: '192.168.1.40' },
    ])
    expect(p.address).toBe('ipp://192.168.1.40/ipp/print')
    expect(p.manufacturer).toBe('HP')
    expect(p.model).toBe('HP DeskJet 2800e series')
  })
})
