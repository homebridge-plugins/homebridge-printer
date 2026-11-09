/**
 * A pretend IPP printer for the tests. It answers Get-Printer-Attributes the way an
 * HP DeskJet does, with a tri-colour and a black cartridge. Change `printer.state`
 * to make it print, stop, or report other ink levels.
 */
import { Buffer } from 'node:buffer'
import http from 'node:http'

/** One IPP attribute: tag, name, value. A name of '' adds another value to the one before. */
function attr(tag, name, value) {
  const n = Buffer.from(name)
  const v = typeof value === 'number'
    ? Buffer.alloc(4)
    : Buffer.from(value)
  if (typeof value === 'number') {
    v.writeInt32BE(value)
  }
  const b = Buffer.alloc(5 + n.length + v.length)
  b.writeUInt8(tag, 0)
  b.writeUInt16BE(n.length, 1)
  n.copy(b, 3)
  b.writeUInt16BE(v.length, 3 + n.length)
  v.copy(b, 5 + n.length)
  return b
}

function multi(tag, name, values) {
  return values.map((v, i) => attr(tag, i ? '' : name, v))
}

function response(requestId, s) {
  const header = Buffer.alloc(8)
  header.writeUInt8(2, 0)
  header.writeUInt16BE(0, 2)
  header.writeInt32BE(requestId, 4)
  return Buffer.concat([
    header,
    Buffer.from([0x01]),
    attr(0x47, 'attributes-charset', 'utf-8'),
    attr(0x48, 'attributes-natural-language', 'en'),
    Buffer.from([0x04]),
    attr(0x23, 'printer-state', s.state),
    ...multi(0x44, 'printer-state-reasons', s.reasons.length
      ? s.reasons
      : ['none']),
    attr(0x41, 'printer-make-and-model', s.model),
    attr(0x21, 'queued-job-count', s.jobs),
    ...multi(
      0x42,
      'marker-names',
      s.markers.map(m => m.name),
    ),
    ...multi(
      0x21,
      'marker-levels',
      s.markers.map(m => m.level),
    ),
    ...multi(
      0x21,
      'marker-low-levels',
      s.markers.map(() => 10),
    ),
    ...multi(
      0x21,
      'marker-high-levels',
      s.markers.map(() => 100),
    ),
    ...multi(
      0x42,
      'marker-colors',
      s.markers.map(m => m.color),
    ),
    ...multi(
      0x44,
      'marker-types',
      s.markers.map(() => 'ink-cartridge'),
    ),
    Buffer.from([0x03]),
  ])
}

export function createPrinter() {
  const printer = {
    state: {
      state: 3,
      jobs: 0,
      reasons: [],
      model: 'HP DeskJet 2800e series',
      markers: [
        { name: 'Tri-color Cartridge', level: 60, color: '#00FFFF#FF00FF#FFFF00' },
        { name: 'Black Cartridge', level: 8, color: '#000000' },
      ],
    },
    requests: 0,
    /** Starts a job, as if someone printed. */
    print() {
      Object.assign(printer.state, { state: 4, jobs: 1 })
    },
    /** The job has finished. */
    finish() {
      Object.assign(printer.state, { state: 3, jobs: 0 })
    },
  }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      printer.requests++
      const body = Buffer.concat(chunks)
      if (req.url !== '/ipp/print' || body.length < 8) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/ipp' })
      res.end(response(body.readInt32BE(4), printer.state))
    })
  })
  printer.listen = () =>
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        printer.address = `127.0.0.1:${server.address().port}`
        resolve(printer)
      })
    })
  printer.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return printer
}

export { attr }
