// End-to-end test: runs the plugin inside the real Homebridge API + HAP-NodeJS
// against a real IPP server (CUPS ippeveprinter).
//
//   HB_DIR=/path/to/built/homebridge  IPP_ADDR=127.0.0.1:8631  node test/e2e.mjs
//
// Phases: fresh start -> idle -> printing -> restart from cache -> offline.

import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HB = process.env.HB_DIR;
const IPP = process.env.IPP_ADDR || '127.0.0.1:8631';
const PRINT = process.env.PRINT_CMD; // shell command that submits a job
const OFFLINE_ADDR = '127.0.0.1:8699';

const { HomebridgeAPI } = await import(join(HB, 'dist/api.js'));
const { PlatformAccessory } = await import(join(HB, 'dist/platformAccessory.js'));
const { User } = await import(join(HB, 'dist/user.js'));
const { Logger } = await import(join(HB, 'dist/logger.js'));
const hapPath = process.env.HAP_DIR ? join(process.env.HAP_DIR, 'dist/index.js') : null;

const storage = mkdtempSync(join(tmpdir(), 'hbtest-'));
User.setStoragePath(storage);

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const plugin = require(resolve('index.js'));

function boot(config, cachedSerialized = []) {
  const api = new HomebridgeAPI();
  const hap = api.hap;
  let Ctor;
  api.registerPlatform = (id, name, c) => { Ctor = c; ok(id === 'homebridge-hp-printer' && name === 'HPPrinter', `registerPlatform(${id}, ${name})`); };
  plugin(api);

  const registered = [];
  const warnings = [];
  api.registerPlatformAccessories = (p, n, accs) => accs.forEach((a) => { a._associatedPlugin = p; a._associatedPlatform = n; registered.push(a); });
  const unregistered = [];
  api.unregisterPlatformAccessories = (p, n, accs) => unregistered.push(...accs);
  api.updatePlatformAccessories = () => {};

  const log = Logger.withPrefix('HPPrinter');
  const platform = new Ctor(log, config, api);

  const restored = cachedSerialized.map((s) => PlatformAccessory.deserialize(s));
  restored.forEach((a) => platform.configureAccessory(a));

  api.signalFinished();
  const all = [...restored, ...registered];
  for (const a of all) {
    a._associatedHAPAccessory.on('characteristic-warning', (w) => warnings.push(`${a.displayName}: ${w.message}`));
  }
  return { api, hap, platform, all, warnings, unregistered };
}

function bridgeCheck(hap, accessories, label) {
  const bridge = new hap.Bridge('Test Bridge', hap.uuid.generate('test-bridge-' + label));
  bridge.addBridgedAccessories(accessories.map((a) => a._associatedHAPAccessory));
  bridge._identifierCache = Object.assign(new (require(join(process.env.HAP_DIR || join(HB, 'node_modules/@homebridge/hap-nodejs'), 'dist/lib/model/IdentifierCache.js')).IdentifierCache)('AA:BB:CC:DD:EE:FF'), { save() {} });
  const json = bridge.internalHAPRepresentation(true);
  ok(json.length === accessories.length + 1, `${label}: bridge serialises ${json.length - 1} accessories to HAP JSON`);
  const conn = { username: 'test', remoteAddress: '127.0.0.1', sessionID: 'x', on() {}, removeListener() {} };
  return bridge.toHAP(conn, true).then((full) => {
    ok(Array.isArray(full), `${label}: toHAP() with get handlers succeeded`);
    for (const a of accessories) bridge.removeBridgedAccessory(a._associatedHAPAccessory, true);
  });
}

function svc(acc, hap, type, subtype) {
  return subtype ? acc.getServiceById(type, subtype) : acc.getService(type);
}

const cfg = (address) => ({
  platform: 'HPPrinter',
  printers: [{ name: 'My Printer', address, polling: 3, marker: true, lowInkThreshold: 10, switchType: 'SWITCH', history: true }],
  dashboard: { enabled: true, port: 8587 },
});

// ---------------------------------------------------------------- phase 1: fresh start, idle
console.log(`\n== Homebridge ${new HomebridgeAPI().serverVersion}, HAP ${new HomebridgeAPI().hap.HAPLibraryVersion()}, Node ${process.version}`);
let run = boot(cfg(IPP));
let { hap } = run;
ok(run.all.length === 3, `registered ${run.all.length} accessories: ${run.all.map((a) => a.displayName).join(', ')}`);
await sleep(1500);

const sensor = run.all.find((a) => a.displayName === 'My Printer');
const sw = run.all.find((a) => a.displayName === 'My Printer Printing');
const swOn = () => sw.getService(hap.Service.Switch).getCharacteristic(hap.Characteristic.On).value;
const onl = run.all.find((a) => a.displayName === 'My Printer Online');
const onlOn = () => onl.getService(hap.Service.Switch).getCharacteristic(hap.Characteristic.On).value;
const C = hap.Characteristic;
const contact = svc(sensor, hap, hap.Service.ContactSensor);
ok(contact.getCharacteristic(C.StatusActive).value === true, 'sensor: StatusActive=true (online)');
ok(contact.getCharacteristic(C.ContactSensorState).value === 0, 'sensor: idle -> contact detected (0)');
ok(!!sw && swOn() === false, 'Switch 2 "My Printer Printing" exists and is OFF while idle');
ok(!!onl && onlOn() === true, 'Switch 1 "My Printer Online" exists and is ON (printer reachable)');

const inks = sensor.services.filter((s) => s.UUID === hap.Service.FilterMaintenance.UUID);
ok(inks.length === 2, `ink services created: ${inks.map((s) => s.displayName).join(', ')}`);
const black = inks.find((s) => /Black/.test(s.displayName));
const tri = inks.find((s) => /Tri/.test(s.displayName));
ok(black && black.getCharacteristic(C.FilterLifeLevel).value === 8, 'black ink FilterLifeLevel = 8');
ok(black && black.getCharacteristic(C.FilterChangeIndication).value === 1, 'black ink FilterChangeIndication = CHANGE (low)');
ok(tri && tri.getCharacteristic(C.FilterLifeLevel).value === 60, 'tri-color FilterLifeLevel = 60');
ok(tri && tri.getCharacteristic(C.FilterChangeIndication).value === 0, 'tri-color FilterChangeIndication = OK');
ok(!!sensor.getService(hap.Service.AccessoryInformation).getCharacteristic(C.FirmwareRevision).value, 'firmware revision set');
ok(sensor.services.some((s) => /History/.test(s.displayName)), 'Eve (fakegato) history service attached');
await bridgeCheck(hap, run.all, 'fresh');

// dashboard API
const st = await (await fetch('http://127.0.0.1:8587/api/status')).json();
ok(st.printers.length === 1 && st.printers[0].markers.length === 2, 'dashboard /api/status returns printer + 2 markers');
const html = await (await fetch('http://127.0.0.1:8587/')).text();
ok(html.includes('dashboard.js'), 'dashboard / serves HTML');

// ---------------------------------------------------------------- phase 2: printing
if (PRINT) {
  execFileSync('sh', ['-c', PRINT], { stdio: 'ignore' });
  await sleep(4500);
  ok(contact.getCharacteristic(C.ContactSensorState).value === 1, 'printing -> contact NOT detected (1)');
  ok(swOn() === true, 'Printing switch turns ON while a job prints');
  ok(onlOn() === true, 'Online switch stays ON while printing');
  ok(sensor.context.timesPrinted >= 1, `Eve TimesOpened counter incremented (${sensor.context.timesPrinted})`);
  const st2 = await (await fetch('http://127.0.0.1:8587/api/status')).json();
  ok(st2.printers[0].status === 'processing', 'dashboard reports processing');
  if (process.env.HOLD_PRINTING) {
    console.log('HOLD: printing state ready for screenshots');
    await sleep(Number(process.env.HOLD_PRINTING));
  }
  await sleep(9000);
  ok(contact.getCharacteristic(C.ContactSensorState).value === 0, 'job finished -> back to idle');
  ok(swOn() === false, 'Printing switch turns OFF when the job finishes');
}


// ---------------------------------------------------------------- phase 3: restart from cache
const serialized = run.all.map((a) => PlatformAccessory.serialize(a));
// Replace the Online switch with one shaped like version 2.1.0 made it (same id), as an upgrading user has
const legacyUuid = run.hap.uuid.generate('hp-printer:My Printer:online');
serialized.splice(serialized.findIndex((x) => x.UUID === legacyUuid), 1);
const legacy = new PlatformAccessory('My Printer Online', legacyUuid);
legacy.addService(run.hap.Service.Switch, 'My Printer Online', 'online');
legacy._associatedPlugin = 'homebridge-hp-printer';
legacy._associatedPlatform = 'HPPrinter';
serialized.push(PlatformAccessory.serialize(legacy));
run.api.signalShutdown();
await sleep(300);
run = boot(cfg(IPP), JSON.parse(JSON.stringify(serialized)));
hap = run.hap;
await sleep(1500);
const reused = run.all.find((a) => a.UUID === legacyUuid);
ok(run.all.length === 3 && run.unregistered.length === 0 && reused && reused.services.filter((x) => x.UUID === hap.Service.Switch.UUID).length === 1,
  'upgrade: existing "Printer Online" accessory from 2.1.0 is kept (rooms/automations survive), not duplicated');
ok(reused && reused.getService(hap.Service.Switch).getCharacteristic(hap.Characteristic.On).value === true, 'upgrade: kept Online switch is ON');
const sensor2 = run.all.find((a) => a.displayName === 'My Printer');
const inks2 = sensor2.services.filter((s) => s.UUID === hap.Service.FilterMaintenance.UUID);
ok(inks2.length === 2, 'restart: no duplicate ink services');
ok(sensor2.services.filter((s) => s.UUID === hap.Service.ContactSensor.UUID).length === 1, 'restart: single contact sensor');
await bridgeCheck(hap, run.all, 'restored');
const serialized2 = run.all.map((a) => PlatformAccessory.serialize(a));
run.api.signalShutdown();
await sleep(300);

// ---------------------------------------------------------------- phase 4: printer switched off, restart from cache
run = boot({ ...cfg(OFFLINE_ADDR), dashboard: { enabled: true, port: 8588 } }, JSON.parse(JSON.stringify(serialized2)));
hap = run.hap;
await sleep(1500);
const st4 = await (await fetch('http://127.0.0.1:8588/api/status')).json();
ok(st4.printers[0].status === 'offline' && st4.printers[0].markers.length === 2, 'offline after restart: dashboard keeps last known ink levels');
const sensor3 = run.all.find((a) => a.displayName === 'My Printer');
const c3 = sensor3.getService(hap.Service.ContactSensor);
ok(c3.getCharacteristic(C.StatusActive).value === false, 'offline: StatusActive=false');
ok(c3.getCharacteristic(C.StatusFault).value === 1, 'offline: StatusFault=GENERAL_FAULT');
ok(run.all.find((a) => /Printing/.test(a.displayName)).getService(hap.Service.Switch).getCharacteristic(C.On).value === false, 'offline: Printing switch Off');
ok(run.all.find((a) => /Online/.test(a.displayName)).getService(hap.Service.Switch).getCharacteristic(C.On).value === false, 'offline: Online switch Off');
if (process.env.HOLD_OFFLINE) {
  console.log('HOLD: offline state ready for screenshots');
  await sleep(Number(process.env.HOLD_OFFLINE));
}
await bridgeCheck(hap, run.all, 'offline');

run.api.signalShutdown();
await sleep(300);

// ---------------------------------------------------------------- phase 5: only an address (.local), no name
if (process.env.LOCAL_ADDR) {
  run = boot({ platform: 'HPPrinter', printers: [{ address: process.env.LOCAL_ADDR }], dashboard: { enabled: true, port: 8589 } });
  hap = run.hap;
  await sleep(4000);
  const named = run.all.find((a) => a.displayName === 'Printer');
  ok(!!named, `address-only config creates an accessory called "Printer" (${run.all.map((a) => a.displayName).join(', ')})`);
  ok(named && named.getService(hap.Service.ContactSensor).getCharacteristic(C.StatusActive).value === true, `printer reached via ${process.env.LOCAL_ADDR}`);
  ok(named && named.services.filter((x) => x.UUID === hap.Service.FilterMaintenance.UUID).length === 2, 'ink tiles created via .local address');
}

ok(run.warnings.length === 0, `no HAP characteristic warnings${run.warnings.length ? ': ' + run.warnings.join(' | ') : ''}`);
run.api.signalShutdown();


// ---------------------------------------------------------------- phase 6: each switch can be turned off
for (const [opts, want] of [
  [{ onlineSwitch: false }, ['Solo', 'Solo Printing']],
  [{ printingSwitch: false }, ['Solo', 'Solo Online']],
  [{ onlineSwitch: false, printingSwitch: false }, ['Solo']],
  [{ switchType: 'NONE' }, ['Solo']],
  [{ switchType: 'SWITCH' }, ['Solo', 'Solo Online', 'Solo Printing']],
]) {
  run = boot({ platform: 'HPPrinter', printers: [{ name: 'Solo', address: IPP, ...opts }], dashboard: { enabled: false } });
  const names = run.all.map((a) => a.displayName).sort();
  ok(JSON.stringify(names) === JSON.stringify(want), `options ${JSON.stringify(opts)} -> ${names.join(', ')}`);
  run.api.signalShutdown();
  await sleep(200);
}

console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASSED'}`);
setTimeout(() => process.exit(failures ? 1 : 0), 300);
