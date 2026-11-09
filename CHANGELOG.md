# Changelog

## 2.7.0

- **Matter only** setting (Settings → Apple Home connection): the printer is published over Matter alone.
  Printer Online (with energy) and Printer Printing become Matter outlets, and this plugin's HomeKit accessories are
  removed. Ink levels stay on the dashboard (Apple Home has no Matter ink tile) and are remembered while the printer is off.
  Only applied when Matter is available; otherwise the HomeKit accessories are kept and the log explains.

## 2.6.1

- Watts now show on the Printer Online tile: the Matter outlet is published as a device with an outlet part
  (the shape certified plugs use) instead of a bare outlet, which Apple Home only showed watts for in the
  accessory's details. The outlet is re-created once: put it back in its room and automations.

## 2.6.0

- Printer Online and energy are now one accessory: with Matter on, **Printer Online** is a Matter outlet that is
  on while the printer is reachable and shows its power and kWh. The separate HomeKit Online switch is used only
  when Matter isn't available. With Switch 1 off, the outlet is called **Printer Energy**.
- Settings and dashboard no longer label energy as "estimated" (the settings still explain how it's worked out).

## 2.5.1

- Energy setup no longer needs a child bridge: the log and docs now point to Settings → Matter Settings
  (Matter on the main bridge). Child bridges still work.

## 2.5.0

- **Energy in Apple Home (estimated)**: on Homebridge 2.3+ with Matter turned on, each printer gets a
  "Printer Energy" Matter outlet with estimated watts and a running kWh total, for the iOS 27 Home app's
  Electricity view. Wattages per state (printing, ready, sleep, off) can be set in Settings; defaults are
  HP's DeskJet 2800 series figures. The total is saved and carries on across restarts.
- The dashboard shows the estimate too ("≈ 2.8 W now · 0.12 kWh since …").
- Fix: Eve "Last Activation" could be sent as NaN right after the history file was created.

## 2.4.0

- Settings page in the Homebridge UI is back, on top of the regular settings form:
  live dashboard with ink levels, **Find printers on my network** (click Add to fill in the address),
  **Test connection**, and a link to the full-screen dashboard.
- Works on a brand-new install: the page creates a starting config so the settings form always appears.
- The page's helper has no extra dependencies, so it always starts.

## 2.3.0

- Two switches, each can be turned on/off in Settings:
  - Switch 1 **Printer Online**: on while the printer is switched on and reachable (the switch from 2.1.0 is back;
    if you still have it in Home it is kept with its room and automations).
  - Switch 2 **Printer Printing**: on only while a job is printing.
- Settings: the "Online indicator" drop-down is replaced by these two tick boxes. Older `switchType` settings still work.

## 2.2.0

- The "Online" switch is replaced by a **Printing** switch ("Printer Printing") that is on only while a print job
  is actually printing. Warm-up and head cleaning without a job don't count. The old switch is removed automatically.
- Faster reaction: checks every 5 seconds by default, and every 2 seconds while printing.
- "printing started" / "printing finished" lines in the Homebridge log.

## 2.1.0

- Settings now use Homebridge's built-in settings form, so they always open: only the printer's IP address or .local name is required, the name is optional.
- `.local` printer names resolve even where the system can't resolve them (built-in mDNS fallback).
- Dashboard link shown at the top of the Settings page.

## 2.0.0

Forked from homebridge-printer 1.1.1 and rewritten.

- Homebridge 2.x support (fixes seydx/homebridge-printer#26), still works on Homebridge 1.8+.
- Live dashboard at `http://<host>:8587/`.
- Ink tiles now raise a "replace" alert below a configurable threshold; HP tri-colour cartridges shown as three colours.
- Fault/active status on the printing sensor (offline, stopped, jam, door open).
- Address can be an IP or hostname; `/ipp/print` vs `/ipp/printer` and IPPS are detected automatically.
- Last-known ink levels survive restarts while the printer is off.
- Online switch now actually updates (the old code looked it up by the wrong name).
- Replaced `@sealsystems/ipp` and `moment` with a built-in IPP client.
