# homebridge-myalarmcom

[![Tests](https://github.com/tbaur/homebridge-myalarmcom/actions/workflows/test.yml/badge.svg)](https://github.com/tbaur/homebridge-myalarmcom/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/homebridge-myalarmcom?style=flat-square)](https://www.npmjs.com/package/homebridge-myalarmcom)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-myalarmcom?style=flat-square)](https://www.npmjs.com/package/homebridge-myalarmcom)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)
[![Homebridge](https://img.shields.io/badge/homebridge-%3E%3D1.6.0%20%7C%7C%202.x-purple)](https://homebridge.io)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Expose your [Alarm.com](https://www.alarm.com) security panel and sensors in Apple HomeKit through Homebridge.

## Features

### Device Support

- **Security System** — Panel arm / disarm, including a true triggered-alarm state
- **Contact Sensors** — Doors, windows, and garage door position
- **Motion Sensors** — Motion detected / clear
- **Smoke Sensors** — Smoke detector state
- **Night-Arming Detection** — Night arming is offered only when the panel advertises an `ArmedNight` mode
- **Read-Only Accounts** — Warns when the Alarm.com account used cannot change arming state, and exposes the panel as read-only in HomeKit

### Reliability

- **Real-Time Updates** — Push events over WebSocket (on by default), with polling as a safety net
- **Session Keepalive** — Holds an established session open instead of logging in repeatedly
- **Paced Requests** — One request per second and 60 per minute, with hard floors on the poll and re-auth intervals; Alarm.com locks accounts that misbehave
- **Circuit Breaker** — Fails fast during sustained outages rather than retrying into a wall
- **Hourly Rediscovery** — Sensors added or removed at the panel show up without a Homebridge restart
- **Fail-Closed Mapping** — An unrecognised panel state keeps the previous tile and raises a fault rather than showing a safe-looking "disarmed"; an unrecognised sensor state is cross-checked against Alarm.com's normalised open/closed reading and the ambiguity is logged
- **Diagnostics** *(optional)* — Opt-in health/activity heartbeats, boot/shutdown snapshots, and healthy/degraded transitions in the Homebridge log

### Quality

- **Extensive Tests** — Jest suite gated at 95% statements and 87% branches, with a per-file floor for the platform; every test runs against captured fixtures and none touches the network
- **Enforced Failure Visibility** — A sustained outage escalates from debug to a warning and pairs with a "reachable again" line, so stale HomeKit state is never silent. Each distinct problem is reported once rather than on every poll
- **Strict TypeScript** — `strict`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, and unused-symbol checks; linting is type-aware across every source and test file, so unchecked values and floating promises are errors
- **Secret Hygiene** — Passwords, session cookies, and the two-factor cookie are redacted from every log line, including values passed as log parameters
- **No Analytics** — Zero tracking or data collection

## Quick Start

### 1. Install

**Homebridge UI** (recommended): Plugins → Search `myalarmcom` → Install

**Command line:**

```bash
npm install -g homebridge-myalarmcom
```

### 2. Get credentials

You need your Alarm.com username, password, and — if two-factor is enabled (it should be) — the `twoFactorAuthenticationId` browser cookie. That is a long cookie value, not a six-digit authenticator code.

How to capture it, and why to treat it like a password: [docs/AUTH.md](https://github.com/tbaur/homebridge-myalarmcom/blob/main/docs/AUTH.md).

Prefer a dedicated Alarm.com login for this plugin, with only the permissions you need.

### 3. Configure

Use the Homebridge UI, or add the platform to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "MyAlarmCom",
      "name": "MyAlarmCom",
      "username": "you@example.com",
      "password": "your-alarm-dot-com-password",
      "twoFactorAuthenticationId": "the-cookie-value-you-copied"
    }
  ]
}
```

### 4. Restart Homebridge

Your panel and sensors appear in the Home app.

## Supported Devices

| Alarm.com device  | HomeKit accessory | Notes                                    |
| ----------------- | ----------------- | ---------------------------------------- |
| Partition (panel) | Security System   | Arm/disarm, plus a triggered-alarm state |
| Contact sensor    | Contact Sensor    | Doors, windows, garage door position     |
| Motion sensor     | Motion Sensor     |                                          |
| Smoke detector    | Smoke Sensor      |                                          |

Lights, locks, thermostats, garage door *openers*, cameras, and doorbells are not supported. They were left out deliberately rather than written blind against untested hardware.

## Configuration Options

`name` belongs to Homebridge, which uses it as the log prefix; this plugin never reads it. Everything else below is validated at startup.

Invalid configuration never takes the bridge down. A missing credential, a six-digit code pasted where the two-factor cookie belongs, or a whole cookie header pasted in place of one value is reported at error level and this platform stays inert — every other plugin on your bridge keeps running. Out-of-range intervals are clamped with a warning instead.

| Option                      | Default | Description                                                                      |
| --------------------------- | ------- | -------------------------------------------------------------------------------- |
| `name`                      | `MyAlarmCom` | Optional. Read by Homebridge as the log prefix; the plugin never reads it. |
| `username`                  | —       | **Required.** Alarm.com username, usually an email address.                      |
| `password`                  | —       | **Required.** Alarm.com password.                                                |
| `twoFactorAuthenticationId` | —       | Browser cookie from [docs/AUTH.md](https://github.com/tbaur/homebridge-myalarmcom/blob/main/docs/AUTH.md). Required when 2FA is enabled. |
| `pollIntervalSeconds`       | `60`    | Full state refresh interval. Clamped to `60`–`86400` (24h).                      |
| `authIntervalMinutes`       | `10`    | Session reuse before signing in again. Clamped to `10`–`1440` (24h).             |
| `useEventStream`            | `true`  | Subscribe to push events. Polling continues regardless.                          |
| `includeUnmonitoredSensors` | `false` | Expose sensors Alarm.com reports as unmonitored. They appear marked inactive in the Home app rather than looking normal, since an unsupervised sensor's state cannot be trusted. |
| `ignoredDeviceIds`          | `[]`    | Device IDs to leave out of HomeKit. Each ID is logged when its accessory is added, and is also the accessory's Serial Number in the Home app. |
| `diagnosticsInterval`       | `0`     | Seconds between health heartbeats in the log; `0` off, else `30`–`86400` (24h). At 30 that is ~2,880 lines/day; prefer `300`+. |
| `debug`                     | `false` | Verbose logging. **Also requires Homebridge Debug Mode** (the `-D` flag, or Settings → Homebridge Debug Mode in the UI) — Homebridge discards DEBUG lines otherwise, so this option alone produces no extra output. Credentials are redacted; device names and Alarm.com IDs are not. |

## Not Working?

Homebridge already tags each line with the plugin name (e.g. `[myalarmcom]`). API lines also carry a short request tag and a duration, like `[3f9c1e, 412ms]`. Every retry and every failure belonging to the same request shares one tag, which is how you tell which of a poll cycle's requests actually went wrong.

1. **`TwoFactorRequiredError`** — Cookie missing, expired, or for a different account. Capture a fresh one ([docs/AUTH.md](https://github.com/tbaur/homebridge-myalarmcom/blob/main/docs/AUTH.md)), then restart Homebridge; configuration is read once at startup.
2. **Rejected username or password** — Fix credentials before restarting repeatedly; Alarm.com locks accounts after failed sign-ins. The plugin will not retry a rejected credential on its own.
3. **Login form parse error** — Alarm.com changed its sign-in page; please open an issue.
4. **Sensor missing** — Check discovery logs: unsupported type, monitoring disabled (unless `includeUnmonitoredSensors`), or listed in `ignoredDeviceIds`.
5. **Panel is read-only / cannot arm** — The Alarm.com account used lacks permission to change arming state. Use a login that can arm/disarm, or keep it read-only for monitoring.
6. **`Alarm.com has failed N times in a row`** — A sustained outage. Nothing to do but wait; polling keeps retrying and a matching "reachable again" line follows. Alarm.com is being left alone deliberately in the meantime.
7. **`Circuit breaker CLOSED -> OPEN`** — Repeated failures, so requests are being refused locally for 30 seconds at a time. This protects your account from looking like a scraper, which Alarm.com locks accounts for.
8. **`Continuing with polling only`** — The push event stream gave up after repeated failures. State still updates, just on the poll interval instead of within a second or two. The stream is retried every 15 minutes.
9. **`did not reach <state>`** — An arming request was accepted but the panel never confirmed it, usually an open zone or a keypad abort. The tile falls back to the panel's real state after a minute.
10. **`reported an arming state this plugin does not recognise`** — The tile keeps its last known value and shows a fault rather than guessing. Please open an issue with the state number.

11. **`is now reporting as a <kind> sensor`** — An Alarm.com device ID is reporting a different hardware type than the accessory published for it. Its state is left alone rather than written to the wrong characteristic; restart Homebridge to republish it.
12. **`issued a new two-factor trust token`** — The configured `twoFactorAuthenticationId` was not accepted and Alarm.com handed back a different one. Requests still work for now; capture a fresh cookie ([docs/AUTH.md](https://github.com/tbaur/homebridge-myalarmcom/blob/main/docs/AUTH.md)) before they start failing.
13. **`keep-alive failed repeatedly`** — Three consecutive session touches failed, so the session was discarded and the next request signs in again. Usually a network blip; persistent occurrences point at an expired cookie.

### Collecting diagnostics for a bug report

Set `diagnosticsInterval` to `300`, set `debug` to `true`, **enable Homebridge Debug Mode** (the `-D` flag, or Settings → Homebridge Debug Mode in the UI), restart, and reproduce the problem. Without Debug Mode, Homebridge discards DEBUG lines and `debug: true` produces nothing.

Attach the `Health:` lines and the surrounding log. Note that every configuration change, including these two, needs a Homebridge restart: the plugin reads its configuration once at startup.

Review the log first. Credentials and cookies are redacted, but device names and Alarm.com identifiers are not, so a log describes your home's layout and activity.

### Reading a `Health:` line

```
Health: healthy | devices 1p/19s | ws connected | api p50 120ms p95 410ms (req 42, err 0)
```

| Field | Meaning |
|---|---|
| `healthy` / `degraded` | Overall rollup. A degraded line names its reasons in brackets. |
| `devices 1p/19s` | Published partitions and sensors. |
| `ws` | Event stream: `connected`, `connecting`, `disconnected`, `closed`, or `disabled` when `useEventStream` is off. |
| `api p50 / p95` | Request latency percentiles over the last 200 requests. |
| `req` / `err` | Request and error counts since the previous heartbeat (`Health:`), or cumulative for the process on `Diagnostics start` / `Diagnostics stop`. |

Degradation reasons:

| Reason | Meaning |
|---|---|
| `circuitBreakerOpen` | Requests are being refused locally after repeated failures. |
| `webSocketDown` | The stream was expected but has been down for over 60 seconds. |
| `apiErrorRateHigh` | More than half of the last 10 or more requests failed. |

`Diagnostics start` is emitted after Platform Ready (so device and stream fields are real). `Diagnostics stop` uses the same line shape. With Homebridge Debug Mode and `debug: true`, the structured snapshot (including plugin version, uptime, and a redacted config echo) is also logged at debug.

## Security

This plugin holds your Alarm.com password and a long-lived two-factor bypass cookie in Homebridge's plaintext `config.json`. Secure the host, prefer a dedicated login, and never paste credentials into issues or logs.

Everything the plugin sends leaves for exactly two destinations: `https://www.alarm.com` and `wss://webskt.alarm.com:8443`. There is no telemetry, no analytics, and nothing is written to disk.

Details: [SECURITY.md](https://github.com/tbaur/homebridge-myalarmcom/blob/main/SECURITY.md) and [docs/AUTH.md](https://github.com/tbaur/homebridge-myalarmcom/blob/main/docs/AUTH.md).

Alarm.com publishes no consumer API and can change or lock accounts without notice. This plugin paces itself accordingly; do not try to work around those limits.

## Requirements

- Node.js 20 or newer
- Homebridge 1.6.x or 2.x
- An Alarm.com account

## More Info

- [Authentication](https://github.com/tbaur/homebridge-myalarmcom/blob/main/docs/AUTH.md) — capturing the two-factor cookie
- [Protocol notes](https://github.com/tbaur/homebridge-myalarmcom/blob/main/docs/PROTOCOL.md) — reverse-engineered Alarm.com behaviour
- [Development](https://github.com/tbaur/homebridge-myalarmcom/blob/main/DEVELOPMENT.md) — architecture and local setup
- [Contributing](https://github.com/tbaur/homebridge-myalarmcom/blob/main/CONTRIBUTING.md)
- [Security policy](https://github.com/tbaur/homebridge-myalarmcom/blob/main/SECURITY.md)
- [Code of conduct](https://github.com/tbaur/homebridge-myalarmcom/blob/main/CODE_OF_CONDUCT.md)
- [Development scripts](https://github.com/tbaur/homebridge-myalarmcom/blob/main/scripts/README.md) — probing and verifying against a live account
- [Report issues](https://github.com/tbaur/homebridge-myalarmcom/issues)

## License

Copyright 2026 tbaur

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) file for details.
