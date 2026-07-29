# Security Policy

## Supported Versions

| Version | Supported         |
| ------- | ----------------- |
| 0.1.x   | ✅ Active support |

While the plugin is pre-1.0, only the most recent release is supported. Fixes are shipped forward rather than backported.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public issue**
2. Email the maintainer directly or use GitHub's [private vulnerability reporting](https://github.com/tbaur/homebridge-myalarmcom/security/advisories/new)
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
- **Secret redaction in logs** - Passwords, session cookies, the two-factor cookie, and the anti-CSRF value are never written to logs; errors are sanitized before logging
- **Input validation** - All configuration inputs are validated at startup; invalid config fails fast with a clear message
- **Request timeouts** - Every request has a bounded timeout so a stalled connection cannot wedge the poll loop
- **No retry on rejected credentials** - Authentication failures and two-factor challenges are never retried, since repeated login attempts are what get accounts locked
- **Dependency auditing** - `npm audit` runs in CI on every push and pull request, and OSV-Scanner runs on pull requests and weekly

## Credential Handling

- The Alarm.com username, password, and `twoFactorAuthenticationId` cookie are read from the Homebridge platform config. Homebridge stores that config in plain text on the host, so **host hardening is the primary mitigation** for all three.
- The plugin holds session cookies in memory only; they are not persisted.
- No credentials, cookies, or personally identifying information are written to logs.

## Account Lockout

This is an availability risk rather than a confidentiality one, but it is the failure mode most likely to bite you: Alarm.com disables accounts that authenticate or poll too aggressively, and a locked account means a security system you cannot reach from either HomeKit or the Alarm.com app. The plugin enforces floors on both the polling interval and the re-authentication interval rather than trusting configuration to be sensible. Do not run several instances of this plugin, or this plugin alongside another Alarm.com integration, against the same account.

## Development Scripts and Captured Data

- `npm run probe` talks to a live account. Capability discovery issues `GET` requests only, so nothing in it can arm, disarm, or unlock a device. See [scripts/README.md](scripts/README.md).
- Probe output is written to `probe-output/`, which is git-ignored. Payloads are scrubbed before they are written, but the scrubber is best-effort: read any file before sharing it or promoting it into `tests/fixtures/`.

## Best Practices for Users

1. Treat the `twoFactorAuthenticationId` cookie and your Alarm.com password as equivalent secrets
2. Restrict filesystem permissions on the Homebridge `config.json` and on any backups of it
3. If you only want HomeKit to observe system state, use an Alarm.com login that lacks permission to change arming state; the plugin detects that and reports it rather than attempting the command
4. Keep Homebridge and this plugin updated
5. Run Homebridge with minimal system privileges
6. Use Homebridge's secure remote access features rather than exposing it directly to the internet

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix timeline**: Depends on severity
  - Critical: 24-48 hours
  - High: 1 week
  - Medium: 2 weeks
  - Low: Next release
