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

describe('polling', () => {
  it('keeps to one timer when a refresh runs during a poll', async () => {
    const p = new PrinterPoller({
      name: 't',
      address: '127.0.0.1',
      polling: 60,
      lowInkThreshold: 10,
    }, quiet)
    p.client.getAttributes = () => new Promise(resolve => setTimeout(resolve, 20, { 'printer-state': 3 }))
    const live = new Set()
    const realSet = globalThis.setTimeout
    const realClear = globalThis.clearTimeout
    globalThis.setTimeout = (fn, ms) => {
      const t = realSet(fn, ms)
      if (ms === 60_000) {
        live.add(t)
      }
      return t
    }
    globalThis.clearTimeout = (t) => {
      live.delete(t)
      realClear(t)
    }
    try {
      await Promise.all([
        p.poll(),
        p.poll(),
      ])
      expect(live.size).toBe(1)
    } finally {
      p.stop()
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    }
  })

  it('carries on when something listening to an update fails', async () => {
    const p = poller()
    p.client.getAttributes = async () => ({ 'printer-state': 3 })
    p.on('update', () => {
      throw new Error('could not draw the dashboard')
    })
    await expect(p.poll()).resolves.toBeUndefined()
  })
})
