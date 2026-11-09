'use strict';

// Dependency-free unit tests: `npm test`
// (The full Homebridge/HAP end-to-end test lives in test/e2e.mjs.)

const assert = require('assert');
const { buildGetPrinterAttributes, parseResponse, normaliseAddress } = require('../src/ipp');
const { parseMarkers } = require('../src/poller');

function attr(tag, name, value) {
  const n = Buffer.from(name);
  const v = typeof value === 'number' ? Buffer.alloc(4) : Buffer.from(value);
  if (typeof value === 'number') v.writeInt32BE(value);
  const b = Buffer.alloc(5 + n.length + v.length);
  b.writeUInt8(tag, 0);
  b.writeUInt16BE(n.length, 1);
  n.copy(b, 3);
  b.writeUInt16BE(v.length, 3 + n.length);
  v.copy(b, 5 + n.length);
  return b;
}

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

test('normaliseAddress handles bare hosts, ipp, ipps and http URLs', () => {
  assert.deepStrictEqual(normaliseAddress('192.168.1.20'), { host: '192.168.1.20', port: 631, secure: false, explicitPath: null });
  assert.deepStrictEqual(normaliseAddress('ipps://hp.local/ipp/print'), { host: 'hp.local', port: 631, secure: true, explicitPath: '/ipp/print' });
  assert.deepStrictEqual(normaliseAddress('http://HPF92BAB4321AB:631/ipp/printer'), {
    host: 'hpf92bab4321ab', port: 631, secure: false, explicitPath: '/ipp/printer',
  });
});

test('Get-Printer-Attributes request is well formed', () => {
  const buf = buildGetPrinterAttributes('ipp://h:631/ipp/print', ['printer-state', 'marker-levels']);
  assert.strictEqual(buf[0], 2);
  assert.strictEqual(buf.readUInt16BE(2), 0x000b);
  assert.ok(buf.includes(Buffer.from('requested-attributes')));
  assert.strictEqual(buf[buf.length - 1], 0x03);
});

test('response parser handles multi-values, enums, out-of-band and collections', () => {
  const resp = Buffer.concat([
    Buffer.from([2, 0, 0, 0, 0, 0, 0, 1, 0x01]),
    attr(0x47, 'attributes-charset', 'utf-8'),
    Buffer.from([0x04]),
    attr(0x23, 'printer-state', 4),
    attr(0x44, 'printer-state-reasons', 'marker-supply-low-warning'),
    attr(0x42, 'marker-names', 'Tri-color'),
    attr(0x42, '', 'Black'),
    attr(0x21, 'marker-levels', 60),
    attr(0x21, '', 8),
    attr(0x13, 'printer-state-message', ''), // no-value
    attr(0x34, 'media-col-ready', ''),
    attr(0x4a, '', 'media-size'),
    attr(0x21, '', 2100),
    attr(0x37, '', ''),
    attr(0x41, 'marker-colors', '#00FFFF#FF00FF#FFFF00'),
    attr(0x41, '', '#000000'),
    Buffer.from([0x03]),
  ]);
  const r = parseResponse(resp);
  assert.strictEqual(r.statusCode, 0);
  const p = r.groups.printer;
  assert.strictEqual(p['printer-state'], 4);
  assert.deepStrictEqual(p['marker-names'], ['Tri-color', 'Black']);
  assert.deepStrictEqual(p['marker-levels'], [60, 8]);
  assert.strictEqual(p['printer-state-message'], null);
  assert.strictEqual(p['media-col-ready'], undefined);

  const m = parseMarkers(p);
  assert.deepStrictEqual(m[0].colors, ['#00FFFF', '#FF00FF', '#FFFF00']);
  assert.strictEqual(m[1].level, 8);
});

test('marker levels: unknown (-1/-2) become null, -3 means some remaining, high levels are scaled', () => {
  const m = parseMarkers({ 'marker-names': ['A', 'B', 'C'], 'marker-levels': [-2, -3, 50], 'marker-high-levels': [100, 100, 200] });
  assert.strictEqual(m[0].level, null);
  assert.strictEqual(m[1].someRemaining, true);
  assert.strictEqual(m[2].level, 25);
});

test('custom characteristics are real classes (Homebridge 2 / HAP-NodeJS 1+ compatible)', () => {
  class Characteristic {
    constructor(name, uuid, props) { Object.assign(this, { name, uuid, props }); }
    getDefaultValue() { return 0; }
  }
  const hap = {
    Characteristic,
    Formats: { BOOL: 'bool', UINT32: 'uint32' },
    Perms: { PAIRED_READ: 'pr', PAIRED_WRITE: 'pw', NOTIFY: 'ev' },
    Units: { SECONDS: 'seconds' },
  };
  const { createCharacteristics } = require('../src/characteristics');
  const C = createCharacteristics(hap);
  const c = new C.EveTimesOpened();
  assert.ok(c instanceof Characteristic);
  assert.strictEqual(C.EveTimesOpened.UUID, 'E863F129-079E-48FF-8F27-9C2605A29F52');
  assert.strictEqual(c.props.format, 'uint32');
});

test('mDNS discovery assembles an HP printer from PTR/SRV/TXT/A records', () => {
  const { assemble, TYPE } = require('../src/discovery');
  const inst = 'HP DeskJet 2800e series [7A1B2C]._ipp._tcp.local';
  const recs = [
    { name: '_ipp._tcp.local', type: TYPE.PTR, data: inst },
    { name: inst.toLowerCase(), type: TYPE.SRV, data: { port: 631, target: 'hp7a1b2c.local' } },
    { name: inst.toLowerCase(), type: TYPE.TXT, data: { ty: 'HP DeskJet 2800e series', rp: 'ipp/print' } },
    { name: 'hp7a1b2c.local', type: TYPE.A, data: '192.168.1.40' },
  ];
  const [p] = assemble(recs);
  assert.strictEqual(p.address, 'ipp://192.168.1.40/ipp/print');
  assert.strictEqual(p.manufacturer, 'HP');
  assert.strictEqual(p.model, 'HP DeskJet 2800e series');
});

console.log(`\n${passed} tests passed`);

(async () => {
  const { PrinterPoller } = require('../src/poller');
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const run = async (attrs) => {
    const p = new PrinterPoller({ name: 't', address: '127.0.0.1', polling: 5, lowInkThreshold: 10 }, quiet);
    p.stopped = true;
    p.client.getAttributes = async () => attrs;
    await p.poll();
    return p.state.printing;
  };
  assert.strictEqual(await run({ 'printer-state': 4, 'queued-job-count': 1 }), true, 'busy with a job');
  assert.strictEqual(await run({ 'printer-state': 4, 'queued-job-count': 0 }), false, 'busy cleaning, no job');
  assert.strictEqual(await run({ 'printer-state': 4 }), true, 'busy, printer does not report job count');
  assert.strictEqual(await run({ 'printer-state': 3, 'queued-job-count': 0 }), false, 'idle');
  const off = new PrinterPoller({ name: 't', address: '127.0.0.1', polling: 5, lowInkThreshold: 10 }, quiet);
  off.stopped = true;
  off.client.getAttributes = async () => { const e = new Error('x'); e.code = 'ECONNREFUSED'; throw e; };
  await off.poll();
  assert.strictEqual(off.state.printing, false, 'offline');
  console.log('ok - Printing switch logic: on only when busy with a job; off when idle, cleaning or offline');
})().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; });
