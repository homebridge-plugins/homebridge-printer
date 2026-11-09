import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { attr } from '../test/fake-ipp-printer.js'
import { buildGetPrinterAttributes, normaliseAddress, parseResponse } from './ipp.js'
import { parseMarkers } from './poller.js'

describe('the printer address', () => {
  it('handles bare hosts, ipp, ipps and http addresses', () => {
    expect(normaliseAddress('192.168.1.20')).toEqual({ host: '192.168.1.20', port: 631, secure: false, explicitPath: null })
    expect(normaliseAddress('ipps://hp.local/ipp/print')).toEqual({ host: 'hp.local', port: 631, secure: true, explicitPath: '/ipp/print' })
    expect(normaliseAddress('http://HPF92BAB4321AB:631/ipp/printer')).toEqual({
      host: 'hpf92bab4321ab',
      port: 631,
      secure: false,
      explicitPath: '/ipp/printer',
    })
  })
})

describe('an ipp request', () => {
  it('is a well formed get-printer-attributes', () => {
    const buf = buildGetPrinterAttributes('ipp://h:631/ipp/print', ['printer-state', 'marker-levels'])
    expect(buf[0]).toBe(2)
    expect(buf.readUInt16BE(2)).toBe(0x000B)
    expect(buf.includes(Buffer.from('requested-attributes'))).toBe(true)
    expect(buf.at(-1)).toBe(0x03)
  })
})

describe('an ipp response', () => {
  it('reads several values, enums, missing values and skips collections', () => {
    const resp = Buffer.concat([
      Buffer.from([2, 0, 0, 0, 0, 0, 0, 1, 0x01]),
      attr(0x47, 'attributes-charset', 'utf-8'),
      Buffer.from([0x04]),
      attr(0x23, 'printer-state', 4),
      attr(0x44, 'printer-state-reasons', 'marker-supply-low-warning'),
      attr(0x42, 'marker-names', 'Tri-color'),
      attr(0x42, '', 'Black'),
      attr(0x21, 'marker-levels', 60),
      attr(0x21, '', 8),
      attr(0x13, 'printer-state-message', ''),
      attr(0x34, 'media-col-ready', ''),
      attr(0x4A, '', 'media-size'),
      attr(0x21, '', 2100),
      attr(0x37, '', ''),
      attr(0x41, 'marker-colors', '#00FFFF#FF00FF#FFFF00'),
      attr(0x41, '', '#000000'),
      Buffer.from([0x03]),
    ])
    const r = parseResponse(resp)
    expect(r.statusCode).toBe(0)
    const p = r.groups.printer
    expect(p['printer-state']).toBe(4)
    expect(p['marker-names']).toEqual(['Tri-color', 'Black'])
    expect(p['marker-levels']).toEqual([60, 8])
    expect(p['printer-state-message']).toBeNull()
    expect(p['media-col-ready']).toBeUndefined()

    const m = parseMarkers(p)
    expect(m[0].colors).toEqual(['#00FFFF', '#FF00FF', '#FFFF00'])
    expect(m[1].level).toBe(8)
  })
})
