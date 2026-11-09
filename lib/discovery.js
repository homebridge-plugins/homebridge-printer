/**
 * Finds IPP printers on the local network using multicast DNS (Bonjour),
 * the same way macOS and HP Smart find them. No dependencies.
 */

import { Buffer } from 'node:buffer'
import dgram from 'node:dgram'

const MDNS_ADDR = '224.0.0.251'
const MDNS_PORT = 5353
const SERVICES = ['_ipp._tcp.local', '_ipps._tcp.local']
const TYPE = {
  A: 1,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
}

function encodeName(name) {
  const parts = name.split('.').filter(Boolean)
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, 'utf8')
    return Buffer.concat([
      Buffer.from([b.length]),
      b,
    ])
  })
  return Buffer.concat([
    ...bufs,
    Buffer.from([0]),
  ])
}

function buildQuery(names) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(names.length, 4) // QDCOUNT
  const qs = names.map((n) => {
    const tail = Buffer.alloc(4)
    tail.writeUInt16BE(TYPE.PTR, 0)
    tail.writeUInt16BE(1, 2) // class IN
    return Buffer.concat([
      encodeName(n),
      tail,
    ])
  })
  return Buffer.concat([header, ...qs])
}

function readName(buf, offset) {
  const labels = []
  let jumped = false
  let end = offset
  let guard = 0
  while (offset < buf.length && guard++ < 128) {
    const len = buf[offset]
    if (len === 0) {
      offset += 1
      break
    }
    if ((len & 0xC0) === 0xC0) {
      if (!jumped) {
        end = offset + 2
      }
      offset = ((len & 0x3F) << 8) | buf[offset + 1]
      jumped = true
      continue
    }
    labels.push(buf.toString('utf8', offset + 1, offset + 1 + len))
    offset += 1 + len
  }
  return {
    name: labels.join('.'),
    next: jumped ? end : offset,
  }
}

function parsePacket(buf) {
  if (buf.length < 12) {
    return []
  }
  const qd = buf.readUInt16BE(4)
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10)
  let off = 12
  for (let i = 0; i < qd; i++) {
    off = readName(buf, off).next + 4
  }
  const records = []
  for (let i = 0; i < total && off < buf.length; i++) {
    const { name, next } = readName(buf, off)
    off = next
    if (off + 10 > buf.length) {
      break
    }
    const type = buf.readUInt16BE(off)
    const rdlen = buf.readUInt16BE(off + 8)
    const rd = off + 10
    off = rd + rdlen
    const rec = {
      name: name.toLowerCase(),
      rawName: name,
      type,
    }
    if (type === TYPE.PTR) {
      rec.data = readName(buf, rd).name
    } else if (type === TYPE.SRV) {
      rec.data = {
        port: buf.readUInt16BE(rd + 4),
        target: readName(buf, rd + 6).name.toLowerCase(),
      }
    } else if (type === TYPE.A && rdlen === 4) {
      rec.data = [
        ...buf.subarray(rd, rd + 4),
      ].join('.')
    } else if (type === TYPE.TXT) {
      const txt = {}
      let p = rd
      while (p < rd + rdlen) {
        const l = buf[p]
        const s = buf.toString('utf8', p + 1, p + 1 + l)
        const eq = s.indexOf('=')
        if (eq > 0) {
          txt[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1)
        }
        p += 1 + l
      }
      rec.data = txt
    } else {
      continue
    }
    records.push(rec)
  }
  return records
}

/** Turn a bag of mDNS records into printer entries. */
function assemble(records) {
  const byName = (type, name) => records.filter(r => r.type === type && r.name === name.toLowerCase())
  const printers = new Map()
  for (const ptr of records.filter(r => r.type === TYPE.PTR && SERVICES.includes(r.name))) {
    const instance = ptr.data
    const srv = byName(TYPE.SRV, instance)[0]
    if (!srv) {
      continue
    }
    const txt = (byName(TYPE.TXT, instance)[0] || {}).data || {}
    const ip = (byName(TYPE.A, srv.data.target)[0] || {}).data
    const secure = ptr.name.startsWith('_ipps')
    const host = ip || srv.data.target
    const path = `/${String(txt.rp || 'ipp/print').replace(/^\/+/, '')}`
    const label = instance.replace(/\._ipps?\._tcp\.local$/i, '')
    const key = (txt.uuid || label).toLowerCase()
    const existing = printers.get(key)
    // Prefer plain IPP over IPPS when a printer advertises both (simpler, no certificate)
    if (existing && !existing.secure) {
      continue
    }
    printers.set(key, {
      name: label,
      model: txt.ty || txt.usb_mdl || null,
      manufacturer: txt.usb_mfg || (/^hp\b/i.test(txt.ty || label)
        ? 'HP'
        : null),
      host,
      hostname: srv.data.target,
      port: srv.data.port,
      secure,
      address: `${secure ? 'ipps' : 'ipp'}://${host}${srv.data.port === 631
        ? ''
        : `:${srv.data.port}`}${path}`,
    })
  }
  return [
    ...printers.values(),
  ].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * @param {{timeout?: number}} [opts]
 * @returns {Promise<Array<{name, model, manufacturer, host, hostname, port, secure, address}>>} the printers found
 */
function discoverPrinters(opts = {}) {
  const timeout = opts.timeout || 3000
  const query = buildQuery(SERVICES)
  const records = []
  const sockets = []

  const listen = (sock) => {
    sock.on('message', (msg) => {
      try {
        records.push(...parsePacket(msg))
      } catch (_) {
        /* ignore malformed packets */
      }
    })
    sock.on('error', () => {})
    sockets.push(sock)
  }

  return new Promise((resolve) => {
    // 1) "legacy unicast" query from a random port: responders answer us directly
    const uni = dgram.createSocket({ type: 'udp4' })
    listen(uni)
    uni.bind(0, () => {
      const send = () => uni.send(query, MDNS_PORT, MDNS_ADDR, () => {})
      send()
      setTimeout(send, 700)
      setTimeout(send, 1600)
    })

    // 2) also listen on the multicast group, in case responders only multicast
    try {
      const multi = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      listen(multi)
      multi.bind(MDNS_PORT, () => {
        try {
          multi.addMembership(MDNS_ADDR)
          multi.send(query, MDNS_PORT, MDNS_ADDR, () => {})
        } catch (_) {
          /* port shared with the OS responder may not allow this */
        }
      })
    } catch (_) {
      /* ignore */
    }

    setTimeout(() => {
      for (const s of sockets) {
        try {
          s.close()
        } catch (_) {
          /* already closed */
        }
      }
      resolve(assemble(records))
    }, timeout)
  })
}

/**
 * Resolve "something.local" to an IPv4 address with a direct mDNS query.
 * Used when the operating system can't resolve .local names itself
 * (e.g. Linux without avahi/nss-mdns).
 */
function resolveLocal(hostname, timeout = 2000) {
  const name = String(hostname).toLowerCase().replace(/\.$/, '')
  const header = Buffer.alloc(12)
  header.writeUInt16BE(1, 4)
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(TYPE.A, 0)
  tail.writeUInt16BE(1, 2)
  const query = Buffer.concat([
    header,
    encodeName(name),
    tail,
  ])

  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4' })
    let done = false
    let timer = null
    const finish = (err, ip) => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      try {
        sock.close()
      } catch (_) {
        /* closed */
      }
      if (err) {
        reject(err)
      } else {
        resolve(ip)
      }
    }
    timer = setTimeout(() => {
      const err = new Error(`Could not find ${hostname} on the network`)
      err.code = 'ENOTFOUND'
      finish(err)
    }, timeout)
    sock.on('error', err => finish(err))
    sock.on('message', (msg) => {
      try {
        const hit = parsePacket(msg).find(r => r.type === TYPE.A && r.name === name)
        if (hit) {
          finish(null, hit.data)
        }
      } catch (_) {
        /* ignore */
      }
    })
    sock.bind(0, () => {
      sock.send(query, MDNS_PORT, MDNS_ADDR, () => {})
      setTimeout(() => !done && sock.send(query, MDNS_PORT, MDNS_ADDR, () => {}), 600)
    })
  })
}

export { assemble, buildQuery, discoverPrinters, encodeName, parsePacket, resolveLocal, TYPE }
