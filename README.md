# homebridge-myalarmcom

[![Tests](https://github.com/tbaur/homebridge-myalarmcom/actions/workflows/test.yml/badge.svg)](https://github.com/tbaur/homebridge-myalarmcom/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/homebridge-myalarmcom?style=flat-square)](https://www.npmjs.com/package/homebridge-myalarmcom)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-myalarmcom?style=flat-square)](https://www.npmjs.com/package/homebridge-myalarmcom)
[![Node.js](https://img.shields.io/badge/node-22%20%7C%7C%2024%20%7C%7C%2026-green)](https://nodejs.org)
[![Homebridge](https://img.shields.io/badge/homebridge-2.x-purple)](https://homebridge.io)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Expose your [Alarm.com](https://www.alarm.com) security panel and sensors in Apple HomeKit through Homebridge.

## Features

### Device Support
- **Security System:** panel arm / disarm, including a true triggered-alarm state
- **Contact, motion, and smoke sensors**
- **Night arming** only when the panel advertises `ArmedNight`
- **Read-only accounts:** the panel is exposed as read-only when the login cannot change arming state

### Reliability
- **Push events over WebSocket** (on by default), with polling as a safety net
- **Session keepalive** instead of logging in on every cycle
- **Paced requests:** one per second and 60 per minute, with floors on poll and re-auth intervals. Alarm.com locks accounts that misbehave
- **Circuit breaker** during a sustained outage
- **Hourly rediscovery** so sensors added or removed at the panel show up without a Homebridge restart
- **Fail-closed mapping:** an unrecognised panel state keeps the previous tile and raises a fault
- **Diagnostics** *(optional):* health heartbeats in the Homebridge log

### Quality
- **Jest suite** gated at 95% statements and 87% branches, against captured fixtures, no network
- **Secret hygiene:** passwords, session cookies, and the two-factor cookie are redacted from every log line
- **No analytics**

Every option, log line, and troubleshooting step is in [Detailed documentation](docs/README-DETAILED.md).

## Quick Start

### 1. Install

**Homebridge UI** (recommended): Plugins → Search `myalarmcom` → Install

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

| Alarm.com device | HomeKit accessory | Notes |
| --- | --- | --- |
| Partition (panel) | Security System | Arm/disarm, plus a triggered-alarm state |
| Contact sensor | Contact Sensor | Doors, windows, garage door position |
| Motion sensor | Motion Sensor | |
| Smoke detector | Smoke Sensor | |

Lights, locks, thermostats, garage door *openers*, cameras, and doorbells are not supported. They were left out on purpose, not written blind against untested hardware.

## Configuration Options

`name` belongs to Homebridge, which uses it as the log prefix; this plugin never reads it. Everything else is validated at startup. Invalid configuration never takes the bridge down.

| Option | Default | Description |
| --- | --- | --- |
| `name` | `MyAlarmCom` | Optional. Homebridge log prefix. |
| `username` | — | **Required.** Alarm.com username, usually an email address. |
| `password` | — | **Required.** Alarm.com password. |
| `twoFactorAuthenticationId` | — | Browser cookie from [docs/AUTH.md](docs/AUTH.md). Required when 2FA is enabled. |
| `pollIntervalSeconds` | `60` | Full state refresh. Clamped to `60`–`86400`. |
| `authIntervalMinutes` | `10` | Session reuse before signing in again. Clamped to `10`–`1440`. |
| `useEventStream` | `true` | Subscribe to push events. Polling continues regardless. |
| `allowSensorBypass` | `false` | Let arming bypass open sensors instead of failing. Arms the house with that zone unmonitored, without asking. |
| `includeUnmonitoredSensors` | `false` | Expose sensors Alarm.com reports as unmonitored (marked inactive). |
| `ignoredDeviceIds` | `[]` | Device IDs to leave out of HomeKit. |
| `diagnosticsInterval` | `0` | Seconds between health heartbeats; `0` off, else `30`–`86400`. |
| `debug` | `false` | Verbose logging. Also requires Homebridge Debug Mode (`-D`). |

Clamp rules, the unmonitored-sensor warning, and the `debug` flag are explained in the [detailed documentation](docs/README-DETAILED.md#full-configuration-reference).

## Not Working?

1. **`TwoFactorRequiredError`:** cookie missing, expired, or for a different account. Capture a fresh one ([docs/AUTH.md](docs/AUTH.md)) and restart.
2. **Rejected username or password:** fix credentials before restarting repeatedly. Alarm.com locks accounts after failed sign-ins.
3. **Sensor missing:** unsupported type, monitoring disabled, or listed in `ignoredDeviceIds`.
4. **Panel is read-only:** the login cannot change arming state.
5. **Circuit breaker OPEN:** repeated failures, so requests are refused locally for 30 seconds at a time.

The [full troubleshooting list](docs/README-DETAILED.md#troubleshooting) covers thirteen cases, how to collect a `Health:` log, and how to read that line.

## Security

This plugin holds your Alarm.com password and a long-lived two-factor bypass cookie in Homebridge's plaintext `config.json`. Secure the host, prefer a dedicated login, and never paste credentials into issues or logs.

Everything the plugin sends leaves for `https://www.alarm.com` and `wss://webskt.alarm.com:8443`. There is no telemetry.

See [SECURITY.md](SECURITY.md) and [docs/AUTH.md](docs/AUTH.md).

Alarm.com publishes no consumer API and can change or lock accounts without notice. This plugin paces itself accordingly. Do not try to work around those limits.

## Requirements

- Node.js 22, 24, or 26
- Homebridge 2.x
- An Alarm.com account

## More Info

- [Detailed documentation](docs/README-DETAILED.md)
- [Authentication](docs/AUTH.md)
- [Protocol notes](docs/PROTOCOL.md)
- [Development](DEVELOPMENT.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Development scripts](scripts/README.md)
- [Report issues](https://github.com/tbaur/homebridge-myalarmcom/issues)

## License

Copyright 2026 tbaur

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) file for details.
