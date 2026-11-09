'use strict';

/**
 * Helper for the plugin's page in the Homebridge UI (Plugins → HP Printer → Settings).
 *
 * The Homebridge UI only shows the settings page after this script reports "ready",
 * so it deliberately has no npm dependencies: it speaks the Homebridge UI's small IPC
 * protocol directly (the same messages @homebridge/plugin-ui-utils sends).
 *
 * Requests: /status, /test, /discover
 */

const http = require('http');

const handlers = {};
const send = (msg) => process.send && process.send(msg);
const log = (...a) => console.log(...a); // appears in the Homebridge UI log

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** Ask the running plugin's dashboard server for its live status (fast, and matches the Home app). */
function fromRunningPlugin(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data && Array.isArray(data.printers) ? data : null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function pollOnce(p, i) {
  const { PrinterPoller } = require('../src/poller');
  const poller = new PrinterPoller(
    {
      ...p,
      id: String(i),
      name: String(p.name || '').trim() || (i ? `Printer ${i + 1}` : 'Printer'),
      address: String(p.address).trim(),
      polling: 10,
      lowInkThreshold: Number(p.lowInkThreshold) || 10,
    },
    quiet
  );
  poller.stopped = true; // single check
  await poller.poll();
  return poller.state;
}

// ---- live status for the dashboard at the top of the page --------------------------------------
handlers['/status'] = async ({ printers, dashboard }) => {
  const list = (Array.isArray(printers) ? printers : []).filter((p) => p && String(p.address || '').trim());
  if (!list.length) return { printers: [] };

  const port = Number(dashboard && dashboard.port) || 8587;
  if (!dashboard || dashboard.enabled !== false) {
    const live = await fromRunningPlugin(port);
    // Use the plugin's data only if it is watching exactly the printers in these settings
    if (live) {
      const want = list.map((p) => String(p.address).trim().toLowerCase()).sort().join('|');
      const have = live.printers.map((p) => String(p.address).trim().toLowerCase()).sort().join('|');
      if (want === have) return { ...live, source: 'plugin' };
    }
  }
  const states = await Promise.all(list.map(pollOnce));
  return { generated: new Date().toISOString(), source: 'settings', printers: states };
};

// ---- "Test connection" ---------------------------------------------------------------------------
handlers['/test'] = async ({ address }) => {
  if (!address || !String(address).trim()) return { ok: false, message: 'Enter an address first.' };
  const state = await pollOnce({ address }, 0);
  if (!state.online) return { ok: false, message: state.error || 'No answer from that address.' };
  return {
    ok: true,
    model: state.model,
    status: state.status,
    markers: state.markers.map((m) => ({ name: m.name, level: m.level })),
  };
};

// ---- "Find printers on my network" -------------------------------------------------------------
handlers['/discover'] = async () => {
  const { discoverPrinters } = require('../src/discovery');
  return { printers: await discoverPrinters({ timeout: 3000 }) };
};

// ---- IPC with the Homebridge UI ----------------------------------------------------------------
async function processRequest(request) {
  const respond = (data, success = true) =>
    send({ action: 'response', payload: { requestId: request.requestId, success, data } });
  const fn = handlers[request.path];
  if (!fn) return respond({ message: 'Not Found', path: request.path }, false);
  try {
    respond(await fn(request.body || {}), true);
  } catch (err) {
    log(`Request ${request.path} failed: ${err && err.message}`);
    respond({ message: (err && err.message) || String(err) }, false);
  }
}

if (!process.send) {
  console.error('This script is started by the Homebridge UI and cannot be run on its own.');
  process.exit(1);
}

process.on('message', (msg) => {
  if (msg && msg.action === 'request') processRequest(msg);
});
process.on('disconnect', () => process.exit(0));
process.on('uncaughtException', (err) => log(`Settings helper error: ${err && err.stack}`));
process.on('unhandledRejection', (err) => log(`Settings helper error: ${err && (err.stack || err)}`));

send({ action: 'ready', payload: { server: true } });
