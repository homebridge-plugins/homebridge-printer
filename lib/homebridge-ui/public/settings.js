/* Printer – the plugin's page in the Homebridge UI (Plugins → Printer → Settings).
 *
 * Top: live dashboard, "Find printers on my network", "Test connection".
 * Below: the regular settings form, drawn by the Homebridge UI itself (homebridge.showSchemaForm()).
 */
(function () {
  'use strict';

  var hb = window.homebridge;
  var ALIAS = 'Printer';
  var config = null; // the plugin's config block (kept in sync with the form below)
  var started = false;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function printers() {
    return (config && Array.isArray(config.printers) ? config.printers : []);
  }

  function withAddress() {
    return printers().filter(function (p) { return p && String(p.address || '').trim(); });
  }

  function err(e) { return (e && (e.message || (e.data && e.data.message))) || String(e); }

  // ---------------------------------------------------------------- config
  function starterBlock() {
    return { platform: ALIAS, name: 'Printer', printers: [{ address: '' }], dashboard: { enabled: true, port: 8587 } };
  }

  function pushConfig() {
    return hb.updatePluginConfig([config]).then(function (blocks) {
      if (blocks && blocks[0]) config = blocks[0];
      refreshAll();
    });
  }

  function addAddress(address, name) {
    var list = printers();
    var lower = String(address).toLowerCase();
    if (list.some(function (p) { return String(p.address || '').toLowerCase() === lower; })) {
      hb.toast.info('That printer is already in your settings.');
      return;
    }
    var empty = list.filter(function (p) { return !String(p.address || '').trim(); })[0];
    if (empty) {
      empty.address = address;
      if (name && !empty.name) empty.name = name;
    } else {
      list.push(name && list.length ? { address: address, name: name } : { address: address });
    }
    config.printers = list;
    pushConfig().then(function () {
      hb.toast.success('Added ' + address + '. Click Save, then restart Homebridge.');
    }, function (e) { hb.toast.error(err(e)); });
  }

  // ---------------------------------------------------------------- dashboard link
  function showFullLink() {
    var a = document.getElementById('hp-full');
    var d = (config && config.dashboard) || {};
    if (d.enabled === false) { a.style.display = 'none'; return; }
    a.href = location.protocol.replace('https:', 'http:') + '//' + location.hostname + ':' + (Number(d.port) || 8587) + '/';
    a.style.display = '';
  }

  // ---------------------------------------------------------------- test connection
  function renderTests() {
    var box = document.getElementById('hp-tests');
    box.innerHTML = '';
    withAddress().forEach(function (p) {
      var row = el('div', 'hp-test-row');
      var label = el('div', 'hp-test-label');
      label.appendChild(el('strong', null, String(p.name || '').trim() || 'Printer'));
      label.appendChild(el('span', 'text-muted', ' · ' + p.address));
      var result = el('div', 'hp-test-result');
      var btn = el('button', 'btn btn-sm btn-outline-primary', 'Test connection');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        btn.disabled = true;
        result.className = 'hp-test-result is-busy';
        result.textContent = 'Contacting printer…';
        hb.request('/test', { address: p.address }).then(function (r) {
          if (r && r.ok) {
            var inks = (r.markers || []).map(function (m) { return m.name + ' ' + (m.level === null ? '?' : m.level + '%'); }).join(' · ');
            result.className = 'hp-test-result is-good';
            result.textContent = '✓ Connected – ' + (r.model || 'printer') + (inks ? ' – ' + inks : '');
          } else {
            result.className = 'hp-test-result is-bad';
            result.textContent = '✕ ' + ((r && r.message) || 'Could not reach the printer.');
          }
        }, function (e) {
          result.className = 'hp-test-result is-bad';
          result.textContent = '✕ ' + err(e);
        }).then(function () { btn.disabled = false; });
      });
      row.appendChild(label);
      row.appendChild(btn);
      box.appendChild(row);
      box.appendChild(result);
    });
  }

  // ---------------------------------------------------------------- find printers
  function setupFind() {
    var btn = document.getElementById('hp-find');
    var box = document.getElementById('hp-found');
    btn.addEventListener('click', function () {
      btn.disabled = true;
      box.innerHTML = '';
      var wait = el('div', 'text-muted py-2');
      wait.appendChild(el('span', 'spinner-border spinner-border-sm me-2'));
      wait.appendChild(document.createTextNode('Searching for about 3 seconds…'));
      box.appendChild(wait);
      hb.request('/discover', {}).then(function (res) {
        box.innerHTML = '';
        var found = (res && res.printers) || [];
        if (!found.length) {
          box.appendChild(el('div', 'text-muted py-2', 'No printers answered. Make sure the printer is on and on the same network as Homebridge, or type its IP address in the form below.'));
          return;
        }
        found.forEach(function (f) {
          var address = f.port === 631 && !f.secure ? f.host : f.address;
          var already = printers().some(function (p) {
            var a = String(p.address || '').toLowerCase();
            return a && (a === String(address).toLowerCase() || a.indexOf(String(f.host).toLowerCase()) !== -1 || a.indexOf(String(f.hostname).toLowerCase()) !== -1);
          });
          var row = el('div', 'hp-found-row');
          var info = el('div');
          info.appendChild(el('div', 'fw-semibold', f.name.replace(/\s*\[[0-9A-F]{6}\]\s*$/i, '')));
          info.appendChild(el('div', 'small text-muted', [f.model, f.host].filter(Boolean).join(' · ')));
          row.appendChild(info);
          if (already) {
            row.appendChild(el('span', 'badge bg-secondary', 'Added'));
          } else {
            var add = el('button', 'btn btn-sm btn-primary', 'Add');
            add.type = 'button';
            add.addEventListener('click', function () {
              add.disabled = true;
              addAddress(address);
              setTimeout(function () { btn.click(); }, 400);
            });
            row.appendChild(add);
          }
          box.appendChild(row);
        });
      }, function (e) {
        box.innerHTML = '';
        box.appendChild(el('div', 'text-danger py-2', 'Search failed: ' + err(e)));
      }).then(function () { btn.disabled = false; });
    });
  }

  // ---------------------------------------------------------------- live dashboard
  var dashCb = null;
  var dashSource = {
    load: function () {
      var list = withAddress();
      if (!list.length) return Promise.resolve({ printers: [] });
      return hb.request('/status', { printers: list, dashboard: config.dashboard || {} });
    },
    subscribe: function (cb) {
      dashCb = cb;
      var self = this;
      setInterval(function () { self.load().then(cb, function () {}); }, 6000);
    },
  };

  function refreshAll() {
    showFullLink();
    renderTests();
    var hint = document.getElementById('hp-hint');
    hint.style.display = withAddress().length ? 'none' : '';
    document.getElementById('hp-dash').style.display = withAddress().length ? '' : 'none';
    if (dashCb) dashSource.load().then(dashCb, function () {});
  }

  // ---------------------------------------------------------------- start
  function start() {
    if (started) return;
    started = true;
    setupFind();

    hb.getPluginConfig().then(function (blocks) {
      // The Homebridge UI only draws its settings form once a config block exists,
      // so on a fresh install create one with an empty printer to fill in.
      var fresh = !blocks || !blocks.length;
      config = fresh ? starterBlock() : blocks[0];
      if (!Array.isArray(config.printers)) config.printers = Array.isArray(config.printer) ? config.printer : [];
      if (!config.printers.length) config.printers.push({ address: '' });
      var ready = fresh || !blocks[0].printers ? hb.updatePluginConfig([config]) : Promise.resolve();
      return ready;
    }).then(function () {
      hb.showSchemaForm();
      var dash = document.getElementById('hp-dash');
      if (document.body.classList.contains('dark-mode')) dash.classList.add('hp-dark');
      HPDashboard.mount(dash, dashSource);
      refreshAll();
    }).catch(function (e) {
      hb.toast.error('Could not load settings: ' + err(e));
      hb.showSchemaForm();
    });

    // Keep in step with edits made in the form below
    hb.addEventListener('configChanged', function (event) {
      var blocks = event.data;
      if (blocks && blocks[0]) {
        config = blocks[0];
        refreshAll();
      }
    });
  }

  hb.addEventListener('ready', start);
  if (document.body && document.body.style.display === 'block') start();
})();
