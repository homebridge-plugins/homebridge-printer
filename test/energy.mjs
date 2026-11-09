// Energy-over-Matter test: runs the plugin inside the real Homebridge API (HAP side) with a
// stand-in api.matter that enforces Homebridge 2.4's Matter rules (see src/matter/MatterAPIImpl.ts):
//   required fields, known cluster names, no state updates before registration,
//   registration refused while the Matter server is starting, cached-accessory restore.
// The real matter.js library isn't available offline, so the Matter wire protocol isn't exercised.
//
//   HB_DIR=/root/hb IPP_ADDR=127.0.0.1:8631 PRINT_CMD='…' node test/energy.mjs

import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HB = process.env.HB_DIR;
const IPP = process.env.IPP_ADDR || '127.0.0.1:8631';
const { HomebridgeAPI } = await import(join(HB, 'dist/api.js'));
const { User } = await import(join(HB, 'dist/user.js'));
const { Logger } = await import(join(HB, 'dist/logger.js'));
const storage = mkdtempSync(join(tmpdir(), 'hbenergy-'));
User.setStoragePath(storage);

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLUSTERS = 'onOff levelControl colorControl doorLock windowCovering thermostat fanControl airQuality carbonMonoxideConcentrationMeasurement nitrogenDioxideConcentrationMeasurement ozoneConcentrationMeasurement pm10ConcentrationMeasurement pm25ConcentrationMeasurement temperatureMeasurement relativeHumidityMeasurement illuminanceMeasurement occupancySensing booleanState smokeCoAlarm rvcRunMode rvcOperationalState rvcCleanMode serviceArea powerSource pumpConfigurationAndControl valveConfigurationAndControl closureControl mediaPlayback keypadInput identify switch electricalPowerMeasurement electricalEnergyMeasurement basicInformation bridgedDeviceBasicInformation'.split(' ');

function makeMatter(api, { startingRefusals = 1 } = {}) {
  const registered = new Map();
  const log = { updates: [], errors: [], registerCalls: 0, unregistered: [] };
  let refusals = startingRefusals;
  const matter = {
    uuid: api.hap.uuid,
    deviceTypes: { OnOffOutlet: { name: 'OnOffPlugInUnitDevice' }, OnOffLight: { name: 'OnOffLightDevice' }, BridgedNode: { name: 'BridgedNodeEndpoint' } },
    async registerPlatformAccessories(plugin, platform, accs) {
      log.registerCalls++;
      if (refusals-- > 0) throw new Error(`${plugin}: Cannot register Matter accessories yet — the Matter server for this bridge is still starting.`);
      for (const a of accs) {
        for (const f of ['UUID', 'displayName', 'deviceType', 'manufacturer', 'model', 'serialNumber']) {
          if (!a[f]) log.errors.push(`missing ${f}`);
        }
        for (const f of ['displayName', 'model', 'manufacturer', 'serialNumber']) {
          if (String(a[f]).length > 32) log.errors.push(`${f} longer than 32 (Matter limit): ${a[f]}`);
        }
        for (const c of Object.keys(a.clusters || {})) if (!CLUSTERS.includes(c)) log.errors.push(`unknown cluster ${c}`);
        const parts = {};
        for (const part of a.parts || []) {
          if (!part.id || !part.deviceType || !part.clusters) log.errors.push('part missing id/deviceType/clusters');
          for (const c of Object.keys(part.clusters || {})) if (!CLUSTERS.includes(c)) log.errors.push(`unknown cluster ${c} on part ${part.id}`);
          parts[part.id] = JSON.parse(JSON.stringify(part.clusters));
        }
        if (!a.clusters && !(a.parts || []).length) log.errors.push('accessory has neither clusters nor parts');
        registered.set(a.UUID, { ...a, state: JSON.parse(JSON.stringify(a.clusters || {})), partState: parts });
      }
    },
    async unregisterPlatformAccessories(p, n, accs) { accs.forEach((a) => { registered.delete(a.UUID); log.unregistered.push(a.displayName); }); },
    async updatePlatformAccessories() {},
    async updateAccessoryState(uuid, cluster, attrs, partId) {
      const a = registered.get(uuid);
      if (!a) { log.errors.push(`update before registration: ${cluster}`); throw new Error('not registered'); }
      if (!CLUSTERS.includes(cluster)) log.errors.push(`unknown cluster ${cluster}`);
      const target = partId ? a.partState[partId] : a.state;
      if (!target) { log.errors.push(`unknown part ${partId}`); throw new Error('no part'); }
      if (!(cluster in target)) log.errors.push(`update to cluster ${cluster} not declared on ${partId || 'accessory'}`);
      Object.assign((target[cluster] = target[cluster] || {}), attrs);
      log.updates.push({ cluster, attrs });
    },
    async getAccessoryState(uuid, cluster, partId) { const a = registered.get(uuid); return partId ? a?.partState[partId]?.[cluster] : a?.state[cluster]; },
    status: {},
  };
  return { matter, registered, log };
}

const plugin = require(resolve('index.js'));
function boot(config, { matterOn = true, version, startingRefusals } = {}) {
  const api = new HomebridgeAPI();
  let Ctor;
  api.registerPlatform = (id, name, c) => { Ctor = c; };
  plugin(api);
  const hapAccs = [];
  api.registerPlatformAccessories = (p, n, accs) => hapAccs.push(...accs);
  const hapRemoved = [];
  api.unregisterPlatformAccessories = (p, n, accs) => hapRemoved.push(...accs);
  api.updatePlatformAccessories = () => {};
  const m = makeMatter(api, { startingRefusals });
  if (matterOn) Object.defineProperty(api, 'matter', { value: m.matter, configurable: true });
  api.isMatterEnabled = () => matterOn;
  if (version) {
    Object.defineProperty(api, 'serverVersion', { value: version, configurable: true });
    api.versionGreaterOrEqual = (v) => v.split('.').map(Number).reduce((acc, n, i) => acc ?? (Number(version.split('.')[i]) > n ? true : Number(version.split('.')[i]) < n ? false : null), null) ?? true;
  }
  const lines = [];
  const log = Logger.withPrefix('HPPrinter');
  const tap = { info: (...a) => { lines.push(a.join(' ')); log.info(...a); }, warn: (...a) => { lines.push(a.join(' ')); log.warn(...a); }, error: (...a) => log.error(...a), debug: () => {}, success: (...a) => log.info(...a) };
  const platform = new Ctor(tap, config, api);
  return { api, platform, m, lines, hapAccs, hapRemoved, cacheRestore: (accs) => accs.forEach((a) => platform.configureMatterAccessory(a)) };
}

const cfg = (extra = {}) => ({ platform: 'HPPrinter', printers: [{ name: 'Study', address: IPP, polling: 3, ...extra }], dashboard: { enabled: true, port: 8590 } });

console.log(`\n== Homebridge ${new HomebridgeAPI().serverVersion}, Node ${process.version}`);

// ---- 1: Matter on, register (first attempt refused while starting -> retried)
let run = boot(cfg());
run.api.signalFinished();
await sleep(1500);
ok(run.m.log.registerCalls === 1 && run.m.registered.size === 0, 'first registration refused while Matter starts (as Homebridge does)');
await sleep(10500);
ok(run.m.log.registerCalls === 2 && run.m.registered.size === 1, 'plugin retries and registers the energy accessory');
const acc = [...run.m.registered.values()][0];
ok(acc && acc.displayName === 'Study Online' && acc.deviceType.name === 'BridgedNodeEndpoint' && acc.parts.length === 1 && acc.parts[0].deviceType.name === 'OnOffPlugInUnitDevice',
  `one combined "${acc && acc.displayName}": BridgedNode parent with one outlet part (the shape Apple shows tile watts for)`);
ok(!run.hapAccs.some((a) => a.displayName === 'Study Online') && run.hapAccs.some((a) => a.displayName === 'Study Printing'), `no separate HomeKit Online switch (HomeKit: ${run.hapAccs.map((a) => a.displayName).join(', ')})`);
ok(acc && 'electricalPowerMeasurement' in acc.parts[0].clusters && acc.parts[0].clusters.electricalEnergyMeasurement.cumulativeEnergyImported && 'onOff' in acc.parts[0].clusters, 'outlet part declares on/off + power + cumulative energy');
ok(run.m.log.errors.length === 0, `no Matter rule violations${run.m.log.errors.length ? ': ' + run.m.log.errors.join('; ') : ''}`);
ok(run.lines.some((l) => /Matter: "Study Online" is published with energy/.test(l)), 'log says the outlet is published with energy');

// idle (ready) power, after state settles
await sleep(11000);
let st = await run.m.matter.getAccessoryState(acc.UUID, 'electricalPowerMeasurement', 'outlet');
ok(st && st.activePower === 2800, `idle printer -> 2.8 W (activePower ${st && st.activePower} mW)`);
ok((await run.m.matter.getAccessoryState(acc.UUID, 'onOff', 'outlet')).onOff === true, 'outlet ON while printer is online');

// printing
if (process.env.PRINT_CMD) {
  execFileSync('sh', ['-c', process.env.PRINT_CMD], { stdio: 'ignore' });
  await sleep(4000);
  st = await run.m.matter.getAccessoryState(acc.UUID, 'electricalPowerMeasurement', 'outlet');
  ok(st.activePower === 10000, `printing -> 10 W (activePower ${st.activePower} mW)`);
  const dash = await (await fetch('http://127.0.0.1:8590/api/status')).json();
  ok(dash.printers[0].energy && dash.printers[0].energy.state === 'printing' && dash.printers[0].energy.watts === 10, `dashboard shows estimate: ${JSON.stringify(dash.printers[0].energy)}`);
  await sleep(10000);
  st = await run.m.matter.getAccessoryState(acc.UUID, 'electricalPowerMeasurement', 'outlet');
  ok(st.activePower === 2800, 'job done -> back to 2.8 W');
}

// tap the outlet in Home -> snaps back
await acc.parts[0].handlers.onOff.off();
await run.m.matter.updateAccessoryState(acc.UUID, 'onOff', { onOff: false }, 'outlet'); // what Homebridge does after the handler
await sleep(1200);
ok((await run.m.matter.getAccessoryState(acc.UUID, 'onOff', 'outlet')).onOff === true, 'tapping the outlet off in Home snaps back to on');

// energy total grows and is saved
const entry0 = run.platform.energy.entries[0];
entry0.meter.tick(entry0.poller.state);
entry0.meter.lastTick = Date.now();
run.platform.energy.pushEnergy(entry0);
await sleep(100);
const energyBefore = (await run.m.matter.getAccessoryState(acc.UUID, 'electricalEnergyMeasurement', 'outlet')).cumulativeEnergyImported.energy;
entry0.meter.tick(entry0.poller.state, entry0.meter.lastTick + 10 * 60 * 1000); // pretend 10 min pass
run.platform.energy.pushEnergy(run.platform.energy.entries[0]);
await sleep(100);
const energyAfter = (await run.m.matter.getAccessoryState(acc.UUID, 'electricalEnergyMeasurement', 'outlet')).cumulativeEnergyImported.energy;
ok(energyAfter > energyBefore && energyAfter - energyBefore >= 460 && energyAfter - energyBefore <= 480, `10 min idle at 2.8 W adds ~467 mWh (${energyBefore} -> ${energyAfter})`);
run.api.signalShutdown();
await sleep(300);
const file = join(storage, 'hp-printer', `energy-${run.platform.devices[0].id}.json`);
const saved = existsSync(file) && JSON.parse(readFileSync(file, 'utf8'));
ok(saved && saved.totalMWh >= energyAfter, `running total saved on shutdown (${saved && saved.totalMWh} mWh)`);

// ---- 2: restart: total continues, cached accessory reused, no duplicates
run = boot(cfg(), { startingRefusals: 0 });
// also restore the flat outlet that 2.6.0 published, which should be removed
const flat = { UUID: run.api.hap.uuid.generate('hp-printer:Study:energy'), displayName: 'Study Online', deviceType: { name: 'OnOffPlugInUnitDevice' } };
run.cacheRestore([{ ...acc, parts: acc.parts.map((p) => ({ ...p, handlers: undefined })) }, flat]);
run.api.signalFinished();
await sleep(1500);
ok(run.m.log.unregistered.includes('Study Online') && !run.m.registered.has(flat.UUID), 'upgrade: the flat 2.6.0 outlet is removed');
const acc2 = [...run.m.registered.values()][0];
ok(run.m.registered.size === 1 && acc2.UUID === acc.UUID, 'restart: same energy accessory re-registered (keeps its place in Home)');
ok(acc2.parts[0].clusters.electricalEnergyMeasurement.cumulativeEnergyImported.energy >= saved.totalMWh, 'restart: total carries on from the saved value');
run.api.signalShutdown();
await sleep(300);

// ---- 3: energy turned off -> cached accessory removed
run = boot(cfg({ energy: { enabled: false } }), { startingRefusals: 0 });
run.cacheRestore([{ ...acc, handlers: undefined }]);
run.api.signalFinished();
await sleep(1500);
ok(run.m.registered.size === 0, 'energy turned off: nothing published');
run.api.signalShutdown();
await sleep(300);

// ---- 4: Matter not turned on -> clear log message, dashboard still has the estimate, no crash
run = boot(cfg(), { matterOn: false });
run.api.signalFinished();
await sleep(1500);
ok(run.lines.some((l) => /Energy in Apple Home is off: Matter is not turned on.*Settings → Matter Settings/.test(l)), 'Matter off: log explains how to turn it on');
const dash4 = await (await fetch('http://127.0.0.1:8590/api/status')).json();
ok(dash4.printers[0].energy && dash4.printers[0].energy.estimated, 'Matter off: dashboard still shows the estimate');
ok(run.hapAccs.some((a) => a.displayName === 'Study Online'), 'Matter off: the regular HomeKit "Study Online" switch is used instead');
run.api.signalShutdown();
await sleep(300);

// ---- 5: old Homebridge -> message, nothing published
run = boot(cfg(), { version: '2.2.1' });
run.api.signalFinished();
await sleep(800);
ok(run.lines.some((l) => /needs Homebridge 2\.3\.0 or newer \(this is 2\.2\.1\)/.test(l)) && run.m.registered.size === 0, 'Homebridge 2.2: log says 2.3.0+ is needed, nothing published');
run.api.signalShutdown();


// ---- 7: Switch 1 turned off -> energy-only outlet "Study Energy"
run = boot(cfg({ onlineSwitch: false }), { startingRefusals: 0 });
run.api.signalFinished();
await sleep(1500);
const acc7 = [...run.m.registered.values()][0];
ok(acc7 && acc7.displayName === 'Study Energy' && !run.hapAccs.some((a) => /Online/.test(a.displayName)), `Switch 1 off: outlet is called "${acc7 && acc7.displayName}", no Online switch`);
run.api.signalShutdown();
await sleep(300);

// ---- 8: Matter only
const { PlatformAccessory } = await import(join(HB, 'dist/platformAccessory.js'));
run = boot({ ...cfg(), matterOnly: true }, { startingRefusals: 0 });
// pretend the HomeKit accessories from before are cached
const oldHap = new PlatformAccessory('Study', run.api.hap.uuid.generate('hp-printer:Study'));
run.platform.configureAccessory(oldHap);
run.api.signalFinished();
await sleep(1800);
const regs = [...run.m.registered.values()];
const onl = regs.find((a) => a.displayName === 'Study Online');
const prt = regs.find((a) => a.displayName === 'Study Printing');
ok(run.hapAccs.length === 0, `Matter only: no HomeKit accessories created (${run.hapAccs.map((a) => a.displayName).join(', ') || 'none'})`);
ok(run.hapRemoved.some((a) => a.displayName === 'Study'), 'Matter only: the old HomeKit accessories are removed');
ok(onl && 'electricalPowerMeasurement' in onl.parts[0].clusters, 'Matter only: "Study Online" outlet with energy');
ok(prt && prt.parts[0].deviceType.name === 'OnOffPlugInUnitDevice' && !('electricalPowerMeasurement' in prt.parts[0].clusters), 'Matter only: "Study Printing" outlet (no energy on it)');
ok(run.m.log.errors.length === 0, `Matter only: no Matter rule violations${run.m.log.errors.length ? ': ' + run.m.log.errors.join('; ') : ''}`);
await sleep(3500);
ok((await run.m.matter.getAccessoryState(prt.UUID, 'onOff', 'outlet')).onOff === false, 'Matter only: Printing outlet OFF while idle');
if (process.env.PRINT_CMD) {
  execFileSync('sh', ['-c', process.env.PRINT_CMD], { stdio: 'ignore' });
  await sleep(4000);
  ok((await run.m.matter.getAccessoryState(prt.UUID, 'onOff', 'outlet')).onOff === true, 'Matter only: Printing outlet ON while a job prints');
  await sleep(10000);
  ok((await run.m.matter.getAccessoryState(prt.UUID, 'onOff', 'outlet')).onOff === false, 'Matter only: Printing outlet OFF when the job finishes');
}
const stateFile = join(storage, 'hp-printer', `state-${run.platform.devices[0].id}.json`);
ok(existsSync(stateFile) && JSON.parse(readFileSync(stateFile, 'utf8')).markers.length === 2, 'Matter only: ink levels saved for when the printer is off');
run.api.signalShutdown();
await sleep(300);

// ---- 9: Matter only, energy off -> plain Online outlet
run = boot({ ...cfg({ energy: { enabled: false } }), matterOnly: true }, { startingRefusals: 0 });
run.api.signalFinished();
await sleep(1500);
const onl9 = [...run.m.registered.values()].find((a) => a.displayName === 'Study Online');
ok(onl9 && !('electricalPowerMeasurement' in onl9.parts[0].clusters) && run.m.registered.size === 2, 'Matter only + energy off: Online outlet without energy, plus Printing');
run.api.signalShutdown();
await sleep(300);

// ---- 10: Matter only requested but Matter not on -> HomeKit kept, warning
run = boot({ ...cfg(), matterOnly: true }, { matterOn: false });
run.api.signalFinished();
await sleep(1200);
ok(run.hapAccs.some((a) => a.displayName === 'Study') && run.lines.some((l) => /"Matter only" is turned on, but Matter is not turned on/.test(l)), 'Matter only without Matter: HomeKit accessories kept, log explains');
run.api.signalShutdown();
await sleep(300);

// ---- 6: custom wattages
const { normaliseEnergyConfig, powerState } = require(resolve('src/energy.js'));
const c6 = normaliseEnergyConfig({ energy: { printingWatts: 18, readyWatts: '3.5', sleepWatts: '', offWatts: 0 } });
ok(c6.watts.printing === 18 && c6.watts.ready === 3.5 && c6.watts.sleep === 1.4 && c6.watts.off === 0, `custom wattages read correctly: ${JSON.stringify(c6.watts)}`);
const t0 = 1e12;
ok(powerState({ online: true, status: 'idle' }, t0, t0 + 6 * 60000, 5) === 'sleep', 'idle for 6 min (sleep after 5) -> sleep watts');
ok(powerState({ online: false }, null, t0, 5) === 'off', 'unreachable -> off watts');

console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASSED'}`);
setTimeout(() => process.exit(failures ? 1 : 0), 300);
