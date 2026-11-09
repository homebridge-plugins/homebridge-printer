/**
 * Small built-in web dashboard: http://<homebridge-host>:8587/
 * Serves the files in homebridge-ui/public/, plus a JSON API and a live Server-Sent Events stream.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC_DIR = fileURLToPath(new URL('./homebridge-ui/public/', import.meta.url))
const FILES = {
  '/': ['dashboard.html', 'text/html; charset=utf-8'],
  '/dashboard.js': ['dashboard.js', 'application/javascript; charset=utf-8'],
  '/dashboard.css': ['dashboard.css', 'text/css; charset=utf-8'],
}

class DashboardServer {
  constructor({ port, host, log, getStatus, onRefresh }) {
    this.port = port
    this.host = host
    this.log = log
    this.getStatus = getStatus
    this.onRefresh = onRefresh
    this.clients = new Set()
    this.server = null
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        this.log.warn(
          `Dashboard: port ${this.port} is already in use. Set a different "dashboard.port" in the plugin config.`,
        )
      } else {
        this.log.warn(`Dashboard error: ${err.message}`)
      }
    })
    this.server.listen(this.port, this.host, () => {
      this.log.info(`Printer dashboard running at http://<your-homebridge-host>:${this.port}/`)
    })
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) {
        res.write(': ping\n\n')
      }
    }, 25000)
    if (this.heartbeat.unref) {
      this.heartbeat.unref()
    }
  }

  stop() {
    clearInterval(this.heartbeat)
    for (const res of this.clients) {
      res.end()
    }
    this.clients.clear()
    if (this.server) {
      this.server.close()
    }
  }

  broadcast() {
    if (!this.clients.size) {
      return
    }
    if (this._pending) {
      return
    }
    this._pending = setTimeout(() => {
      this._pending = null
      const data = `data: ${JSON.stringify(this.getStatus())}\n\n`
      for (const res of this.clients) {
        res.write(data)
      }
    }, 200)
  }

  send(res, code, body, type = 'application/json; charset=utf-8') {
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(body)
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const route = url.pathname

    if (req.method === 'GET' && route === '/api/status') {
      return this.send(res, 200, JSON.stringify(this.getStatus()))
    }

    if (req.method === 'POST' && route === '/api/refresh') {
      return Promise.resolve(this.onRefresh())
        .catch(() => {})
        .then(() => this.send(res, 200, JSON.stringify(this.getStatus())))
    }

    if (req.method === 'GET' && route === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
      })
      res.write(`data: ${JSON.stringify(this.getStatus())}\n\n`)
      this.clients.add(res)
      req.on('close', () => this.clients.delete(res))
      return
    }

    if (req.method === 'GET' && FILES[route]) {
      const [file, type] = FILES[route]
      return fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
        if (err) {
          return this.send(res, 500, 'Dashboard file missing', 'text/plain')
        }
        this.send(res, 200, buf, type)
      })
    }

    this.send(res, 404, 'Not found', 'text/plain')
  }
}

export { DashboardServer }
