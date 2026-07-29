# Development

## Architecture

Two layers, meeting at the platform. Above it, `devices/` speaks HomeKit and knows nothing about how state was obtained. Below it, `api/` speaks Alarm.com and knows nothing about HomeKit. Every outbound call runs the same gauntlet in the same order: rate limiter, then circuit breaker, then transport.

### The HomeKit side

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point; registers the dynamic platform. |
| `src/platform.ts` | Discovery, accessory lifecycle, polling, and the hourly re-enumeration that notices devices added or removed at the panel. |
| `src/devices/partition.ts` | Security panel accessory. Presents read-only unless the account is explicitly permitted to change the arming state. |
| `src/devices/sensor.ts` | Contact, motion, and smoke accessories. |
| `src/utils/mappers.ts` | Pure Alarm.com state to HomeKit characteristic mapping, kept free of HAP so it is unit-testable. |

### The Alarm.com side

| File | Purpose |
|---|---|
| `src/api/http.ts` | Low-level transport shared by sign-in and the client. |
| `src/api/cookie-jar.ts` | Minimal cookie store for the web session, deliberately not a general-purpose implementation. |
| `src/api/auth.ts` | WebForms sign-in and the two-factor cookie replay. |
| `src/api/session-manager.ts` | Owns session lifetime. Exists to minimise how often the plugin signs in at all. |
| `src/api/rate-limiter.ts` | Client-side pacing, because Alarm.com publishes no rate limit and returns no quota headers. |
| `src/api/circuit-breaker.ts` | Fail-fast protection during sustained Alarm.com failures. |
| `src/api/client.ts` | Typed client for the JSON:API surface. |
| `src/api/event-stream.ts` | WebSocket event stream: token refresh, capped reconnect backoff, and fallback to polling when it will not stay up. |

### Protocol and support

| File | Purpose |
|---|---|
| `src/settings.ts` | Endpoints, WebForms field names, cookie names, and the rate-limit floors. Every value was confirmed against a live account, and the comments explain why the arbitrary-looking ones are what they are. |
| `src/types/alarm.ts` | JSON:API envelopes, partition and sensor attributes, state enums, and the pure readers that resolve a raw payload. Marked verified only where a live account produced the value. |
| `src/types/events.ts` | Event-stream frame shape, and the decoder for the few event types worth acting on before the confirming read arrives. |
| `src/types/config.ts` | Platform configuration, as the user writes it and as the plugin resolves it. |
| `src/errors/index.ts` | Typed error hierarchy carrying a stable `code` and an `isRetryable` hint, plus `createApiError` to map an HTTP status (and, for 409, the body) onto the right type. |
| `src/utils/logger.ts` | Scopes messages and enforces redaction. Every log line the plugin emits goes through here. |
| `src/utils/sanitizers.ts` | The redaction rules themselves. |
| `src/utils/retry.ts` | Exponential backoff with jitter. |
| `src/utils/validators.ts` | Startup config validation. |

### Development scripts

Not shipped, and not part of the plugin. See [scripts/README.md](scripts/README.md) for usage and credential handling.

| File | Purpose |
|---|---|
| `scripts/probe.mjs` | Captures scrubbed fixtures from a live account. Issues `GET` requests only. |
| `scripts/verify.mjs` | Runs the compiled plugin against a live account and prints the HomeKit values it would publish. |
| `scripts/watch-arming.mjs` | Streams events while polling state, so a real arm or disarm can be watched as it happens. |
| `scripts/diagnose-stream.mjs` | Isolates WebSocket connection failures by trying each client and token encoding in turn. |
| `scripts/lib/session.mjs` | Minimal web-session client: login, cookie jar, anti-CSRF. |
| `scripts/lib/scrub.mjs` | Strips account-identifying data from captured payloads. |
| `scripts/lib/prompt.mjs` | Credential prompts shared by the scripts. |

This is the layout shared with the author's other Homebridge plugins, so follow it when adding modules. `src/index.ts` and `src/settings.ts` are excluded from coverage collection (see `jest.config.js`), so keep logic out of them.

## Design principles

- **Alarm.com is an undocumented black box.** There is no consumer API, no published contract, and no changelog. Nothing external will tell you when behavior changes, so findings are recorded in code next to the value they justify — `settings.ts` is the durable record of what the service actually does, and it is written to be read that way.
- **Dependency-light by design.** The only runtime dependency is `ws`, for the event stream; all HTTP goes through Node's native `https`. `homebridge` is a dev-only dependency (types) injected at runtime by the host. CI runs `npm audit --omit=dev` so the shipped dependency surface stays auditable.
- **Typed errors instead of string matching.** Alarm.com's error text is inconsistent and unversioned, so callers branch on the `code` and `isRetryable` fields of the error hierarchy rather than on messages. Adding a new failure mode means adding a class, not a regex.
- **Pure logic is isolated** in `types/` readers and `utils/` so it is trivially unit-testable; network and HAP code accepts injectable transports for testing.
- **Strict TypeScript** (`strict`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`).
- **Fail fast on bad config.** Config validation runs at startup; fatal errors stop the plugin with an actionable message, non-fatal issues log a warning and fall back to defaults.
- **Secrets never reach the log.** The account password, session cookies, the `twoFactorAuthenticationId` cookie, and the anti-CSRF value are redacted before anything is logged. See [docs/AUTH.md](docs/AUTH.md) and [SECURITY.md](SECURITY.md).

## Reliability and rate-limit discipline

Two constraints shape almost every design decision here, and neither is optional.

**Alarm.com locks accounts that authenticate or poll too aggressively,** and a locked account is a security system the user cannot reach from HomeKit *or* the Alarm.com app. So:

- **Re-authentication is rationed.** An established session is held open with periodic `KeepAlive.aspx` touches rather than logging in again; a full re-authentication has a hard floor (`MIN_AUTH_INTERVAL_MIN`, 10 minutes) enforced in code, not merely defaulted.
- **Polling has a floor** (`MIN_POLL_INTERVAL_SEC`, 60 seconds). Stale state is a much better outcome than a disabled account.
- **Rejected credentials are never retried.** `AuthenticationError`, `TwoFactorRequiredError`, and `LoginFormError` all report `isRetryable: false`, because hammering a two-factor challenge is precisely what triggers a lockout.

**This is a live security system,** so state-changing requests are deliberate and narrow. Capability discovery in `scripts/probe.mjs` issues `GET` requests only; it is structurally incapable of arming, disarming, or unlocking anything.

The rest of the resilience story:

- **Event stream first, polling as the safety net.** The WebSocket stream is the primary state source. It is proactively re-established on an interval with jitter (a silently dead socket is worse than a briefly interrupted one, because HomeKit would show stale state with no error anywhere), reconnects with capped exponential backoff, and after `WEBSOCKET_MAX_FAILURES` consecutive failures the plugin falls back to polling rather than going dark.
- **Transient-error retry** with jittered exponential backoff for network errors, timeouts, `5xx`, `429` (honoring `Retry-After`), and unparseable bodies. An HTML interstitial served where JSON was expected is Alarm.com's habit when a session goes stale, so `ApiParseError` is retryable — one bad payload should not stop polling permanently.
- **Circuit breaker.** After a threshold of service-health failures the breaker opens and requests fail fast until a cooldown elapses, with a single half-open probe deciding whether to close.
- **Bounded timeouts** on every request (`DEFAULT_REQUEST_TIMEOUT_MS`, 30s) so a stalled connection cannot wedge the poll loop.
- **Batched reads are capped** at `MAX_IDS_PER_REQUEST` (50). Alarm.com answers an over-long query string with a `404` rather than a useful error, so an oversized batch fails as "no such endpoint".
- **Permission is checked before acting.** A partition the account may not control is refused locally, before a command is sent, rather than after it fails: HomeKit gets `INSUFFICIENT_PRIVILEGES` and the log gets the `ReadOnlyPartitionError` text naming the partition. The check is fail-closed, so anything other than a literal `hasPermissionToChangeState: true` counts as "may not control".

## Capturing fixtures with the probe

`npm run probe` signs in to a real Alarm.com account once, reports what the account exposes, and writes scrubbed JSON:API payloads for use as test fixtures. It is the tool that turns guesses about this undocumented API into recorded facts.

See [scripts/README.md](scripts/README.md) for usage, credential handling, how to obtain `ADC_MFA_TOKEN`, and the safety constraints built into the script.

Two rules about its output:

- **`probe-output/` is git-ignored and must never be committed.** It is account-specific data from a live security system, and a scrubber bug must not become a published leak.
- **Read a payload before promoting it into `tests/fixtures/`.** Scrubbing is best-effort: identifiers are pseudonymized consistently and names, MACs, and IPs are replaced, but the scrubber only knows about the fields it was taught.

## Testing

- Unit tests live in `tests/unit/` and inject fakes; nothing touches the network.
- Integration tests live in `tests/integration/` and use `nock` to exercise the real transport against recorded payloads.
- Tests compile under the same strict TypeScript settings as production (`tsconfig.test.json`).
- Shared setup lives in `tests/setup.js`, which `jest.config.js` loads for every suite.
- Coverage threshold is 80% across statements, branches, functions, and lines for the whole `src/` tree. Only `src/index.ts` and `src/settings.ts` are excluded, and both are deliberately logic-free.

```bash
npm install
npm run build              # compile TypeScript to dist/
npm run build:watch        # recompile on change
npm run clean              # remove dist/
npm run lint               # eslint
npm run lint:fix           # eslint with autofix
npm test                   # jest with coverage (NODE_ENV=test)
npm run test:watch         # jest in watch mode
npm run test:unit          # unit tests only
npm run test:integration   # nock-backed integration tests
npm run probe              # capture scrubbed fixtures from a live account
npm run verify             # build, then run the compiled plugin against a live account
npm run watch              # build, then stream live events while polling state
```

Note that `npm test` does not build first. When a change needs to be reflected in `dist/`, run `npm run build` explicitly.

## Committed `dist/`

`dist/` is intentionally **not** git-ignored: it is committed so that installing the plugin straight from the repository works without a build step. That means a source change is only complete once `npm run build` has been run and the resulting `dist/` changes are committed alongside it. CI verifies that the committed `dist/` matches `src/` and fails on drift.

## Adding new device support

1. Model the resource in `src/types/alarm.ts`: an attributes interface matching the JSON:API payload, plus any new state enum, and add the `type` discriminator to `ResourceType`.
2. For a new sensor kind, add it to `SensorDeviceType` and give its states entries in `STATE_LABELS`, so the plugin's log wording matches what the Alarm.com app displays for that device. The labels are per device type for a reason: state `1` is "Closed" on a contact sensor and "Not Reset" on a smoke detector.
3. Add an accessory handler in `src/devices/` that maps device state to HAP services, keeping the mapping itself pure so it can be unit-tested without HAP.
4. Register it in platform discovery.
5. Capture a real payload with `npm run probe`, check the scrubbed output by hand, add it under `tests/fixtures/`, then add unit coverage for the new mapping and integration coverage for the client path.
