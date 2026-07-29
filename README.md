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
- **Mode-Aware Arming** — Only offers Stay / Away / Night when the panel advertises them
- **Read-Only Accounts** — HomeKit controls stay greyed out unless the login is explicitly allowed to change arming state

### Reliability

- **Real-Time Updates** — Push events over WebSocket (on by default), with polling as a safety net
- **Session Keepalive** — Holds an established session open instead of logging in repeatedly
- **Paced Requests** — Hard floors on poll and re-auth intervals; Alarm.com locks accounts that misbehave
- **Circuit Breaker** — Fails fast during sustained outages rather than retrying into a wall
- **Hourly Rediscovery** — Sensors added or removed at the panel show up without a Homebridge restart
- **Fail-Closed Mapping** — Unrecognised sensor states keep the previous value and log a warning; they never resolve to "all clear"
- **Diagnostics** *(optional)* — Opt-in health/activity heartbeats, boot/shutdown snapshots, and healthy/degraded transitions in the Homebridge log

### Quality

<!-- Canonical test count lives here only; keep other docs number-free to avoid multi-place updates. -->
- **458 Tests** — Jest suite with an 80% coverage gate across statements, branches, functions, and lines
- **Strict TypeScript** — `strict` mode with unused locals/params, no implicit returns, and more
- **Secret Hygiene** — Passwords, session cookies, and the two-factor cookie are redacted from logs
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

How to capture it, and why to treat it like a password: [docs/AUTH.md](docs/AUTH.md).

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

`name` is required by Homebridge verified plugins and identifies this instance in the logs (defaults to `MyAlarmCom`).

| Option                      | Default | Description                                                                      |
| --------------------------- | ------- | -------------------------------------------------------------------------------- |
| `name`                      | `MyAlarmCom` | Required. Plugin instance name shown in Homebridge logs.                    |
| `username`                  | —       | Required. Alarm.com email address.                                               |
| `password`                  | —       | Required. Alarm.com password.                                                    |
| `twoFactorAuthenticationId` | —       | Browser cookie from [docs/AUTH.md](docs/AUTH.md). Required when 2FA is enabled. |
| `pollIntervalSeconds`       | `60`    | Full state refresh interval. Values below 60 are raised to 60.                   |
| `authIntervalMinutes`       | `10`    | Session reuse before signing in again. Values below 10 are raised to 10.         |
| `useEventStream`            | `true`  | Subscribe to push events. Polling continues regardless.                          |
| `includeUnmonitoredSensors` | `false` | Expose sensors Alarm.com reports as unmonitored.                                 |
| `ignoredDeviceIds`          | `[]`    | Device IDs to leave out of HomeKit. IDs are printed during discovery.            |
| `diagnosticsInterval`       | `0`     | Seconds between health heartbeats in the log; `0` off, else `30`–`3600`.         |
| `debug`                     | `false` | Verbose logging. Credentials are redacted.                                       |

## Not Working?

1. **`TwoFactorRequiredError`** — Cookie missing, expired, or for a different account. Capture a fresh one ([docs/AUTH.md](docs/AUTH.md)).
2. **Rejected username or password** — Fix credentials before restarting repeatedly; Alarm.com locks accounts after failed sign-ins.
3. **Login form parse error** — Alarm.com changed its sign-in page; please open an issue.
4. **Sensor missing** — Check discovery logs: unsupported type, monitoring disabled (unless `includeUnmonitoredSensors`), or listed in `ignoredDeviceIds`.

## Security

This plugin holds your Alarm.com password and a long-lived two-factor bypass cookie in Homebridge's plaintext `config.json`. Secure the host, prefer a dedicated login, and never paste credentials into issues or logs.

Details: [SECURITY.md](SECURITY.md) and [docs/AUTH.md](docs/AUTH.md).

Alarm.com publishes no consumer API and can change or lock accounts without notice. This plugin paces itself accordingly; do not try to work around those limits.

## Requirements

- Node.js 20 or newer
- Homebridge 1.6 or newer, including Homebridge 2.x
- An Alarm.com account

## More Info

- [Authentication](docs/AUTH.md) — capturing the two-factor cookie
- [Protocol notes](docs/PROTOCOL.md) — reverse-engineered Alarm.com behaviour
- [Development](DEVELOPMENT.md) — architecture and local setup
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Report issues](https://github.com/tbaur/homebridge-myalarmcom/issues)

## License

Copyright 2026 tbaur

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) file for details.
