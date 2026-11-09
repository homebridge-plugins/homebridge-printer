import net from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { DashboardServer } from './dashboard-server.js'

const quiet = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}
let dashboard

afterEach(() => dashboard?.stop())

/** Sends a raw request line, as any device on the network could. */
function raw(port, line) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`${line}\r\nHost: x\r\nConnection: close\r\n\r\n`))
    let reply = ''
    socket.on('data', (d) => {
      reply += d
    })
    socket.on('end', () => resolve(reply))
    socket.on('error', reject)
  })
}

describe('the dashboard', () => {
  it('answers a path it cannot read with a 400, and keeps running', async () => {
    dashboard = new DashboardServer({
      port: 18597,
      host: '127.0.0.1',
      log: quiet,
      getStatus: () => ({ printers: [] }),
      onRefresh: () => {},
    })
    dashboard.start()
    await new Promise(resolve => dashboard.server.once('listening', resolve))

    expect(await raw(18597, 'GET //[ HTTP/1.1')).toMatch(/^HTTP\/1\.1 400/)
    const status = await (await fetch('http://127.0.0.1:18597/api/status')).json()
    expect(status).toEqual({ printers: [] })
  })
})
