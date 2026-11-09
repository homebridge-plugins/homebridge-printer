/**
 * Runs the plugin inside Homebridge's own API and HAP, from the homebridge dev dependency.
 * Homebridge only exports its public types, so its classes are loaded by file path.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import plugin from '../lib/index.js'

const dist = file => new URL(`../node_modules/homebridge/dist/${file}`, import.meta.url).href
const hapDist = file => new URL(`../node_modules/@homebridge/hap-nodejs/dist/${file}`, import.meta.url).href

let HomebridgeAPI
let User
let IdentifierCache
let PlatformAccessory

/** Homebridge's own classes, once loaded, for tests that make accessories themselves. */
export const homebridge = {}

/** Loads Homebridge's classes. Call it from beforeAll before anything else here. */
export async function loadHomebridge() {
  const [api, accessory, user, cache] = await Promise.all([
    import(dist('api.js')),
    import(dist('platformAccessory.js')),
    import(dist('user.js')),
    import(hapDist('lib/model/IdentifierCache.js')),
  ])
  HomebridgeAPI = api.HomebridgeAPI
  PlatformAccessory = accessory.PlatformAccessory
  User = user.User
  IdentifierCache = cache.IdentifierCache
  homebridge.PlatformAccessory = PlatformAccessory
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function useStorage() {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-printer-'))
  User.setStoragePath(storage)
  return storage
}

/** A log that keeps every line, so tests can look for messages. */
export function createLog() {
  const lines = []
  const keep
    = level =>
      (...a) =>
        lines.push(`[${level}] ${a.join(' ')}`)
  return {
    lines,
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
    success: keep('info'),
    debug: () => {},
  }
}

/**
 * Starts the plugin's platform with a config. `cached` are serialised accessories, as
 * Homebridge restores them; `setup(api)` can add a Matter API or change the version, and
 * `restore(platform)` hands over cached Matter accessories.
 */
export function boot(config, { cached = [], setup, restore } = {}) {
  const api = new HomebridgeAPI()
  let Platform
  const names = {}
  api.registerPlatform = (pluginName, platformName, constructor) => {
    Object.assign(names, { pluginName, platformName })
    Platform = constructor
  }
  plugin(api)

  const registered = []
  const unregistered = []
  const warnings = []
  api.registerPlatformAccessories = (pluginName, platformName, accessories) => {
    for (const a of accessories) {
      a._associatedPlugin = pluginName
      a._associatedPlatform = platformName
      registered.push(a)
    }
  }
  api.unregisterPlatformAccessories = (pluginName, platformName, accessories) => unregistered.push(...accessories)
  api.updatePlatformAccessories = () => {}
  setup?.(api)

  const log = createLog()
  const platform = new Platform(log, config, api)
  const restored = cached.map(s => PlatformAccessory.deserialize(s))
  for (const a of restored) {
    platform.configureAccessory(a)
  }
  // Homebridge hands over cached accessories before it says it has finished launching
  restore?.(platform)

  api.signalFinished()
  const all = [
    ...restored,
    ...registered,
  ]
  for (const a of all) {
    a._associatedHAPAccessory.on('characteristic-warning', w => warnings.push(`${a.displayName}: ${w.message}`))
  }
  return {
    api,
    hap: api.hap,
    platform,
    all,
    registered,
    unregistered,
    warnings,
    log,
    names,
  }
}

export function serialise(accessories) {
  return JSON.parse(JSON.stringify(accessories.map(a => PlatformAccessory.serialize(a))))
}

/** Puts the accessories on a HAP bridge and asks for them as a Home hub would. */
export async function asHomeHubSeesIt(hap, accessories) {
  const bridge = new hap.Bridge('Test Bridge', hap.uuid.generate(`test-bridge-${Math.random()}`))
  bridge.addBridgedAccessories(accessories.map(a => a._associatedHAPAccessory))
  bridge._identifierCache = Object.assign(new IdentifierCache('AA:BB:CC:DD:EE:FF'), {
    save() {},
  })
  const json = bridge.internalHAPRepresentation(true)
  const connection = {
    username: 'test',
    remoteAddress: '127.0.0.1',
    sessionID: 'x',
    on() {},
    removeListener() {},
  }
  const full = await bridge.toHAP(connection, true)
  for (const a of accessories) {
    bridge.removeBridgedAccessory(a._associatedHAPAccessory, true)
  }
  return { count: json.length - 1, full }
}
