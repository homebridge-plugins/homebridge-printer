/* Printer – the plugin's page in the Homebridge UI (Plugins → Printer → Settings).
 *
 * Top: live dashboard, "Find printers on my network", "Test connection".
 * Below: the regular settings form, drawn by the Homebridge UI itself (homebridge.showSchemaForm()).
 */
;(function () {
  'use strict'

  const hb = window.homebridge
  const ALIAS = 'Printer'
  let config = null // the plugin's config block (kept in sync with the form below)
  let started = false

  function el(tag, cls, text) {
    const n = document.createElement(tag)
    if (cls) {
      n.className = cls
    }
    if (text !== undefined && text !== null) {
      n.textContent = text
    }
    return n
  }

  function printers() {
    return config && Array.isArray(config.printers)
      ? config.printers
      : []
  }

  function withAddress() {
    return printers().filter((p) => {
      return p && String(p.address || '').trim()
    })
  }

  function err(e) {
    return (e && (e.message || (e.data && e.data.message))) || String(e)
  }

  // ---------------------------------------------------------------- config
  function starterBlock() {
    return {
      platform: ALIAS,
      name: 'Printer',
      printers: [
        { address: '' },
      ],
      dashboard: { enabled: true, port: 8587 },
    }
  }

  function pushConfig() {
    return hb.updatePluginConfig([config]).then((blocks) => {
      if (blocks && blocks[0]) {
        config = blocks[0]
      }
      refreshAll()
    })
  }

  function addAddress(address, name) {
    const list = printers()
    const lower = String(address).toLowerCase()
    if (
      list.some((p) => {
        return String(p.address || '').toLowerCase() === lower
      })
    ) {
      hb.toast.info('That printer is already in your settings.')
      return
    }
    const empty = list.filter((p) => {
      return !String(p.address || '').trim()
    })[0]
    if (empty) {
      empty.address = address
      if (name && !empty.name) {
        empty.name = name
      }
    } else {
      list.push(name && list.length
        ? { address, name }
        : { address })
    }
    config.printers = list
    pushConfig().then(
      () => {
        hb.toast.success(`Added ${address}. Click Save, then restart Homebridge.`)
      },
      (e) => {
        hb.toast.error(err(e))
      },
    )
  }

  // ---------------------------------------------------------------- dashboard link
  function showFullLink() {
    const a = document.getElementById('hp-full')
    const d = (config && config.dashboard) || {}
    if (d.enabled === false) {
      a.style.display = 'none'
      return
    }
    a.href = `${location.protocol.replace('https:', 'http:')}//${location.hostname}:${Number(d.port) || 8587}/`
    a.style.display = ''
  }

  // ---------------------------------------------------------------- test connection
  function renderTests() {
    const box = document.getElementById('hp-tests')
    box.innerHTML = ''
    withAddress().forEach((p) => {
      const row = el('div', 'hp-test-row')
      const label = el('div', 'hp-test-label')
      label.appendChild(el('strong', null, String(p.name || '').trim() || 'Printer'))
      label.appendChild(el('span', 'text-muted', ` · ${p.address}`))
      const result = el('div', 'hp-test-result')
      const btn = el('button', 'btn btn-sm btn-outline-primary', 'Test connection')
      btn.type = 'button'
      btn.addEventListener('click', () => {
        btn.disabled = true
        result.className = 'hp-test-result is-busy'
        result.textContent = 'Contacting printer…'
        hb.request('/test', { address: p.address })
          .then(
            (r) => {
              if (r && r.ok) {
                const inks = (r.markers || [])
                  .map((m) => {
                    return `${m.name} ${m.level === null
                      ? '?'
                      : `${m.level}%`}`
                  })
                  .join(' · ')
                result.className = 'hp-test-result is-good'
                result.textContent = `✓ Connected – ${r.model || 'printer'}${inks
                  ? ` – ${inks}`
                  : ''}`
              } else {
                result.className = 'hp-test-result is-bad'
                result.textContent = `✕ ${(r && r.message) || 'Could not reach the printer.'}`
              }
            },
            (e) => {
              result.className = 'hp-test-result is-bad'
              result.textContent = `✕ ${err(e)}`
            },
          )
          .then(() => {
            btn.disabled = false
          })
      })
      row.appendChild(label)
      row.appendChild(btn)
      box.appendChild(row)
      box.appendChild(result)
    })
  }

  // ---------------------------------------------------------------- find printers
  function setupFind() {
    const btn = document.getElementById('hp-find')
    const box = document.getElementById('hp-found')
    btn.addEventListener('click', () => {
      btn.disabled = true
      box.innerHTML = ''
      const wait = el('div', 'text-muted py-2')
      wait.appendChild(el('span', 'spinner-border spinner-border-sm me-2'))
      wait.appendChild(document.createTextNode('Searching for about 3 seconds…'))
      box.appendChild(wait)
      hb.request('/discover', {})
        .then(
          (res) => {
            box.innerHTML = ''
            const found = (res && res.printers) || []
            if (!found.length) {
              box.appendChild(
                el(
                  'div',
                  'text-muted py-2',
                  'No printers answered. Make sure the printer is on and on the same network as Homebridge, or type its IP address in the form below.',
                ),
              )
              return
            }
            found.forEach((f) => {
              const address = f.port === 631 && !f.secure
                ? f.host
                : f.address
              const already = printers().some((p) => {
                const a = String(p.address || '').toLowerCase()
                return (
                  a
                  && (a === String(address).toLowerCase()
                    || a.includes(String(f.host).toLowerCase())
                    || a.includes(String(f.hostname).toLowerCase()))
                )
              })
              const row = el('div', 'hp-found-row')
              const info = el('div')
              info.appendChild(el('div', 'fw-semibold', f.name.replace(/\s*\[[0-9A-F]{6}\]\s*$/i, '')))
              info.appendChild(el('div', 'small text-muted', [f.model, f.host].filter(Boolean).join(' · ')))
              row.appendChild(info)
              if (already) {
                row.appendChild(el('span', 'badge bg-secondary', 'Added'))
              } else {
                const add = el('button', 'btn btn-sm btn-primary', 'Add')
                add.type = 'button'
                add.addEventListener('click', () => {
                  add.disabled = true
                  addAddress(address)
                  setTimeout(() => {
                    btn.click()
                  }, 400)
                })
                row.appendChild(add)
              }
              box.appendChild(row)
            })
          },
          (e) => {
            box.innerHTML = ''
            box.appendChild(el('div', 'text-danger py-2', `Search failed: ${err(e)}`))
          },
        )
        .then(() => {
          btn.disabled = false
        })
    })
  }

  // ---------------------------------------------------------------- live dashboard
  let dashCb = null
  const dashSource = {
    load() {
      const list = withAddress()
      if (!list.length) {
        return Promise.resolve({ printers: [] })
      }
      return hb.request('/status', { printers: list, dashboard: config.dashboard || {} })
    },
    subscribe(cb) {
      dashCb = cb
      const self = this
      setInterval(() => {
        self.load().then(cb, () => {})
      }, 6000)
    },
  }

  function refreshAll() {
    showFullLink()
    renderTests()
    const hint = document.getElementById('hp-hint')
    hint.style.display = withAddress().length
      ? 'none'
      : ''
    document.getElementById('hp-dash').style.display = withAddress().length
      ? ''
      : 'none'
    if (dashCb) {
      dashSource.load().then(dashCb, () => {})
    }
  }

  // ---------------------------------------------------------------- start
  function start() {
    if (started) {
      return
    }
    started = true
    setupFind()

    hb.getPluginConfig()
      .then((blocks) => {
        // The Homebridge UI only draws its settings form once a config block exists,
        // so on a fresh install create one with an empty printer to fill in.
        const fresh = !blocks || !blocks.length
        config = fresh
          ? starterBlock()
          : blocks[0]
        if (!Array.isArray(config.printers)) {
          config.printers = Array.isArray(config.printer)
            ? config.printer
            : []
        }
        if (!config.printers.length) {
          config.printers.push({ address: '' })
        }
        const ready = fresh || !blocks[0].printers
          ? hb.updatePluginConfig([config])
          : Promise.resolve()
        return ready
      })
      .then(() => {
        hb.showSchemaForm()
        const dash = document.getElementById('hp-dash')
        if (document.body.classList.contains('dark-mode')) {
          dash.classList.add('hp-dark')
        }
        window.HPDashboard.mount(dash, dashSource)
        refreshAll()
      })
      .catch((e) => {
        hb.toast.error(`Could not load settings: ${err(e)}`)
        hb.showSchemaForm()
      })

    // Keep in step with edits made in the form below
    hb.addEventListener('configChanged', (event) => {
      const blocks = event.data
      if (blocks && blocks[0]) {
        config = blocks[0]
        refreshAll()
      }
    })
  }

  hb.addEventListener('ready', start)
  if (document.body && document.body.style.display === 'block') {
    start()
  }
})()
