# Alarm.com protocol notes

Alarm.com publishes no consumer API and no documentation. Everything below was established empirically against a live account using `scripts/probe.mjs`. This document exists so the next person to touch this code — likely a future version of the current maintainer — does not have to rediscover it.

Findings are marked **verified** when a live account actually produced the behaviour, and **inferred** when they are reasoned from partial evidence. Please preserve that distinction when you add to this document. In a security integration, a confidently wrong note is worse than an acknowledged gap.

## Shape of the thing

There is no REST API. There is a website, and the website talks to a private JSON:API backend. Authentication is an ASP.NET WebForms postback, and the resulting session cookies plus an anti-CSRF header are what authorise subsequent API calls. Anything this plugin does, a browser could do.

## Authentication

**Verified.** The flow is three steps.

First, `GET https://www.alarm.com/login` and scrape four hidden inputs from the HTML: `__VIEWSTATE`, `__VIEWSTATEGENERATOR`, `__EVENTVALIDATION`, and `__PREVIOUSPAGE`. These are the first thing that will break if Alarm.com redesigns the page, which is why the plugin reports precisely which field went missing rather than a generic failure.

Second, `POST https://www.alarm.com/web/Default.aspx` as `application/x-www-form-urlencoded`, echoing those four fields back along with the credentials. The username field is named `ctl00$ContentPlaceHolder1$loginform$txtUserName` and the password field is plain `txtPassword`. Three further fields — `__EVENTTARGET`, `__EVENTARGUMENT`, and `__VIEWSTATEENCRYPTED` — are sent as the **literal four-character string `null`**, not as an empty value and not omitted. This looks like a bug and is not; it is what the endpoint accepts.

If the account has two-factor authentication enabled, this POST must carry a `Cookie: twoFactorAuthenticationId=<value>` header. See [the cookie](#the-two-factor-cookie) below.

Third, read the session cookies off the login **response**. Success is a `302`. A `200` means the form re-rendered, which is how WebForms reports a rejected credential — so the intuitive success check is exactly backwards here.

### Only replay the login response's cookies

**Verified, and this is the single most important detail on this page.**

Cookies accumulate at two points: the `GET` of the login page, and the `POST` that authenticates. It is tempting to merge both into one jar. Doing so does not work.

Three strategies were tested head to head against a live account:

| Strategy                                                   | Result                                |
| ---------------------------------------------------------- | ------------------------------------- |
| Cookies from the login POST response only                  | **Works**                             |
| All cookies, including those from the login page GET       | `409 TwoFactorAuthenticationRequired` |
| All cookies, after following the post-login redirect chain | `409 TwoFactorAuthenticationRequired` |

Sending a *superset* of the correct cookies causes Alarm.com to demand two-factor verification again. Something in the pre-login cookie set contradicts the authenticated session. If you are debugging a mysterious `409` while holding what looks like a perfectly good trust cookie, this is almost certainly why.

### The two-factor cookie

**Verified.** `twoFactorAuthenticationId` is scoped to the Alarm.com *user account*, not to a device, a browser, or an IP address. It can be copied out of any signed-in browser and replayed from anywhere.

This is worth stating plainly because the natural assumption is the opposite. Alarm.com has a visible "trusted device" feature, and a probe run confirmed `isCurrentDeviceTrusted: false` for the machine doing the replaying — while the replay worked anyway. **Device trust is not required.** A trusted-device list that does not include your Homebridge machine is not the cause of your problem.

The corollary is a genuine security property of this design: the cookie is a durable, account-wide two-factor bypass sitting in plaintext config. Rotating the account password is what invalidates it.

**Verified.** The account's two-factor state is readable at `/web/api/engines/twoFactorAuthentication/twoFactorAuthentications/{userId}`, which also reports which second factors are enabled.

### Keeping the session alive

**Verified.** `GET https://www.alarm.com/web/KeepAlive.aspx` returns `200` with `{"status": <number>}` and refreshes the session.

Prefer this to re-authenticating. Signing in is the operation Alarm.com polices for abuse; touching an existing session is not. No public client appears to use this endpoint, and all of them log in from scratch on a timer instead.

## Calling the API

**Verified.** Every authenticated request needs all four of:

- `Cookie:` the login-response cookies
- `ajaxrequestuniquekey:` the value of the `afg` cookie, echoed back as a header
- `Accept: application/vnd.api+json`
- `Referer: https://www.alarm.com/web/system/home`

Omitting the `Referer` is enough to be refused. The API is the web app's own backend and expects requests that look like they came from it.

### Discovery

**Verified.** `GET /web/api/identities` returns the signed-in user. Read `data[0].relationships.selectedSystem.data.id` to get the system ID.

`GET /web/api/systems/systems/{systemId}` returns the system, whose `relationships` enumerate device IDs by category — roughly thirty categories, of which this plugin reads `partitions` and `sensors`.

Device resource IDs are formed as `{unitId}-{deviceNumber}`, for example `1234567-17`. This matters for the event stream, which reports the two halves separately.

### Batch reads

**Verified.** Collections accept repeated `ids[]` query parameters: `/web/api/devices/sensors?ids[]=A&ids[]=B`.

**Verified.** Batches must not exceed **50** IDs. Exceed it and Alarm.com answers `404`, not a useful error — so an oversized batch presents as "that endpoint does not exist".

### Commands

**Inferred.** Arming is `POST /web/api/devices/partitions/{id}/{action}` where action is `armStay`, `armAway`, or `disarm`. The body carries `statePollOnly: false` plus optional modifiers.

It is the *request shape* that is inferred. Arming itself has been watched end to end, but always driven from the mobile app: the account used for development is provisioned read-only (`hasPermissionToChangeState: false`), so this codebase has never sent one of these requests to a real panel. The shape matches what a long-running community client sends, and everything downstream of it — the events, the state transitions, the timing below — is verified. The `POST` is not.

Two modifiers must be **omitted rather than sent as `false`** when not wanted: `nightArming` and `forceBypass` break the command outright on panels that do not support them. Neither applies to a disarm.

Ask `extendedArmingOptions` about the mode you are actually requesting. Support for a modifier is advertised per mode, so a panel can offer force arming for `ArmedAway` and not for `ArmedStay`. Note that night arming is sent as an `armStay` verb but advertised under `ArmedNight`, so the mode you ask about is not always the verb you send.

Arming takes 20–30 seconds to settle at the panel. Do not expect the response to reflect the new state.

## Device state

### Sensors

**Verified.** `state` is a single shared enum across all sensor categories:

| Value | Meaning        |
| ----- | -------------- |
| 0     | Unknown        |
| 1     | Closed         |
| 2     | Open           |
| 3     | Idle           |
| 4     | Active         |
| 5     | Dry (inferred) |
| 6     | Wet (inferred) |

The semantics are uniform, but the *label* Alarm.com displays is device-specific. State `1` renders as "Closed" on a contact sensor and as **"Not Reset"** on a smoke detector. Both are the resting state. A smoke detector sitting at state 1 is not faulted.

**Verified, and not used by any public client.** Sensors also report `openClosedStatus`, which normalises across every device type: `2` at rest, `3` tripped. Across all nineteen sensors on the test account this held without exception, for contact, motion, and smoke alike. It is the cross-check that lets the plugin resolve a `state` value it has never seen before instead of defaulting to "safe".

**Verified.** Battery reporting is `batteryLevelNull` and `batteryLevelClassification`. There is no `lowBattery` or `criticalBattery` flag on this payload. Both fields were `null` on every sensor tested, so there may be no battery data available at all on some hardware.

Device types confirmed on live hardware: `1` contact, `2` motion, `5` smoke.

### Partitions

**Verified.** `state` uses a separate enum: `0` unknown, `1` disarmed, `2` armed stay, `3` armed away, `4` armed night. `1` and `2` were both observed live, by arming and disarming from the mobile app while [watching the account](#arming-timing). Armed away and armed night remain inferred: the test account cannot issue those commands, and the panel was never put into either state by hand.

**Verified.** `hasActiveAlarm` is a **separate boolean** from `state`. While an alarm is sounding, `state` continues to report the arming mode. A client that maps only `state` can never display a triggered alarm — it will show a calm armed tile during a break-in. Read both.

**Verified.** `hasPermissionToChangeState` tells you up front whether this account may arm at all, which is far better than discovering it from a failed command. Treat any value other than a literal `true` as "no": these documents are parsed without runtime validation, so a renamed or absent field arrives as `undefined`, and the question being answered is whether to let something disarm a physical alarm.

### Extended arming options

**Verified, and easy to get wrong.** `extendedArmingOptions` is not a set of booleans. It maps an arming mode name to an array of integer modifier codes:

```json
{
  "Disarmed": [],
  "ArmedStay": [1, 0, 4],
  "ArmedAway": [0, 4]
}
```

The codes are `0` bypass sensors, `1` no entry delay, `2` silent arming, `3` night arming, `4` selectively bypass sensors, `5` force arm.

`invalidExtendedArmingOptions` has the same keys but its values are arrays of *combinations* that are rejected, so it is one dimension deeper.

**Verified.** Night arming availability is signalled by the **presence of an `ArmedNight` key**, not by a boolean. The test panel omits the key entirely. Do not confuse this with the neighbouring `supportsNightArmingSchedules`, which concerns scheduling and was `true` on the same panel that cannot night-arm at all.

## Event stream

**Verified.** `GET /web/api/websockets/token` returns a flat object — not a JSON:API document, unlike every other route here. The token is at `value`, and the endpoint is nested at **`metaData.endpoint`**, not alongside it. Reading `endpoint` from the top level silently yields `undefined`.

Connect to `{metaData.endpoint}?auth={value}`, defaulting to `wss://webskt.alarm.com:8443`.

Check that endpoint before appending the token to it. It is chosen by the server and the token is a live credential, so an unvalidated value lets one field in one response decide where a credential for a security system is sent, and a `ws://` value would send it in clear text. Require `wss:` on an `alarm.com` host and fall back to the default otherwise.

### Do not encode the token

**Verified, and it fails in a way that points at the wrong cause.**

The token must be appended to the query string **raw**. It looks like an opaque 600-character blob, so percent-encoding it is the obvious defensive move, and it is wrong: the value arrives already percent-escaped and contains structural `&` and `=` characters. In other words it is itself a query fragment that expands into several parameters, not a single value.

Encoding it turns those separators into literals and Alarm.com refuses the upgrade with `401`. Confirmed head to head:

| Client                    | Token           | Result       |
| ------------------------- | --------------- | ------------ |
| `ws` package              | raw             | **Connects** |
| `ws` package              | percent-encoded | `401`        |
| Node built-in `WebSocket` | raw             | **Connects** |
| Node built-in `WebSocket` | percent-encoded | Refused      |

The choice of WebSocket client makes no difference; only the encoding does. `scripts/diagnose-stream.mjs` reruns this matrix if the stream ever stops connecting.

A related trap: a failed upgrade surfaces only through the `unexpected-response` event on the `ws` package. Node's built-in client discards the HTTP status entirely, so debug this with `ws` if you want to know *why* you were refused rather than merely that you were.

**Verified.** Frames look like this:

```json
{
  "EventDateUtc": "2026-07-29T02:01:44.783Z",
  "UnitId": 1234567,
  "DeviceId": 2,
  "EventType": 0,
  "EventValue": 0,
  "CorrelatedId": null,
  "QstringForExtraData": "openClosedStatusWord=closed",
  "DeviceType": 1
}
```

Join `UnitId` and `DeviceId` with a hyphen to get the device resource ID.

`EventType` is a large, undocumented enumeration running to several hundred values. These are the ones observed on live hardware:

| `EventType` | Meaning                     | How it was established                                    |
| ----------- | --------------------------- | --------------------------------------------------------- |
| `0`         | Contact closed              | Observed with `openClosedStatusWord=closed`               |
| `8`         | Panel disarmed              | Sent by the partition on a disarm from the mobile app     |
| `9`         | Panel armed, stay           | Sent by the partition on an arm-stay from the mobile app  |
| `13`        | Sensor bypassed             | Fired by two open windows as an arm-stay bypassed them    |
| `15`        | Contact opened              | Inferred from the pairing with `0` and `100`              |
| `35`        | Sensor bypass cleared       | Fired by the same two windows on disarm                   |
| `55`        | A user signed in            | Fires on the plugin's own logins; carries no device state |
| `100`       | Contact opened *and* closed | Opening a door and shutting it produces one `100`         |

**Verified.** `100` is an opened-and-closed event, not an "opened" one.

### `DeviceType` on a frame cannot be trusted

**Verified, and this one bites.** During an arm/disarm capture, *every* frame arrived with `DeviceType: -1`, including frames from contact sensors whose type the API reports as `1`. An earlier verify run had shown `DeviceType: 1` on door frames, so the field is populated sometimes and not others.

Anything deciding what a device is must resolve the type from discovery and ignore the frame's claim. Gating on it is not merely unreliable, it fails silently: the code still runs, finds no match, and quietly skips work it should have done.

**A frame is primarily a hint naming a device.** The plugin re-reads that device's actual state rather than trusting the event to describe it, because getting one of several hundred undocumented codes wrong in a security integration is not an acceptable failure mode, and the cost of the extra read is one paced request.

### Arming timing

**Verified.** On an arm-stay driven from the mobile app, the partition's push event arrived roughly six seconds before polling first saw `state` change, and both `state` and `desiredState` moved together to `2` — no transitional period where the two disagreed was ever observed, across both the arm and the disarm.

`deviceIcon` also changes with the state (`184` disarmed, `185` armed stay). It is cosmetic and the plugin ignores it, but it shows up in attribute diffs.

Two open windows were bypassed as part of the arm. Each emitted a `13` on arming and a `35` on disarm, and neither changed its own `state` or `openClosedStatus` throughout. Bypass is therefore invisible in the sensor attributes the plugin maps, so a bypassed open window continues to report open in HomeKit, which is the truthful answer.

### The transient-state problem, and the narrow exception

**Verified.** Hint-and-re-read alone has a real cost, found by testing rather than reasoning.

When a door is opened and closed quickly, Alarm.com sends one `100` frame. The re-read lands roughly one to two seconds later — after the debounce window and request pacing — by which time the door reports `Closed`. The open state would never reach HomeKit, so an automation triggered by that door opening would never fire. This was observed live on two separate doors.

Three contact events are therefore decoded and published immediately, ahead of the confirming read: `0`, `15`, and `100`. This is deliberately the narrowest exception that solves the problem:

- It applies only to devices discovery identified as contact sensors, never to a type claimed by the frame. The same numeric codes are not assumed to mean the same thing elsewhere, so a `100` from a motion sensor is still treated as an opaque hint.
- The re-read still runs and still wins. A wrong guess self-corrects within seconds instead of persisting, which is what makes the exception acceptable at all.
- Every other event type is unchanged and takes the re-read-only path.

Sustained changes never depended on this: a door left open reports `Open` on the re-read regardless.

`QstringForExtraData` can contain account detail and is never logged raw.
