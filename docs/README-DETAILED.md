# homebridge-myalarmcom detailed documentation

Install and a short options table live in the [README](../README.md). This page is the rest: every option, every log line worth searching for, and how to read a `Health:` report.

## Table of Contents

- [Full configuration reference](#full-configuration-reference)
- [How devices appear](#how-devices-appear)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Collecting diagnostics](#collecting-diagnostics)
- [Reading a Health line](#reading-a-health-line)
- [Related docs](#related-docs)

## Full configuration reference

```json
{
  "platforms": [
    {
      "platform": "MyAlarmCom",
      "name": "MyAlarmCom",
      "username": "you@example.com",
      "password": "your-alarm-dot-com-password",
      "twoFactorAuthenticationId": "the-cookie-value-you-copied",
      "pollIntervalSeconds": 60,
      "authIntervalMinutes": 10,
      "useEventStream": true,
      "allowSensorBypass": false,
      "includeUnmonitoredSensors": false,
      "ignoredDeviceIds": [],
      "diagnosticsInterval": 0,
      "debug": false
    }
  ]
}
```

`name` belongs to Homebridge, which uses it as the log prefix. This plugin never reads it. Everything else is validated at startup.

Invalid configuration never takes the bridge down. A missing credential, a six-digit code pasted where the two-factor cookie belongs, or a whole cookie header pasted in place of one value is reported at error level and this platform stays inert. Every other plugin on the bridge keeps running. Out-of-range intervals are clamped with a warning instead.

| Option | Default | Description |
| --- | --- | --- |
| `name` | `MyAlarmCom` | Optional. Read by Homebridge as the log prefix. |
| `username` | — | **Required.** Alarm.com username, usually an email address. |
| `password` | — | **Required.** Alarm.com password. |
| `twoFactorAuthenticationId` | — | Browser cookie from [AUTH.md](AUTH.md). Required when 2FA is enabled. That is a long cookie value, not a six-digit authenticator code. |
| `pollIntervalSeconds` | `60` | Full state refresh interval. Clamped to `60`–`86400` (24h). |
| `authIntervalMinutes` | `10` | Session reuse before signing in again. Clamped to `10`–`1440` (24h). |
| `useEventStream` | `true` | Subscribe to push events. Polling continues regardless. |
| `allowSensorBypass` | `false` | Let an arming command bypass sensors that are open, rather than failing. The Alarm.com app asks before bypassing and HomeKit gives the plugin no way to ask, so enabling this lets an arm from Siri or the Home app leave an open door unmonitored, reported only in the Homebridge log. Left off, the panel refuses and the tile returns to its previous state after about a minute. |
| `includeUnmonitoredSensors` | `false` | Expose sensors Alarm.com reports as unmonitored. They appear marked inactive in the Home app, because an unsupervised sensor's state cannot be trusted. |
| `ignoredDeviceIds` | `[]` | Device IDs to leave out of HomeKit. Each ID is logged when its accessory is added, and is also the accessory's Serial Number in the Home app. |
| `diagnosticsInterval` | `0` | Seconds between health heartbeats in the log. `0` is off. Otherwise `30`–`86400` (24h). At 30 that is about 2,880 lines/day; prefer `300` or higher. |
| `debug` | `false` | Verbose logging. **Also requires Homebridge Debug Mode** (the `-D` flag, or Settings → Homebridge Debug Mode in the UI). Homebridge discards DEBUG lines otherwise, so this option alone produces no extra output. Credentials are redacted; device names and Alarm.com IDs are not. |

## How devices appear

| Alarm.com device | HomeKit accessory | Notes |
| --- | --- | --- |
| Partition (panel) | Security System | Arm/disarm, plus a true triggered-alarm state. Night arming is offered only when the panel advertises `ArmedNight`. |
| Contact sensor | Contact Sensor | Doors, windows, garage door position |
| Motion sensor | Motion Sensor | |
| Smoke detector | Smoke Sensor | |

Lights, locks, thermostats, garage door *openers*, cameras, and doorbells are not supported. They were left out on purpose, not written blind against untested hardware.

If the Alarm.com account cannot change arming state, the plugin warns and exposes the panel as read-only.

An unrecognised panel state keeps the previous tile and raises a fault rather than showing a safe-looking "disarmed". An unrecognised sensor state is cross-checked against Alarm.com's normalised open/closed reading and the ambiguity is logged.

Sensors added or removed at the panel are picked up on the hourly rediscovery pass. You do not need to restart Homebridge for that.

## How it works

Push events go over WebSocket when `useEventStream` is on. Polling still runs as a safety net.

A session is kept alive instead of logging in on every cycle. Requests are paced at one per second and 60 per minute, with hard floors on the poll and re-auth intervals. Alarm.com locks accounts that misbehave.

A circuit breaker fails fast during a sustained outage rather than retrying into a wall.

Homebridge already tags each line with the plugin name (for example `[myalarmcom]`). API lines also carry a short request tag and a duration, like `[3f9c1e, 412ms]`. Every retry and every failure belonging to the same request shares one tag.

Architecture: [DEVELOPMENT.md](../DEVELOPMENT.md). Wire-level notes: [PROTOCOL.md](PROTOCOL.md). Capturing the two-factor cookie: [AUTH.md](AUTH.md).

## Troubleshooting

1. **`TwoFactorRequiredError`.** Cookie missing, expired, for a different account, or captured from a browser sign-in where "remember/trust this device" was not ticked. That last one is the common case and the hardest to spot, because Alarm.com sets the cookie either way and an untrusted one looks perfectly correct. Capture a fresh one ([AUTH.md](AUTH.md)), then restart Homebridge. Configuration is read once at startup.
2. **Rejected username or password.** Fix credentials before restarting repeatedly. Alarm.com locks accounts after failed sign-ins. The plugin will not retry a rejected credential on its own.
3. **Login form parse error.** Alarm.com changed its sign-in page. Please open an issue.
4. **Sensor missing.** Check discovery logs: unsupported type, monitoring disabled (unless `includeUnmonitoredSensors`), or listed in `ignoredDeviceIds`.
5. **Panel is read-only / cannot arm.** The Alarm.com account used lacks permission to change arming state. Use a login that can arm/disarm, or keep it read-only for monitoring.
6. **`Alarm.com has failed N times in a row`.** A sustained outage. Nothing to do but wait. Polling keeps retrying and a matching "reachable again" line follows. Alarm.com is being left alone on purpose in the meantime.
7. **`Circuit breaker CLOSED -> OPEN`.** Repeated failures, so requests are being refused locally for 30 seconds at a time. This protects your account from looking like a scraper, which Alarm.com locks accounts for.
8. **`Continuing with polling only`.** The push event stream gave up after repeated failures. State still updates, just on the poll interval instead of within a second or two. The stream is retried every 15 minutes.
9. **`did not reach <state>`.** An arming request was accepted but the panel never confirmed it, usually an open zone or a keypad abort. The tile falls back to the panel's real state after a minute. For an open zone, `allowSensorBypass` lets the panel arm past it instead, at the cost of arming with that sensor unmonitored.
10. **Arming appears to hang, then fails.** A panel refusing to arm over an open zone never answers, so the request runs to its 60-second ceiling before the log reports `could not reach Armed Stay — the panel never answered`. Close the zone, or enable `allowSensorBypass` so the panel bypasses it. Note that a *successful* arm is also slow: Alarm.com holds the request open until the panel acknowledges, measured at 17-25 seconds, so the Home app shows the requested state as pending for that long before the panel confirms it. That is normal and is not a failure. Each command logs twice, once when it goes out and once when it finishes:

    ```
    [myalarmcom] Alarm Panel: requesting Armed Stay
    [myalarmcom] Alarm Panel: Armed Stay, confirmed by the panel in 17.3s
    ```
11. **`reported an arming state this plugin does not recognise`.** The tile keeps its last known value and shows a fault rather than guessing. Please open an issue with the state number.
12. **`is now reporting as a <kind> sensor`.** An Alarm.com device ID is reporting a different hardware type than the accessory published for it. Its state is left alone rather than written to the wrong characteristic. Restart Homebridge to republish it.
13. **`issued a new two-factor trust token`.** The configured `twoFactorAuthenticationId` was not accepted and Alarm.com handed back a different one. Requests still work for now. Capture a fresh cookie ([AUTH.md](AUTH.md)) before they start failing.
14. **`keep-alive failed repeatedly`.** Three consecutive session touches failed, so the session was discarded and the next request signs in again. Usually a network blip. Persistent occurrences point at an expired cookie.

## Collecting diagnostics

Set `diagnosticsInterval` to `300`, set `debug` to `true`, **enable Homebridge Debug Mode** (the `-D` flag, or Settings → Homebridge Debug Mode in the UI), restart, and reproduce the problem. Without Debug Mode, Homebridge discards DEBUG lines and `debug: true` produces nothing.

Attach the `Health:` lines and the surrounding log. Every configuration change, including these two, needs a Homebridge restart. The plugin reads its configuration once at startup.

Review the log first. Credentials and cookies are redacted, but device names and Alarm.com identifiers are not, so a log describes your home's layout and activity.

## Reading a Health line

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

## Related docs

- [README](../README.md): install and short options table
- [AUTH.md](AUTH.md): capturing the two-factor cookie
- [PROTOCOL.md](PROTOCOL.md): reverse-engineered Alarm.com behaviour
- [DEVELOPMENT.md](../DEVELOPMENT.md)
- [scripts/README.md](../scripts/README.md): probing and verifying against a live account
- [SECURITY.md](../SECURITY.md)
- [CONTRIBUTING.md](../CONTRIBUTING.md)

## License

Copyright 2026 tbaur

Licensed under the Apache License, Version 2.0. See [LICENSE](../LICENSE) file for details.
