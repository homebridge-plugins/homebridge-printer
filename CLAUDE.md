# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Homebridge dynamic platform that shows network printers (made for HP, works with most AirPrint/IPP printers) in Apple Home: printing and online switches, a printing sensor with fault status, ink tiles, Eve history, and estimated energy over Matter. It only reads from the printers. Written in JavaScript (ES modules), no build step. A rewrite of SeydX's homebridge-printer (MIT - keep his notice in LICENSE).

## Commands

- **Lint**: `npm run lint` (eslint with zero warnings allowed)
- **Lint + fix**: `npm run lint:fix`
- **Test**: `npm test` (vitest, about 90 seconds - the Matter energy tests wait on real timers)

CI runs lint, then the tests on Node 22, 24 and 26.

## Code Style

Uses `@antfu/eslint-config` with these key rules:
- Single quotes, no semicolons, 1tbs brace style
- Sorted imports/exports via `perfectionist`
- Node globals imported from `node:` modules (`Buffer`, `process`)
- Zero warnings tolerance (`--max-warnings=0`)

## Architecture

- `lib/index.js` registers `PrinterPlatform` (`lib/platform.js`) under the alias "Printer".
- `lib/platform.js`: reads the config (also the old `printer` array and `switchType` from SeydX's plugin), makes the HomeKit accessories, starts a poller per printer, the dashboard and the Matter energy publisher.
- `lib/ipp.js`: a small IPP client (Get-Printer-Attributes only). It tries `/ipp/print`, `/ipp/printer` and `/ipp`, moves to IPPS on HTTP 426, and resolves `.local` names over mDNS itself when the system can't.
- `lib/poller.js`: polls a printer and emits `update`. Printing means "processing" with a job queued, so head cleaning doesn't count.
- `lib/accessories.js`: the HAP accessories. Switches are report-only: a tap is put back.
- `lib/energy.js`: estimates watts from the printer's state (per-state wattages) and publishes a Matter outlet per printer, shaped as a BridgedNode with an outlet part so Apple shows watts on the tile. It registers on every start, because Homebridge restores cached Matter accessories with empty handlers.
- `lib/discovery.js`: finds printers with mDNS for the settings page.
- `lib/dashboard-server.js`: the dashboard and its JSON/server-sent-events API on port 8587.
- `lib/homebridge-ui/`: the Homebridge UI page (`server.js` uses `@homebridge/plugin-ui-utils`; `public/dashboard.js` is shared with the standalone dashboard).
- `lib/fakegato/`: the org's shared copy of fakegato-history, the same as in ewelink, govee, meross and wemo. Fix bugs in all of them.

Files are kept in `<storage>/hp-printer/` (energy totals, and ink levels in Matter-only mode). The folder name is kept from the plugin's earlier name.

## Tests

- `lib/*.test.js`: unit tests next to the code
- `test/e2e.test.js` and `test/energy.test.js`: the plugin inside Homebridge's own API and HAP (loaded by file path from the `homebridge` dev dependency, in `test/harness.js`) against a pretend printer (`test/fake-ipp-printer.js`). The energy tests use a stand-in Matter API that restores cached accessories the way Homebridge does.
- `test/config-schema.test.js`: keeps `config.schema.json` valid for the Homebridge UI and Homebridge verification
