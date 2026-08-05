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
| `src/errors/index.ts` | Typed error hierarchy carrying a stable `code` from a closed union and an `isRetryable` hint, plus `createApiError` to map an HTTP status (and, for 409, the body) onto the right type. |
| `src/utils/logger.ts` | Prefixes each line with its component, enforces redaction, and exposes `isDebugEnabled` so callers can skip building payloads that would be discarded. Every log line the plugin emits goes through here. |
| `src/utils/sanitizers.ts` | The redaction rules themselves. |
| `src/utils/retry.ts` | Exponential backoff with jitter, plus a cancellable `sleep` whose timer is `unref`'d so a pending wait cannot hold the process open at shutdown. |
| `src/utils/validators.ts` | Startup config validation. Reports problems; never throws. |
| `src/utils/discovery-retry.ts` | Decides whether a startup discovery failure is worth retrying. Only credential and config problems are treated as permanent. |
| `src/utils/failure-log-level.ts` | Per-occurrence log level for a reported failure. Escalation of a *repeated* failure is the platform's job. |
| `src/utils/version.ts` | Resolves the installed plugin version once, shared by diagnostics and the `User-Agent`. |
| `src/diagnostics/collector.ts` | Accumulates counters and a bounded latency window; turns them into heartbeat, snapshot, and health-rollup reports. Performs no I/O. |
| `src/diagnostics/reporter.ts` | Owns the heartbeat timer, the healthy/degraded edge detection, and the log line format. |
| `src/diagnostics/types.ts` | Report shapes, with closed unions for the channel and WebSocket state. |
| `src/devices/status-fault.ts` | Shared `StatusFault` mapping, so partition and sensor agree on what a malfunction looks like. |
| `src/devices/change-log.ts` | Shared "info on change, debug on repeats" policy, so partition and sensor cannot drift apart on it. |

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
| `scripts/lib/prompt.mjs` | Credential prompts shared by the scripts. Fails with an actionable message rather than exiting 0 when there is no terminal. |
| `scripts/lib/cli.mjs` | `--help`, flag reading, and numeric flag validation shared by the scripts. |
| `scripts/lib/plugin-logger.mjs` | Wraps a terminal logger in the plugin's own redaction, so a script cannot print something the plugin would have hidden. |

This is the layout shared with the author's other Homebridge plugins, so follow it when adding modules. `src/index.ts` and `src/settings.ts` are excluded from coverage collection (see `jest.config.js`), so keep logic out of them.

## Design principles

- **Alarm.com is an undocumented black box.** There is no consumer API, no published contract, and no changelog. Nothing external will tell you when behavior changes, so findings are recorded in code next to the value they justify — `settings.ts` is the durable record of what the service actually does, and it is written to be read that way.
- **Dependency-light by design.** The only runtime dependency is `ws`, for the event stream; all HTTP goes through Node's native `https`. `homebridge` is a dev-only dependency (types) injected at runtime by the host. CI runs `npm audit --omit=dev` so the shipped dependency surface stays auditable.
- **Typed errors instead of string matching.** Alarm.com's error text is inconsistent and unversioned, so callers branch on the `code` and `isRetryable` fields of the error hierarchy rather than on messages. Adding a new failure mode means adding a class, not a regex.
- **Pure logic is isolated** in `types/` readers and `utils/` so it is trivially unit-testable; network and HAP code accepts injectable transports for testing.
- **Strict TypeScript** (`strict`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`). Linting is type-aware, so `no-floating-promises`, `no-misused-promises`, and `await-thenable` are errors — which matters on a codebase built almost entirely from timers and fire-and-forget async.
- **Lookup tables keyed by remote data are `Map`s, not object literals.** `deviceType` and `state` arrive from an unvalidated `JSON.parse`, and an object literal resolves `"constructor"` to a function rather than `undefined`, defeating every downstream guard.
- **Never take the bridge down.** Homebridge does not guard a platform constructor: a throw there escapes `loadPlatforms()`, rejects `Server.start()`, and SIGTERMs the process along with every other plugin in the house. So config validation *reports* rather than throws — fatal problems are logged at error level and leave this platform inert, and out-of-range values are clamped with a warning.
- **Degradation is visible.** Every retryable failure logs at debug, which is off by default, so a sustained outage would otherwise be completely silent while HomeKit went stale. The platform counts consecutive failures and escalates once to a warning, then pairs it with a "reachable again" line. The counter deliberately ignores which error arrived, because the type changes mid-outage as the circuit breaker opens.
- **Every log line names its component, and every API line names its request.** `createScopedLogger` prefixes `[auth]`, `[api]`, `[events]`, and so on. API lines additionally carry a six-hex request tag and a duration, shared by every retry and failure belonging to the same logical request — without which a log of thousands of near-identical poll lines cannot be reasoned about at all.
- **The platform is coupled to the accessories, deliberately and in one direction only.** `platform.ts` imports the accessory classes as values; the accessories import `MyAlarmComPlatform` back as `import type`. That single type-only back-edge is erased at compile time, so there is no runtime cycle — and `consistent-type-imports` is enforced as an error precisely so the back-edge cannot become a value import.
- **Secrets never reach the log.** The account password, session cookies, the `twoFactorAuthenticationId` cookie, the anti-CSRF value, the event-stream token, and any `Authorization` header are redacted before anything is logged — including values passed as log *parameters*. Cookies are redacted by exception, so an unrecognised cookie name fails closed. Device names and Alarm.com identifiers are *not* redacted, deliberately; see [SECURITY.md](SECURITY.md). Capture instructions for the cookie are in [docs/AUTH.md](docs/AUTH.md).

## Reliability and rate-limit discipline

Two constraints shape almost every design decision here, and neither is optional.

**Alarm.com locks accounts that authenticate or poll too aggressively,** and a locked account is a security system the user cannot reach from HomeKit *or* the Alarm.com app. So:

- **Re-authentication is rationed.** An established session is held open with periodic `KeepAlive.aspx` touches rather than logging in again; a full re-authentication has a hard floor (`MIN_AUTH_INTERVAL_MIN`, 10 minutes) enforced in code, not merely defaulted.
- **Polling has a floor** (`MIN_POLL_INTERVAL_SEC`, 60 seconds). Stale state is a much better outcome than a disabled account.
- **Rejected credentials are never retried.** `AuthenticationError`, `TwoFactorRequiredError`, and `LoginFormError` all report `isRetryable: false`, because hammering a two-factor challenge is precisely what triggers a lockout. A transient sign-in failure (network blip) does **not** start the login floor, so discovery backoff can retry promptly; only a successful login or a permanent credential rejection stamps the floor.

**This is a live security system,** so state-changing requests are deliberate and narrow. Capability discovery in `scripts/probe.mjs` issues `GET` requests only; it is structurally incapable of arming, disarming, or unlocking anything.

The rest of the resilience story:

- **Event stream first, polling as the safety net.** The WebSocket stream is the primary state source. It is proactively re-established on an interval with subtractive jitter (a silently dead socket is worse than a briefly interrupted one, because HomeKit would show stale state with no error anywhere), reconnects with capped exponential backoff, and after `WEBSOCKET_MAX_FAILURES` consecutive failures the plugin falls back to polling and later retries the stream on `WEBSOCKET_RECOVERY_INTERVAL_MS` rather than staying dark until Homebridge restarts.
- **Initial discovery retries transient failures.** A network blip at boot must not leave the platform idle with no Ready; retryable discovery errors warn and back off until success or shutdown, while credential failures still fail loudly once.
- **Transient-error retry** with jittered exponential backoff for network errors, timeouts, `5xx`, and `429` (honoring `Retry-After`). Jitter is applied before the cap, not after, so a computed delay cannot exceed the ceiling that a server-supplied hint is refused for exceeding.
- **A lapsed session gets a one-shot recovery, not the backoff loop.** An HTML interstitial served where JSON was expected is Alarm.com's habit when a session goes stale, so `ApiParseError` — like `SessionExpiredError` — takes a single invalidate-and-retry through `#withSessionRecovery`. `isRetryable` is `true` on both, but `#isWorthRetrying` excludes them from `withRetry` so they are not also hammered three times. A *command* replays only on the `401`: `ApiParseError` is raised after `response.ok`, so the panel very likely accepted it and a replay would arm twice.
- **Circuit breaker.** After 5 failures within `failureWindowMs` (5 minutes) the breaker opens and requests fail fast until a 30-second cooldown elapses, then half-open probes decide whether to close. Two deliberate calibrations: the window is several poll intervals wide, because at one interval a cycle's failures always aged out before the next tick and the breaker could never reach its threshold; and failures within `failureCoalesceMs` count once, because one logical request is up to `MAX_API_RETRY_ATTEMPTS` guarded calls and counting each separately meant two isolated flaky requests tripped a breaker configured for five. That window covers retries that fail *fast*; three 30-second timeouts span longer than any sane coalescing window and still count separately, which is the right direction — a service that accepts connections and never answers should trip the breaker sooner than one returning quick errors. `halfOpenProbes` (concurrent probes admitted) and `successesToClose` are separate knobs.
- **Transitions are logged on the edges only.** During an outage the breaker necessarily flaps `OPEN -> HALF_OPEN -> OPEN` once per poll cycle as the cooldown elapses and the probe fails. Logging each was 2,880 lines a day, arriving at warn level in the log an operator is reading to understand the outage, so only entry into and exit from "unavailable" is loud and the probe churn is debug.
- **Bounded timeouts** on every request (`DEFAULT_REQUEST_TIMEOUT_MS`, 30s; longer for the login postback, shorter for keep-alive) covering the response *body*, not only its headers. `fetch` settles as soon as headers arrive, so a deadline that stops there leaves a stalled body read unbounded — and one hung read used to stop polling for the life of the process, silently, because the poll interval kept firing and kept returning early on the in-flight guard.
- **The poll cycle has its own deadline** (`POLL_CYCLE_DEADLINE_MS`) on top of the per-request ones, because a cycle is many requests plus pacing plus backoff and its in-flight guard is what stops polling if it never settles. The deadline *cancels* through a per-cycle `AbortController` chained to the platform's, rather than merely abandoning the promise: abandoning it cleared the in-flight guard while the original cycle kept issuing requests, so cycles could overlap, slow each other through the shared pacing queue, and register accessories underneath one another.
- **The login floor never blocks a caller.** The floor between sign-ins can be up to a day. Waiting it out inside `getSession()` blocked the poll cycle, and any HomeKit arm or disarm queued behind it, for exactly that long — so anything beyond a few seconds is refused with a retryable `LoginThrottledError` carrying the remaining wait, and the caller's own schedule decides when to come back. A credential rejection is re-raised as itself rather than masked as a throttle.
- **Every sign-in failure paces the next attempt.** A rejected credential gets the full floor; anything else gets a short one. With no floor at all, a retryable failure let the next caller sign in immediately — and since sign-in bypasses the request rate limiter, one API call could become six login attempts with only the circuit breaker bounding it.
- **The keep-alive actually extends the session.** Freshness is measured from the last time the session was *verified*, which a successful keep-alive updates. Measuring from the login instead meant the keep-alive spent a request every four minutes without ever postponing the login it exists to prevent.
- **A server `Retry-After` is bounded on both sides.** Capped at `MAX_RETRY_BACKOFF_MS`, beyond which the retry is abandoned rather than slept through, and floored against the computed backoff, because an HTTP-date parses to `0` when the local clock runs ahead.
- **Shutdown cancels in-flight work.** An `AbortController` is threaded through the client, the session manager, and every wait, so clearing the timers stops new work *and* the request already out.
- **Batched reads are capped** at `MAX_IDS_PER_REQUEST` (50). Alarm.com answers an over-long query string with a `404` rather than a useful error, so an oversized batch fails as "no such endpoint".
- **Permission is checked before acting.** A partition the account may not control is refused locally, before a command is sent, rather than after it fails: HomeKit gets `INSUFFICIENT_PRIVILEGES` and the log reports that the Alarm.com account used cannot change the arming state of that partition. The check is fail-closed, so anything other than a literal `hasPermissionToChangeState: true` counts as "may not control".

## Capturing fixtures with the probe

`npm run probe` signs in to a real Alarm.com account once, reports what the account exposes, and writes scrubbed JSON:API payloads for use as test fixtures. It is the tool that turns guesses about this undocumented API into recorded facts.

See [scripts/README.md](scripts/README.md) for usage, credential handling, how to obtain `ADC_MFA_TOKEN`, and the safety constraints built into the script.

Two rules about its output:

- **`probe-output/` is git-ignored and must never be committed.** It is account-specific data from a live security system, and a scrubber bug must not become a published leak.
- **Read a payload before promoting it into `tests/fixtures/`.** Scrubbing is best-effort: identifiers are pseudonymized consistently and names, MACs, and IPs are replaced, but the scrubber only knows about the fields it was taught.

## Testing

- Unit tests live in `tests/unit/` and inject fakes; nothing touches the network.
- Integration tests live in `tests/integration/` and use `nock` to exercise the real transport against recorded payloads.
- Tests compile under the production strict settings with `noUnusedLocals` and `noUnusedParameters` relaxed (`tsconfig.test.json`), so an arranged-but-unused fixture is not a compile error.
- Shared setup lives in `tests/setup.js`, which `jest.config.js` loads for every suite. It calls `nock.disableNetConnect()`, so no test can reach the network even by accident.
- Coverage is gated at 95% statements / 87% branches / 93% functions globally, with a per-file floor for `src/platform.ts` — a global-only gate lets the largest and most lifecycle-heavy file rot while the aggregate holds. Only `src/index.ts` and `src/settings.ts` are excluded, and both are deliberately logic-free. The thresholds are a ratchet set just under actual: raise them as coverage improves, never lower them to make a change pass.
- `tests/unit/config-schema.test.ts` asserts that `config.schema.json` agrees with the runtime constants and the validator. The schema restates every bound the code enforces, and nothing else checks that the UI advertises the contract the plugin actually implements.
- `tests/integration/lifecycle.test.ts` covers shutdown, failure escalation, and recovery — the paths that decide whether an unattended plugin degrades visibly, and the hardest to reproduce in the field.
- Jest runs serially (`maxWorkers: 1`): several suites drive module-level singletons and the integration suites wait out real intervals, so parallel workers interleave into flakes.

```bash
npm install
npm run build              # compile TypeScript to dist/
npm run build:watch        # recompile on change
npm run clean              # remove dist/
npm run lint               # eslint
npm run lint:fix           # eslint with autofix
npm run typecheck          # tsc on src/ and on the test project
npm test                   # jest with coverage (NODE_ENV=test)
npm run test:watch         # jest in watch mode
npm run test:unit          # unit tests only
npm run test:integration   # nock-backed integration tests
npm run probe              # capture scrubbed fixtures from a live account
npm run verify             # build, then run the compiled plugin against a live account
npm run watch              # build, then stream live events while polling state
npm run diagnose-stream    # build, then isolate a WebSocket connection failure
```

Note that `npm test` does not build first. When a change needs to be reflected in `dist/`, run `npm run build` explicitly.

Every script takes `--help`, and each one fails with an actionable message — and a non-zero exit — when a required credential or a numeric flag is missing or malformed. Node 22 or newer is expected for development, matching what `homebridge` 2.x requires, and `nvm use` picks that up from `.nvmrc`; the *published* plugin still supports Node 20 via Homebridge 1.6, which the CI matrix proves by running everything on 20, 22, and 24.

## Committed `dist/`

`dist/` is intentionally **not** git-ignored: it is committed so that installing the plugin straight from the repository works without a build step. That means a source change is only complete once `npm run build` has been run and the resulting `dist/` changes are committed alongside it. CI verifies that the committed `dist/` matches `src/` and fails on drift.

## Adding new device support

1. Model the resource in `src/types/alarm.ts`: an attributes interface matching the JSON:API payload, plus any new state enum.
2. For a new sensor kind, add it to `SensorDeviceType` and give its states entries in `STATE_LABELS`, so the plugin's log wording matches what the Alarm.com app displays for that device. The labels are per device type for a reason: state `1` is "Closed" on a contact sensor and "Not Reset" on a smoke detector.
3. Add an accessory handler in `src/devices/` that maps device state to HAP services, keeping the mapping itself pure so it can be unit-tested without HAP.
4. Register it in platform discovery.
5. Capture a real payload with `npm run probe`, check the scrubbed output by hand, add it under `tests/fixtures/`, then add unit coverage for the new mapping and integration coverage for the client path.
