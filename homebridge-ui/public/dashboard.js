/* HP Printer dashboard – served by the plugin at http://<homebridge>:8587/ */
(function (global) {
  'use strict';

  var REASONS = {
    'media-empty': 'Out of paper',
    'media-needed': 'Load paper',
    'media-jam': 'Paper jam',
    'door-open': 'A door is open',
    'cover-open': 'Cover is open',
    'input-tray-missing': 'Paper tray missing',
    'output-tray-missing': 'Output tray missing',
    'marker-supply-empty': 'Cartridge empty',
    'marker-supply-low': 'Ink low',
    'toner-empty': 'Toner empty',
    'toner-low': 'Toner low',
    'paused': 'Paused',
    'offline': 'Printer reports offline',
    'other': 'Needs attention',
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function reasonText(r) {
    var base = String(r).replace(/-(error|warning|report)$/, '');
    return REASONS[base] || base.replace(/-/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); });
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' ' +
      d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function lightOrDark(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 'light';
    var n = parseInt(m[1], 16);
    var l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return l < 60 ? 'dark' : 'light';
  }

  // Normalise HP's pure RGB marker colours into friendlier ink tones (like HP Smart does)
  var INK = { '#00FFFF': '#2d9fd8', '#FF00FF': '#d6337e', '#FFFF00': '#f7cf3b', '#000000': '#1d1d22' };
  function inkColour(c) { return INK[c] || c; }

  function isLow(m, threshold) {
    if (m.level === null || m.level === undefined) return false;
    var t = m.low !== null && m.low > 0 ? Math.max(m.low, threshold) : threshold;
    return m.level <= t;
  }

  function renderInk(markers, threshold) {
    var wrap = el('div', 'hp-inks');
    markers.forEach(function (m) {
      var colours = (m.colors && m.colors.length ? m.colors : ['#8a8a96']).map(inkColour);
      var low = isLow(m, threshold);
      var unknown = m.level === null || m.level === undefined;
      var col = el('div', 'hp-ink');
      col.title = m.name + ': ' + (unknown ? (m.someRemaining ? 'some ink remaining' : 'level unknown') : m.level + '%');

      var tube = el('div', 'hp-tube' + (low ? ' is-low' : '') + (unknown ? ' is-unknown' : ''));
      tube.setAttribute('role', 'meter');
      tube.setAttribute('aria-label', m.name);
      tube.setAttribute('aria-valuemin', '0');
      tube.setAttribute('aria-valuemax', '100');
      if (!unknown) tube.setAttribute('aria-valuenow', String(m.level));

      var level = unknown ? (m.someRemaining ? 50 : 0) : m.level;
      colours.forEach(function (c) {
        var stripe = el('div', 'hp-stripe');
        var fill = el('div', 'hp-fill');
        fill.style.setProperty('--ink', c);
        fill.style.height = level + '%';
        stripe.appendChild(fill);
        tube.appendChild(stripe);
      });
      col.appendChild(tube);

      var dots = el('div', 'hp-dots hp-dots-' + Math.min(colours.length, 3));
      colours.slice(0, 3).forEach(function (c) {
        var d = el('span', 'hp-dot');
        d.style.background = c;
        dots.appendChild(d);
      });
      col.appendChild(dots);
      col.appendChild(el('div', 'hp-pct' + (low ? ' is-low' : ''), unknown ? '?' : m.level + '%'));
      wrap.appendChild(col);
    });
    return wrap;
  }

  var PRINTER_SVG =
    '<svg viewBox="0 0 520 300" class="hp-printer-svg" aria-hidden="true">' +
    '<defs>' +
    '<linearGradient id="hpBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--body-hi)"/><stop offset="1" stop-color="var(--body-lo)"/></linearGradient>' +
    '<linearGradient id="hpLid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--body-hi)"/><stop offset="1" stop-color="var(--body-mid)"/></linearGradient>' +
    '<clipPath id="hpSlot"><rect x="150" y="196" width="230" height="120"/></clipPath>' +
    '</defs>' +
    '<ellipse cx="262" cy="282" rx="230" ry="12" fill="var(--shadow)"/>' +
    // paper sticking out of the top feeder
    '<rect x="170" y="38" width="190" height="22" rx="2" fill="var(--paper)" stroke="var(--line)"/>' +
    // main body
    '<path d="M42 92 Q42 74 60 72 L470 72 Q488 74 488 92 L494 250 Q494 268 476 268 L54 268 Q36 268 36 250 Z" fill="url(#hpBody)" stroke="var(--line)"/>' +
    // accent band on the left edge (blue-grey like the DeskJet in the reference)
    '<path d="M42 92 Q42 74 60 72 L120 72 L110 128 L40 128 Z" fill="var(--accent-band)"/>' +
    '<path d="M470 72 Q488 74 488 92 L490 128 L430 128 L420 72 Z" fill="var(--accent-band)"/>' +
    // scanner lid
    '<path d="M100 56 Q100 46 112 46 L420 46 Q432 46 432 56 L436 122 Q436 130 426 130 L106 130 Q96 130 96 122 Z" fill="url(#hpLid)" stroke="var(--line)"/>' +
    '<ellipse cx="300" cy="74" rx="22" ry="5" fill="var(--logo)"/>' +
    // control panel
    '<rect x="56" y="96" width="34" height="58" rx="5" fill="var(--panel)" transform="skewX(-6)"/>' +
    '<circle cx="64" cy="108" r="3" class="hp-led"/>' +
    '<rect x="62" y="118" width="14" height="10" rx="1.5" fill="var(--panel-screen)"/>' +
    // label plate
    '<rect x="58" y="176" width="66" height="14" rx="3" fill="var(--plate)" stroke="var(--line)"/>' +
    // output opening
    '<path d="M152 150 L378 150 Q390 150 390 162 L390 238 L140 238 L140 162 Q140 150 152 150 Z" fill="var(--opening)" stroke="var(--line)"/>' +
    '<rect x="152" y="190" width="226" height="14" rx="3" fill="var(--slot)"/>' +
    '<rect x="248" y="146" width="34" height="8" rx="2" fill="var(--body-mid)" stroke="var(--line)"/>' +
    '<g fill="var(--rollers)"><rect x="170" y="194" width="30" height="6" rx="1"/><rect x="222" y="194" width="30" height="6" rx="1"/><rect x="278" y="194" width="30" height="6" rx="1"/><rect x="330" y="194" width="30" height="6" rx="1"/></g>' +
    // paper coming out (animated while printing)
    '<g clip-path="url(#hpSlot)"><g class="hp-sheet"><rect x="176" y="190" width="178" height="70" fill="var(--paper)" stroke="var(--line)"/>' +
    '<g stroke="var(--ink-lines)" stroke-width="3" stroke-linecap="round"><line x1="192" y1="206" x2="300" y2="206"/><line x1="192" y1="218" x2="330" y2="218"/><line x1="192" y1="230" x2="280" y2="230"/></g></g></g>' +
    // output tray
    '<path d="M126 238 L404 238 L412 258 L118 258 Z" fill="var(--tray)" stroke="var(--line)"/>' +
    '<rect x="230" y="242" width="70" height="5" rx="2.5" fill="var(--body-mid)"/>' +
    '</svg>';

  function statusInfo(p) {
    if (!p.online || p.status === 'offline' || p.status === 'unknown') {
      return { cls: 'is-offline', title: p.status === 'unknown' ? 'Connecting…' : 'Not connected.', sub: p.status === 'unknown' ? 'Waiting for the first response from the printer' : 'Check the printer is on and connected to the network' };
    }
    var issues = (p.reasons || []).filter(function (r) { return /-(error|warning)$/.test(r) || r === 'media-empty' || r === 'media-jam' || r === 'door-open'; });
    if (p.printing === true || (p.printing === undefined && p.status === 'processing')) {
      return { cls: 'is-printing', title: 'Printing…', sub: p.queuedJobs > 1 ? p.queuedJobs + ' jobs in the queue' : 'Your document is on its way' };
    }
    if (p.status === 'stopped' || issues.some(function (r) { return /-error$/.test(r); })) {
      return { cls: 'is-error', title: issues.length ? reasonText(issues[0]) : 'Printer stopped', sub: p.message || 'Check the printer' };
    }
    if (issues.length) {
      return { cls: 'is-warn', title: reasonText(issues[0]), sub: issues.length > 1 ? 'and ' + (issues.length - 1) + ' more' : 'Printer needs attention' };
    }
    return { cls: 'is-ready', title: 'Ready', sub: 'Idle and waiting for jobs' };
  }

  var ICONS = {
    'is-printing': '<svg viewBox="0 0 24 24"><path d="M7 3h10v5H7z" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="3" y="8" width="18" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7 14h10v7H7z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
    'is-ready': '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 12.5l2.6 2.6L16 9.7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    'is-offline': '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="13" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6 3h7v5H6zM6 14h7v6H6z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="17" r="4.5" fill="currentColor"/><path d="M16.8 15.8a1.3 1.3 0 1 1 1.8 1.2c-.4.2-.6.5-.6.9M18 19.6v.1" fill="none" stroke="var(--pill-bg)" stroke-width="1.2" stroke-linecap="round"/></svg>',
    'is-warn': '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 10v5M12 17.6v.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    'is-error': '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 10v5M12 17.6v.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  };

  function renderPrinter(p, threshold) {
    var s = statusInfo(p);
    var sec = el('section', 'hp-card ' + s.cls);

    var left = el('div', 'hp-left');
    left.appendChild(el('h1', 'hp-name', p.name));
    if (p.model) left.appendChild(el('div', 'hp-model', p.model.replace(/^HP\s+/i, '')));

    if (p.markers && p.markers.length) {
      var box = el('div', 'hp-supplies');
      box.appendChild(renderInk(p.markers, p.lowThreshold != null ? p.lowThreshold : threshold));
      box.appendChild(el('div', 'hp-meta', 'Estimated supply levels'));
      box.appendChild(el('div', 'hp-meta', 'Last updated ' + fmtTime(p.lastSeen || p.lastUpdated)));
      var low = p.markers.filter(function (m) { return isLow(m, p.lowThreshold != null ? p.lowThreshold : threshold); });
      if (low.length) {
        box.appendChild(el('div', 'hp-warn', (low.length === 1 ? low[0].name + ' is' : low.map(function (m) { return m.name; }).join(' and ') + ' are') + ' running low'));
      }
      left.appendChild(box);
    } else {
      var empty = el('div', 'hp-supplies hp-supplies-empty');
      empty.appendChild(el('div', 'hp-meta', p.online ? 'This printer did not report supply levels' : 'Supply levels appear once the printer is reachable'));
      empty.appendChild(el('div', 'hp-meta', 'Last updated ' + fmtTime(p.lastUpdated)));
      left.appendChild(empty);
    }

    if (p.energy) {
      var e = p.energy;
      var kwh = e.kWh < 10 ? e.kWh.toFixed(2) : e.kWh.toFixed(1);
      var energy = el('div', 'hp-energy');
      energy.title = 'Worked out from the printer\'s state (printing, ready, sleep, off) and the wattages in Settings';
      energy.appendChild(el('strong', null, '≈ ' + (Math.round(e.watts * 10) / 10) + ' W'));
      energy.appendChild(el('span', null, ' now · ' + kwh + ' kWh since ' + new Date(e.since).toLocaleDateString([], { day: 'numeric', month: 'short' })));
      left.appendChild(energy);
    }

    var pill = el('div', 'hp-pill');
    pill.setAttribute('role', 'status');
    var icon = el('span', 'hp-pill-icon');
    icon.innerHTML = ICONS[s.cls];
    var txt = el('span', 'hp-pill-text');
    txt.appendChild(el('strong', null, s.title));
    txt.appendChild(el('span', null, ' ' + s.sub));
    pill.appendChild(icon);
    pill.appendChild(txt);
    left.appendChild(pill);

    var right = el('div', 'hp-right');
    right.innerHTML = PRINTER_SVG;

    sec.appendChild(left);
    sec.appendChild(right);
    return sec;
  }

  function render(root, data) {
    var printers = (data && data.printers) || [];
    root.innerHTML = '';
    if (!printers.length) {
      var e = el('section', 'hp-card hp-empty');
      e.appendChild(el('h1', 'hp-name', 'No printers yet'));
      e.appendChild(el('div', 'hp-meta', 'Add a printer in the plugin settings and restart Homebridge.'));
      root.appendChild(e);
      return;
    }
    printers.forEach(function (p) { root.appendChild(renderPrinter(p, 10)); });
  }

  /**
   * source: { load(): Promise<status>, subscribe?(cb): void }
   */
  function mount(root, source) {
    root.classList.add('hp-dashboard');
    root.innerHTML = '<div class="hp-loading">Loading printers…</div>';
    var lastSig = null;
    var draw = function (d) {
      // Only rebuild when something visible changed, so animations don't restart every poll
      var sig = JSON.stringify(((d && d.printers) || []).map(function (p) {
        return [p.name, p.model, p.online, p.status, p.printing, p.energy && [p.energy.watts, p.energy.kWh.toFixed(2)], p.reasons, p.queuedJobs, p.markers, p.message, fmtTime(p.lastSeen || p.lastUpdated)];
      }));
      if (sig === lastSig) return;
      lastSig = sig;
      render(root, d);
    };
    var fail = function (err) {
      root.innerHTML = '';
      var e = el('section', 'hp-card hp-empty');
      e.appendChild(el('h1', 'hp-name', 'Dashboard unavailable'));
      e.appendChild(el('div', 'hp-meta', (err && err.message) || String(err)));
      root.appendChild(e);
    };
    source.load().then(draw, fail);
    if (source.subscribe) source.subscribe(draw, fail);
  }

  /** Data source for the standalone page: Server-Sent Events, falling back to polling. */
  function httpSource(base) {
    base = base || '';
    return {
      load: function () {
        return fetch(base + '/api/status', { cache: 'no-store' }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        });
      },
      subscribe: function (cb) {
        var self = this;
        var poll = function () { setInterval(function () { self.load().then(cb, function () {}); }, 5000); };
        if (!global.EventSource) return poll();
        var es = new EventSource(base + '/api/events');
        var opened = false;
        es.onopen = function () { opened = true; };
        es.onmessage = function (e) { try { cb(JSON.parse(e.data)); } catch (_) { /* ignore */ } };
        es.onerror = function () { if (!opened) { es.close(); poll(); } };
      },
    };
  }

  global.HPDashboard = { mount: mount, render: render, httpSource: httpSource };
})(window);
