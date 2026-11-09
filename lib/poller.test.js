import { describe, expect, it } from 'vitest'

import { parseMarkers, PrinterPoller } from './poller.js'

const quiet = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}

function poller() {
  const p = new PrinterPoller(
    {
      name: 't',
      address: '127.0.0.1',
      polling: 5,
      lowInkThreshold: 10,
    },
    quiet,
  )
  p.stopped = true
  return p
}

async function printing(attrs) {
  const p = poller()
  p.client.getAttributes = async () => attrs
  await p.poll()
  return p.state.printing
}

describe('ink levels', () => {
  it('reads unknown levels as none, -3 as some left, and scales by the full level', () => {
    const m = parseMarkers({
      'marker-names': ['A', 'B', 'C'],
      'marker-levels': [-2, -3, 50],
      'marker-high-levels': [100, 100, 200],
    })
    expect(m[0].level).toBeNull()
    expect(m[1].someRemaining).toBe(true)
    expect(m[2].level).toBe(25)
  })
})

describe('printing', () => {
  it('is on only while the printer is busy with a job', async () => {
    expect(await printing({ 'printer-state': 4, 'queued-job-count': 1 })).toBe(true)
    expect(await printing({ 'printer-state': 4, 'queued-job-count': 0 })).toBe(false)
    expect(await printing({ 'printer-state': 4 })).toBe(true)
    expect(await printing({ 'printer-state': 3, 'queued-job-count': 0 })).toBe(false)
  })

  it('is off while the printer cannot be reached', async () => {
    const p = poller()
    p.client.getAttributes = async () => {
      throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' })
    }
    await p.poll()
    expect(p.state.printing).toBe(false)
    expect(p.state.online).toBe(false)
  })
})
