/**
 * Server side of the plugin's page in the Homebridge UI (Plugins → Printer → Settings).
 *
 * Requests: /status, /test, /discover
 */

import http from 'node:http'

import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils'

import { discoverPrinters } from '../discovery.js'
import { PrinterPoller } from '../poller.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

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
const status = async ({ printers, dashboard }) => {
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
const test = async ({ address }) => {
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
const discover = async () => {
  return { printers: await discoverPrinters({ timeout: 3000 }) };
};

class PluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super()
    this.onRequest('/status', body => status(body || {}))
    this.onRequest('/test', body => test(body || {}))
    this.onRequest('/discover', () => discover())
    this.ready()
  }
}

(() => new PluginUiServer())()
