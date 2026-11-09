import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { PrinterPlatform } from './platform.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('matter only', () => {
  it('saves the last ink levels through a temporary file', () => {
    vi.useFakeTimers()
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-printer-state-'))
    const platform = Object.create(PrinterPlatform.prototype)
    Object.assign(platform, {
      api: {
        user: {
          storagePath: () => storage,
        },
      },
      log: {
        debug() {},
        info() {},
        warn() {},
      },
    })
    const poller = Object.assign(new EventEmitter(), { state: {} })
    const rename = vi.spyOn(fs, 'renameSync')

    platform.seedFromFile({ id: 'abc', name: 'Study' }, poller)
    poller.emit('update', {
      markers: [
        { name: 'Black', level: 50 },
      ],
      model: 'DeskJet',
      lastSeen: null,
    })
    vi.advanceTimersByTime(2500)

    const file = path.join(storage, 'hp-printer', 'state-abc.json')
    expect(rename).toHaveBeenCalledWith(`${file}.tmp`, file)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).markers).toHaveLength(1)
  })
})
