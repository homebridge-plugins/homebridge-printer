import { EventEmitter } from 'node:events'

import { IppPrinter, PRINTER_STATES } from './ipp.js'

const REQUESTED = [
  'printer-state',
  'printer-state-reasons',
  'printer-state-message',
  'printer-make-and-model',
  'printer-info',
  'printer-is-accepting-jobs',
  'queued-job-count',
  'marker-names',
  'marker-levels',
  'marker-low-levels',
  'marker-high-levels',
  'marker-colors',
  'marker-types',
]

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EBUSY',
  'EPIPE',
])

function arr(v) {
  return v === undefined || v === null
    ? []
    : Array.isArray(v)
      ? v
      : [v]
}

function parseColors(c) {
  // HP tri-color cartridges report e.g. "#00FFFF#FF00FF#FFFF00"
  const m = String(c || '').match(/#[0-9a-f]{6}/gi)
  return m
    ? m.map(x => x.toUpperCase())
    : []
}

function parseMarkers(attrs) {
  const names = arr(attrs['marker-names'])
  const levels = arr(attrs['marker-levels'])
  const lows = arr(attrs['marker-low-levels'])
  const highs = arr(attrs['marker-high-levels'])
  const colors = arr(attrs['marker-colors'])
  const types = arr(attrs['marker-types'])
  const count = Math.max(names.length, levels.length)
  const markers = []
  for (let i = 0; i < count; i++) {
    const raw = typeof levels[i] === 'number'
      ? levels[i]
      : -1
    const high = typeof highs[i] === 'number' && highs[i] > 0
      ? highs[i]
      : 100
    // -1 = unavailable, -2 = unknown, -3 = "some remaining" (RFC 3805 / PWG 5100.13)
    const level = raw >= 0
      ? Math.max(0, Math.min(100, Math.round((raw / high) * 100)))
      : null
    markers.push({
      index: i,
      name: names[i] || `Supply ${i + 1}`,
      level,
      someRemaining: raw === -3,
      low: typeof lows[i] === 'number' && lows[i] >= 0
        ? lows[i]
        : null,
      colors: parseColors(colors[i]),
      type: types[i] || null,
    })
  }
  return markers
}

class PrinterPoller extends EventEmitter {
  constructor(config, log) {
    super()
    this.config = config
    this.log = log
    this.client = new IppPrinter(config.address, {
      timeout: Math.min(15000, Math.max(3000, config.polling * 800)),
    })
    this.timer = null
    this.stopped = false
    this.state = {
      id: config.id,
      name: config.name,
      address: config.address,
      online: false,
      status: 'unknown',
      reasons: [],
      message: null,
      model: config.model || null,
      queuedJobs: 0,
      printing: false,
      markers: [],
      lowThreshold: config.lowInkThreshold,
      lastUpdated: null,
      lastSeen: null,
      error: null,
    }
  }

  start() {
    this.stopped = false
    this.poll()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
  }

  async poll() {
    clearTimeout(this.timer)
    const prev = JSON.stringify(this.state)
    try {
      const a = await this.client.getAttributes(REQUESTED)
      const reasons = arr(a['printer-state-reasons']).filter(r => r && r !== 'none')
      const markers = parseMarkers(a)
      Object.assign(this.state, {
        online: true,
        status: PRINTER_STATES[a['printer-state']] || 'unknown',
        reasons,
        message: a['printer-state-message'] || null,
        model: this.config.model || a['printer-make-and-model'] || this.state.model,
        queuedJobs: typeof a['queued-job-count'] === 'number'
          ? a['queued-job-count']
          : 0,
        // Printing = the printer is busy AND has a job. Printers also report "processing"
        // while warming up or cleaning heads; those have no job, so they don't count.
        printing: a['printer-state'] === 4 && (typeof a['queued-job-count'] !== 'number' || a['queued-job-count'] > 0),
        markers: markers.length ? markers : this.state.markers,
        lastUpdated: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        error: null,
      })
      this.log.debug(`${this.config.name}: ${this.state.status} ${JSON.stringify(markers.map(m => [m.name, m.level]))}`)
    } catch (err) {
      const network = err && NETWORK_CODES.has(err.code)
      if (network) {
        this.log.debug(`${this.config.name}: printer not reachable (${err.code})`)
      } else if (this.state.error !== err.message) {
        this.log.warn(`${this.config.name}: ${err.message}`)
      }
      Object.assign(this.state, {
        online: false,
        status: 'offline',
        printing: false,
        lastUpdated: new Date().toISOString(),
        error: network ? 'Printer not reachable' : err.message,
      })
    }
    if (JSON.stringify(this.state) !== prev) {
      this.emit('update', this.state)
    }
    if (!this.stopped) {
      // Check more often while a job is printing, so the switch turns off promptly when it finishes
      const secs
        = this.state.status === 'processing' || this.state.printing
          ? Math.min(this.config.polling, 2)
          : this.config.polling
      this.timer = setTimeout(() => this.poll(), secs * 1000)
      if (this.timer.unref) {
        this.timer.unref()
      }
    }
  }
}

export { parseMarkers, PrinterPoller, REQUESTED }
