// Emulates the Homebridge UI's custom-plugin settings modal, following its source
// (custom-plugins.component.ts + plugins-settings-ui.service.ts):
//  - forks homebridge-ui/server.js and only loads the page after its IPC "ready"
//  - wraps index.html exactly like buildIndexHtml() and loads the official plugin-ui-utils ui.js
//  - answers the same postMessage actions; shows the schema form only when
//    `pluginConfig.length && schema.singular && showSchemaForm` (the real condition)
//  - the schema form is a stand-in (address field per printer) that emits `configChanged` like the real one
//
//   UI_JS=… BOOTSTRAP_CSS=… [INITIAL_PLATFORMS='[…]'] node test/configui-host.mjs [port]

import http from 'node:http';
import { fork } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve, normalize, extname } from 'node:path';
import { tmpdir } from 'node:os';

const PLUGIN = resolve(new URL('..', import.meta.url).pathname);
const PUBLIC = join(PLUGIN, 'homebridge-ui', 'public');
const PORT = Number(process.argv[2] || 8581);
const storage = process.env.HB_STORAGE || mkdtempSync(join(tmpdir(), 'cui-'));
const configFile = join(storage, 'config.json');
writeFileSync(configFile, JSON.stringify({ bridge: {}, platforms: JSON.parse(process.env.INITIAL_PLATFORMS || '[]') }, null, 2));

let childReady = false;
const pending = new Map();
const child = fork(join(PLUGIN, 'homebridge-ui', 'server.js'), [], {
  silent: true,
  env: { ...process.env, HOMEBRIDGE_STORAGE_PATH: storage, HOMEBRIDGE_CONFIG_PATH: configFile, HOMEBRIDGE_UI_VERSION: '5.x-test' },
});
child.stdout.on('data', (d) => console.log('[server.js]', d.toString().trim()));
child.stderr.on('data', (d) => console.error('[server.js:err]', d.toString().trim()));
child.on('message', (m) => {
  if (m.action === 'ready') { childReady = true; console.log('[server.js] ready'); }
  if (m.action === 'response') { const r = pending.get(m.payload.requestId); if (r) { pending.delete(m.payload.requestId); r(m.payload); } }
});

const readConfig = () => JSON.parse(readFileSync(configFile, 'utf8'));
const pluginBlocks = () => readConfig().platforms.filter((p) => p.platform === 'HPPrinter');
const schema = () => JSON.parse(readFileSync(join(PLUGIN, 'config.schema.json'), 'utf8'));

function buildIndexHtml() {
  const body = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
  return `<!doctype html><html><head><meta charset="utf-8"><title>homebridge-hp-printer</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>window._homebridge = { plugin: {"name":"homebridge-hp-printer","displayName":"HP Printer"}, serverEnv: {} };</script>
<script src="/assets/plugin-ui-utils/ui.js"></script>
<script>window.addEventListener('load', () => { window.parent.postMessage({action: 'loaded'}, '*'); }, false)</script>
</head><body style="display:none;">${body}</body></html>`;
}

const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Homebridge – HP Printer</title>
<link rel="stylesheet" href="/assets/bootstrap.css">
<style>body{background:#f0f2f5;padding:24px} .box{max-width:900px;margin:0 auto;background:#fff;border-radius:8px;box-shadow:0 4px 30px rgba(0,0,0,.15)}
.h{padding:14px 20px;border-bottom:1px solid #dee2e6;font-weight:600;font-size:18px} .f{padding:12px 20px;border-top:1px solid #dee2e6;display:flex;justify-content:flex-end;gap:8px}
iframe{width:100%;border:0;display:block;height:1px} #toasts{position:fixed;top:12px;right:12px;width:340px;z-index:9}
body.dark-mode{background:#111} body.dark-mode .box{background:#2a2a2a;color:#eee}</style></head>
<body class="config-ui-x-blue"><div class="box"><div class="h">HP Printer</div>
<iframe id="ui" sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms"></iframe>
<div id="schemaform" class="card card-body m-3" style="display:none"></div>
<div class="f"><button class="btn btn-secondary">Close</button><button class="btn btn-primary" id="save">Save</button></div></div>
<div id="toasts"></div>
<script>
 if (location.search.includes('dark')) document.body.classList.add('dark-mode');
 window.__log = []; let pluginConfig = []; let showSchema = false; let uiLoaded = false; const iframe = document.getElementById('ui');
 const toast = (t, m) => { const d = document.createElement('div'); d.className = 'alert alert-' + (t === 'error' ? 'danger' : t) + ' py-2'; d.textContent = m; document.getElementById('toasts').appendChild(d); window.__toasts = (window.__toasts || []).concat(t + ': ' + m); setTimeout(() => d.remove(), 5000); };
 async function api(p, body) { const r = await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return r.json(); }
 const respond = (e, data, success = true) => e.source.postMessage({ action: 'response', requestId: e.data.requestId, success, data }, e.origin);
 // stand-in for the Homebridge-drawn schema form; same visibility rule as the real modal
 function drawSchemaForm() {
   const sf = document.getElementById('schemaform');
   const visible = uiLoaded && pluginConfig.length && window.__schema.singular && showSchema;
   sf.style.display = visible ? '' : 'none'; sf.innerHTML = '';
   if (!visible) return;
   sf.insertAdjacentHTML('beforeend', '<div class="text-muted small mb-2">[Homebridge settings form]</div>');
   (pluginConfig[0].printers || []).forEach((p, i) => {
     const w = document.createElement('div'); w.className = 'mb-2';
     w.innerHTML = '<label class="form-label">Printer IP address or .local name</label><input class="form-control sf-address">';
     const inp = w.querySelector('input'); inp.value = p.address || '';
     inp.oninput = () => { p.address = inp.value; validate(); clearTimeout(window.__t); window.__t = setTimeout(() => iframe.contentWindow.postMessage({ action: 'stream', event: 'configChanged', data: pluginConfig }, location.origin), 250); };
     sf.appendChild(w);
   });
   validate();
 }
 function validate() { document.getElementById('save').disabled = !(pluginConfig[0] && (pluginConfig[0].printers || []).every((p) => String(p.address || '').trim())); }
 window.addEventListener('message', async (e) => {
   if (e.source !== iframe.contentWindow) return;
   const a = e.data.action; window.__log.push(a);
   switch (a) {
     case 'loaded':
       e.source.postMessage({ action: 'body-class', class: 'config-ui-x-blue' }, e.origin);
       e.source.postMessage({ action: 'body-class', class: 'modal-content' }, e.origin);
       if (document.body.classList.contains('dark-mode')) e.source.postMessage({ action: 'body-class', class: 'dark-mode' }, e.origin);
       e.source.postMessage({ action: 'link-element', href: location.origin + '/assets/bootstrap.css', rel: 'stylesheet' }, e.origin);
       e.source.postMessage({ action: 'inline-style', style: 'body { height: unset !important; }' }, e.origin);
       e.source.postMessage({ action: 'ready' }, e.origin); break;
     case 'scrollHeight': iframe.style.height = (e.data.scrollHeight + 10) + 'px'; uiLoaded = true; drawSchemaForm(); break;
     case 'config.get': respond(e, pluginConfig); break;
     case 'config.update': {
       const blocks = e.data.pluginConfig;
       blocks.forEach((b, i) => { b.platform = 'HPPrinter'; if (pluginConfig[i]) Object.assign(pluginConfig[i], b); else pluginConfig[i] = b; });
       pluginConfig.length = blocks.length; window.__updates = (window.__updates || 0) + 1;
       respond(e, pluginConfig); if (pluginConfig[0] && showSchema) drawSchemaForm(); break; }
     case 'config.schema': respond(e, window.__schema); break;
     case 'request': { const r = await api('/api/request', { path: e.data.path, body: e.data.body }); e.source.postMessage({ action: 'response', requestId: e.data.requestId, success: r.success, data: r.data }, e.origin); break; }
     case 'schema.show': showSchema = true; drawSchemaForm(); break;
     case 'schema.hide': showSchema = false; drawSchemaForm(); break;
     case 'toast.success': case 'toast.error': case 'toast.warning': case 'toast.info': toast(a.split('.')[1], e.data.message); break;
   }
 });
 document.getElementById('save').onclick = async () => { await api('/api/save', pluginConfig); toast('success', 'Saved'); };
 (async () => {
   window.__schema = await api('/api/schema');
   pluginConfig = await api('/api/config');
   while (!(await api('/api/ready')).ready) await new Promise((r) => setTimeout(r, 100));
   iframe.src = '/plugin/index.html';
 })();
</script></body></html>`;

const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s ? JSON.parse(s) : null)); });
const json = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(HOST_PAGE); }
  if (p === '/api/ready') return json(res, { ready: childReady });
  if (p === '/api/config' || p === '/api/saved') return json(res, pluginBlocks());
  if (p === '/api/schema') return json(res, schema());
  if (p === '/api/save') {
    const blocks = await readBody(req); const cfg = readConfig();
    cfg.platforms = cfg.platforms.filter((x) => x.platform !== 'HPPrinter').concat(blocks || []);
    writeFileSync(configFile, JSON.stringify(cfg, null, 2)); return json(res, { ok: true });
  }
  if (p === '/api/request') {
    const { path, body } = await readBody(req); const requestId = Math.random().toString(36).slice(2);
    const result = await new Promise((r) => { pending.set(requestId, r); child.send({ action: 'request', requestId, path, body }); });
    return json(res, result);
  }
  if (p === '/assets/plugin-ui-utils/ui.js') { res.writeHead(200, { 'content-type': types['.js'] }); return res.end(readFileSync(process.env.UI_JS)); }
  if (p === '/assets/bootstrap.css') { res.writeHead(200, { 'content-type': types['.css'] }); return res.end(readFileSync(process.env.BOOTSTRAP_CSS)); }
  if (p === '/plugin/index.html') {
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src * data:; connect-src *; font-src 'self' data:; frame-ancestors 'self'" });
    return res.end(buildIndexHtml());
  }
  if (p.startsWith('/plugin/')) {
    const f = join(PUBLIC, normalize(p.slice(8)).replace(/^(\.\.[/\\])+/, ''));
    if (f.startsWith(PUBLIC) && existsSync(f)) { res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream' }); return res.end(readFileSync(f)); }
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => console.log(`Homebridge UI emulator on http://127.0.0.1:${PORT}/`));
