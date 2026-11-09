/**
 * Minimal, dependency-free IPP/2.0 client for Get-Printer-Attributes.
 * Replaces @sealsystems/ipp, which is unmaintained.
 */

import { Buffer } from 'node:buffer'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'

import { resolveLocal } from './discovery.js'

const localCache = new Map() // "printer.local" -> { ip, at }

/**
 * dns.lookup replacement: uses the normal system lookup, and for ".local"
 * names falls back to asking the network directly (mDNS) if that fails.
 */
function lookupWithMdns(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  const reply = (ip) => {
    if (options && options.all) {
      callback(null, [
        { address: ip, family: 4 },
      ])
    } else {
      callback(null, ip, 4)
    }
  }
  dns.lookup(hostname, options, (err, address, family) => {
    if (!err || !/\.local\.?$/i.test(hostname)) {
      return callback(err, address, family)
    }
    const hit = localCache.get(hostname.toLowerCase())
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
      return reply(hit.ip)
    }
    resolveLocal(hostname).then(
      (ip) => {
        localCache.set(hostname.toLowerCase(), {
          ip,
          at: Date.now(),
        })
        reply(ip)
      },
      () => callback(err),
    )
  })
}

const TAG = {
  OPERATION: 0x01,
  JOB: 0x02,
  END: 0x03,
  PRINTER: 0x04,
  UNSUPPORTED_GROUP: 0x05,
  INTEGER: 0x21,
  BOOLEAN: 0x22,
  ENUM: 0x23,
  TEXT_LANG: 0x35,
  NAME_LANG: 0x36,
  KEYWORD: 0x44,
  URI: 0x45,
  CHARSET: 0x47,
  LANGUAGE: 0x48,
}

const PRINTER_STATES = { 3: 'idle', 4: 'processing', 5: 'stopped' }

const STRING_TAGS = new Set([
  0x41,
  0x42,
  0x44,
  0x45,
  0x46,
  0x47,
  0x48,
  0x49,
  0x4A,
])

let requestId = 1

function encodeAttr(tag, name, value) {
  const nameBuf = Buffer.from(name, 'utf8')
  let valBuf
  if (typeof value === 'number') {
    valBuf = Buffer.alloc(4)
    valBuf.writeInt32BE(value)
  } else {
    valBuf = Buffer.from(String(value), 'utf8')
  }
  const head = Buffer.alloc(3)
  head.writeUInt8(tag, 0)
  head.writeUInt16BE(nameBuf.length, 1)
  const len = Buffer.alloc(2)
  len.writeUInt16BE(valBuf.length)
  return Buffer.concat([head, nameBuf, len, valBuf])
}

function buildGetPrinterAttributes(printerUri, requested) {
  const parts = []
  const header = Buffer.alloc(8)
  header.writeUInt8(2, 0) // version 2.0
  header.writeUInt8(0, 1)
  header.writeUInt16BE(0x000B, 2) // Get-Printer-Attributes
  header.writeInt32BE(requestId++ & 0x7FFFFFFF || 1, 4)
  parts.push(header, Buffer.from([TAG.OPERATION]))
  parts.push(encodeAttr(TAG.CHARSET, 'attributes-charset', 'utf-8'))
  parts.push(encodeAttr(TAG.LANGUAGE, 'attributes-natural-language', 'en'))
  parts.push(encodeAttr(TAG.URI, 'printer-uri', printerUri))
  requested.forEach((attr, i) => {
    parts.push(encodeAttr(TAG.KEYWORD, i === 0
      ? 'requested-attributes'
      : '', attr))
  })
  parts.push(Buffer.from([TAG.END]))
  return Buffer.concat(parts)
}

function decodeValue(tag, buf) {
  if (tag === TAG.INTEGER || tag === TAG.ENUM) {
    return buf.length === 4
      ? buf.readInt32BE(0)
      : null
  }
  if (tag === TAG.BOOLEAN) {
    return buf.length
      ? buf.readUInt8(0) !== 0
      : false
  }
  if (tag === TAG.TEXT_LANG || tag === TAG.NAME_LANG) {
    const langLen = buf.readUInt16BE(0)
    const textLen = buf.readUInt16BE(2 + langLen)
    return buf.toString('utf8', 4 + langLen, 4 + langLen + textLen)
  }
  if (STRING_TAGS.has(tag)) {
    return buf.toString('utf8')
  }
  if (tag >= 0x10 && tag <= 0x1F) {
    return null
  } // out-of-band (unknown, no-value, ...)
  return buf // octetString, dateTime, resolution, ranges ... (raw)
}

/**
 * Parse an IPP response. Returns { version, statusCode, requestId, groups: { operation, printer, ... } }
 * Multi-valued attributes become arrays. Collections are skipped (not needed here).
 */
function parseResponse(buf) {
  if (!buf || buf.length < 9) {
    throw new Error('IPP response too short')
  }
  const res = {
    version: `${buf[0]}.${buf[1]}`,
    statusCode: buf.readUInt16BE(2),
    requestId: buf.readInt32BE(4),
    groups: {},
  }
  const groupNames = {
    1: 'operation',
    2: 'job',
    4: 'printer',
    5: 'unsupported',
  }
  let off = 8
  let group = null
  let lastName = null
  let collectionDepth = 0

  while (off < buf.length) {
    const tag = buf[off++]
    if (tag === TAG.END) {
      break
    }
    if (tag < 0x10) {
      const gname = groupNames[tag] || `group${tag}`
      group = res.groups[gname] = res.groups[gname] || {}
      lastName = null
      continue
    }
    if (off + 2 > buf.length) {
      break
    }
    const nameLen = buf.readUInt16BE(off)
    off += 2
    const name = buf.toString('utf8', off, off + nameLen)
    off += nameLen
    const valLen = buf.readUInt16BE(off)
    off += 2
    const raw = buf.subarray(off, off + valLen)
    off += valLen

    if (tag === 0x34) {
      // begCollection
      if (collectionDepth === 0 && name) {
        lastName = name
      }
      collectionDepth++
      continue
    }
    if (tag === 0x37) {
      collectionDepth = Math.max(0, collectionDepth - 1)
      continue
    }
    if (collectionDepth > 0 || !group) {
      continue
    }

    const value = decodeValue(tag, raw)
    if (name) {
      lastName = name
      group[name] = value
    } else if (lastName) {
      if (!Array.isArray(group[lastName])) {
        group[lastName] = [group[lastName]]
      }
      group[lastName].push(value)
    }
  }
  return res
}

/**
 * Normalises whatever the user typed into an http(s) endpoint + ipp printer-uri.
 * Accepts: 192.168.1.20 | HPF92BAB.local | ipp://host/ipp/print | ipps://host | http://host:631/ipp/printer
 */
function normaliseAddress(address) {
  let a = String(address || '').trim()
  if (!/^[a-z]+:\/\//i.test(a)) {
    a = `ipp://${a}`
  }
  const u = new URL(a)
  const scheme = u.protocol.replace(':', '').toLowerCase()
  const secure = scheme === 'ipps' || scheme === 'https'
  const port = u.port
    ? Number(u.port)
    : scheme === 'http'
      ? 80
      : scheme === 'https'
        ? 443
        : 631
  const explicitPath = u.pathname && u.pathname !== '/'
    ? u.pathname
    : null
  return {
    host: u.hostname,
    port,
    secure,
    explicitPath,
  }
}

class IppPrinter {
  /**
   * @param {string} address
   * @param {{timeout?: number}} [opts]
   */
  constructor(address, opts = {}) {
    this.target = normaliseAddress(address)
    this.timeout = opts.timeout || 8000
    // HP printers use /ipp/print; some older models and CUPS use /ipp/printer or /ipp
    this.paths = this.target.explicitPath
      ? [this.target.explicitPath]
      : ['/ipp/print', '/ipp/printer', '/ipp']
    this.resolvedPath = this.target.explicitPath || null
  }

  printerUri(path) {
    const t = this.target
    return `${t.secure ? 'ipps' : 'ipp'}://${t.host.includes(':')
      ? `[${t.host}]`
      : t.host}:${t.port}${path}`
  }

  post(path, body) {
    const t = this.target
    const lib = t.secure ? https : http
    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          host: t.host,
          port: t.port,
          path,
          method: 'POST',
          headers: { 'Content-Type': 'application/ipp', 'Content-Length': body.length },
          timeout: this.timeout,
          lookup: lookupWithMdns,
          // Printers ship self-signed certificates
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => {
            if (res.statusCode === 426 && !t.secure) {
              // "Upgrade Required" - printer insists on TLS
              t.secure = true
              return this.post(path, body).then(resolve, reject)
            }
            if (res.statusCode !== 200) {
              const err = new Error(`HTTP ${res.statusCode} from printer at ${path}`)
              err.httpStatus = res.statusCode
              return reject(err)
            }
            resolve(Buffer.concat(chunks))
          })
          res.on('error', reject)
        },
      )
      req.on('timeout', () => {
        const err = new Error('Request timed out')
        err.code = 'ETIMEDOUT'
        req.destroy(err)
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  async getAttributes(requested) {
    const candidates = this.resolvedPath
      ? [this.resolvedPath]
      : this.paths
    let lastErr
    for (const path of candidates) {
      try {
        const body = buildGetPrinterAttributes(this.printerUri(path), requested)
        const res = parseResponse(await this.post(path, body))
        if (res.statusCode > 0x00FF) {
          const err = new Error(`IPP status 0x${res.statusCode.toString(16).padStart(4, '0')}`)
          err.ippStatus = res.statusCode
          throw err
        }
        this.resolvedPath = path
        return res.groups.printer || {}
      } catch (err) {
        lastErr = err
        // Network errors won't be fixed by trying another path
        if (err.code && !err.httpStatus) {
          throw err
        }
      }
    }
    throw lastErr
  }
}

export { buildGetPrinterAttributes, IppPrinter, lookupWithMdns, normaliseAddress, parseResponse, PRINTER_STATES }
