# Security Policy

## Supported Versions

| Version          | Supported                         |
| ---------------- | --------------------------------- |
| Latest release   | ✅ Active support                 |
| Anything earlier | ❌ Upgrade to the latest release  |

While the plugin is pre-1.0, only the most recent release is supported. Fixes are shipped forward rather than backported.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public issue**
2. Use GitHub's [private vulnerability reporting](https://github.com/tbaur/homebridge-myalarmcom/security/advisories/new), which reaches the maintainer without disclosing anything publicly
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Any suggested fixes

## The `twoFactorAuthenticationId` Cookie

How to capture the cookie for configuration is in [docs/AUTH.md](docs/AUTH.md). This section is the threat model.

Alarm.com publishes no consumer API and no supported way for a third-party client to authenticate. This plugin therefore signs in the way a browser does, and when the account has two-factor authentication enabled it replays a cookie named `twoFactorAuthenticationId` that you copy out of a browser session. Understand what that cookie is before you configure the plugin:

- **It is a two-factor bypass token, not a session cookie.** Presenting it tells Alarm.com the second factor has already been satisfied, so a login with your username, password, and this cookie completes without prompting for a code.
- **It is scoped to the user account, not to a device or browser.** Any client that has it can replay it from anywhere. That property is the only reason this plugin can authenticate at all, and it is also what makes the cookie dangerous.
- **It is long-lived.** Alarm.com sets it once a browser completes two-factor verification, and it remains valid for an extended period with no expiry that the plugin can see or control. It is *not* tied to Alarm.com's "trusted device" feature: testing confirmed the cookie is honoured from a machine that Alarm.com reports as untrusted, so marking your Homebridge host as trusted is neither required nor helpful.
- **It is stored in plaintext.** Homebridge keeps plugin configuration in `config.json` on disk, unencrypted, alongside your Alarm.com username and password. Anyone who can read that file — or a backup of it, or a support bundle generated from it — holds a durable credential to your security system.

Treat this cookie as a password-equivalent credential. Do not paste it into issues, logs, screenshots, or chat.

**Revoking it.** There is no per-token revocation control, so revocation means ending the trust that issued the token: sign out of your Alarm.com sessions, remove trusted devices or browsers if your account settings expose that option, and rotate the account password. Rotating the password is the step you can rely on. Any of this also invalidates the copy in your Homebridge config, so expect to capture a fresh cookie and update the configuration afterwards.

## Security Measures

This plugin implements:

- **HTTPS only** - All API communication uses TLS to `https://www.alarm.com`; the event stream connects over `wss://`
- **No credential transmission beyond Alarm.com** - Credentials are sent only to Alarm.com's own login endpoint; nothing is reported to any third party
- **Session reuse over re-authentication** - An established session is held open with lightweight keepalive requests instead of logging in repeatedly, because re-authentication is the operation Alarm.com polices most aggressively
- **Anti-CSRF header handling** - The `afg` cookie value is echoed in the `ajaxrequestuniquekey` header on every API request, matching what Alarm.com's own web app does
- **Secret redaction in logs** - Passwords, session cookies, the two-factor cookie, the anti-CSRF value, the event-stream token, and any `Authorization` header (with or without a scheme) are redacted from every line, including values passed as log parameters and including a secret that itself contains an escaped quote. Redaction is idempotent, so a line that passes through twice does not degrade. Cookies are redacted by *exception*: a cookie name the plugin has never seen is redacted, so a new one Alarm.com invents is covered by default rather than leaked by default. Any JSON key whose *name* looks like a credential is redacted by shape, covering fields no release has seen yet
- **Cookies pinned to one origin** - The transport refuses to send a `Cookie` header anywhere but `https://www.alarm.com`, whatever case the header name is written in, and refuses outright to follow redirects on a request carrying one — so no server response can steer a live session cookie to another host
- **The event-stream token goes only to Alarm.com** - The stream endpoint arrives inside a server response and the token is appended to it, so the endpoint is checked to be `wss:` on an `alarm.com` host before the token is sent; anything else falls back to the known-good default
- **Input validation** - All configuration is validated at startup, with numeric bounds enforced and string lengths capped. Invalid configuration is reported at error level and leaves this platform inert; it never throws out of the constructor, because Homebridge does not guard that call and a throw terminates the whole process along with every other plugin
- **Request timeouts** - Every request has a bounded deadline covering the response *body*, not only its headers, so a stalled body read cannot wedge the poll loop. In-flight work is cancelled on shutdown
- **Bounded backoff** - A server-supplied `Retry-After` is respected but capped, and floored against the computed backoff, so neither an implausible value nor clock skew can park a poll cycle or remove the delay entirely. The plugin's own computed backoff is clamped *after* jitter, so it cannot exceed the same ceiling
- **No retry on rejected credentials** - Authentication failures and two-factor challenges are never retried, since repeated login attempts are what get accounts locked. Every *other* sign-in failure is paced by a short floor as well, so a retry loop cannot turn one API call into a burst of logins
- **No replay of a command that may have been accepted** - A read may be retried after an unparseable response, because that usually means the session lapsed. An arming command may not: the plugin only raises that error after a `2xx`, so the panel very likely accepted the command, and a replay would arm twice
- **No shell, no dynamic code, no writes to disk** - The plugin never spawns a process, never writes a file, and contains no `eval`. The only file it reads is its own `package.json`, for the version it reports in the `User-Agent` and in diagnostics. It has one runtime dependency (`ws`) and no install lifecycle scripts
- **Dependency auditing** - `npm audit --omit=dev` runs on every push to `main` and every pull request; OSV-Scanner runs on pull requests, merge queues, pushes to `main`, and weekly. Every GitHub Action is pinned to a full commit SHA

## Credential Handling

- The Alarm.com username, password, and `twoFactorAuthenticationId` cookie are read from the Homebridge platform config. Homebridge stores that config in plain text on the host, so **host hardening is the primary mitigation** for all three.
- The plugin holds session cookies in memory only; they are not persisted, and nothing is written to disk.
- No credentials or cookies are written to logs, at any level — not values, not truncations, not fingerprints. Debug may list cookie *names* after login; nothing that could identify a secret's contents.
- **Device names and Alarm.com identifiers are logged.** They are what makes a log diagnosable, so this is deliberate — but it means a log describes your home: `Master Bedroom Window: Open` is a labelled floor plan with live occupancy. Review any log before sharing it, and note that `debug: true` adds considerably more of it.

## What Leaves Your Network

Two destinations, both Alarm.com, both TLS:

| Destination | Purpose |
| --- | --- |
| `https://www.alarm.com` | Sign-in, session keep-alive, device discovery, state reads, arming commands, event-stream token |
| `wss://webskt.alarm.com:8443` | Push event stream |

Every request identifies itself as `homebridge-myalarmcom/<version>` in its `User-Agent`, deliberately and honestly, rather than impersonating a browser.

Nothing else: no telemetry, no analytics, no crash reporting, no third party.

Outbound traffic is paced at **one request per second and 60 per minute**, with a 30-second ceiling on how long a caller will be made to wait before the request is refused outright. A circuit breaker opens after 5 failures within 5 minutes and then refuses requests locally for 30 seconds at a time. Failures within 15 seconds of each other count once, so one request retried three times against a fast-failing service is one signal rather than three; a request that fails by timing out takes longer than that and still counts each attempt, which opens the breaker sooner on a service that stops answering entirely.

## Account Lockout

This is an availability risk rather than a confidentiality one, but it is the failure mode most likely to bite you: Alarm.com disables accounts that authenticate or poll too aggressively, and a locked account means a security system you cannot reach from either HomeKit or the Alarm.com app. The plugin enforces floors on both the polling interval and the re-authentication interval rather than trusting configuration to be sensible. Do not run several instances of this plugin, or this plugin alongside another Alarm.com integration, against the same account.

## Development Scripts and Captured Data

- `npm run probe` talks to a live account. Capability discovery issues `GET` requests only, so nothing in it can arm, disarm, or unlock a device. See [scripts/README.md](scripts/README.md).
- Probe output is written to `probe-output/`, which is git-ignored. Payloads are scrubbed before they are written, but the scrubber is best-effort: read any file before sharing it or promoting it into `tests/fixtures/`.
- Every script routes plugin log output through the same redaction the plugin itself uses, so a script cannot print something the plugin would have hidden. Terminal output still names your devices; the files written on exit are scrubbed.
- `npm run verify -- --arm` and `--arm-cycle` are the only script paths that command the panel. Both require a typed confirmation. `--arm-cycle` always attempts a disarm on its way out, including after an interrupt, and keeps its interrupt handler installed *through* that disarm so a second Ctrl-C cannot kill the process mid-disarm. `--arm` deliberately leaves the panel where it put it, and says so.
- Secret fingerprints in script output use a per-run random salt, matching the plugin. A fixed salt committed to a public repository would turn a fingerprint in a shared `probe-output/` file into an offline oracle for confirming a guessed secret.
- Prefer the interactive prompts over inline `ADC_PASSWORD=…` assignments: inline assignments land in your shell history and are visible to other local users in `ps` output.

## Best Practices for Users

1. Treat the `twoFactorAuthenticationId` cookie and your Alarm.com password as equivalent secrets
2. Restrict filesystem permissions on the Homebridge `config.json` and on any backups of it
3. If you only want HomeKit to observe system state, use an Alarm.com login that lacks permission to change arming state; the plugin warns that the account used cannot change arming state and exposes the panel as read-only rather than attempting the command
4. Keep Homebridge and this plugin updated
5. Run Homebridge with minimal system privileges
6. Use Homebridge's secure remote access features rather than exposing it directly to the internet

## Response Timeline

This is a single-maintainer, pre-1.0 project, so these are best-effort targets rather than commitments:

- **Acknowledgment**: within a few days
- **Initial assessment**: within about a week
- **Fix**: prioritised by severity, with anything critical taken first and shipped as soon as it is ready

If a report has had no response after a week, please follow up on the advisory thread.
