# Authentication

Install and options: [README](../README.md). Full options, log lines, and troubleshooting: [README-DETAILED.md](README-DETAILED.md).

Alarm.com publishes no consumer API. This plugin signs in the way the website does: username, password, and — when two-factor is enabled — a browser cookie named `twoFactorAuthenticationId`.

That cookie is **not** the six-digit code from your authenticator app. It is a long, opaque value Alarm.com sets after you complete two-factor verification, and it tells Alarm.com this sign-in has already passed 2FA.

## Getting the cookie

1. Sign in to [alarm.com](https://www.alarm.com) in a desktop browser, complete two-factor verification, and **tick the option to remember or trust this device** when it is offered.
2. Open developer tools (F12, or Cmd-Option-I on macOS).
3. Open the cookies panel: **Application → Cookies →** `https://www.alarm.com` in Chrome or Edge, or **Storage → Cookies** in Firefox and Safari.
4. Find the row named `twoFactorAuthenticationId` and copy its **value**.
5. Paste that value into the plugin's Two-Factor Cookie field (or into `ADC_MFA_TOKEN` for the development scripts).

Trusting the browser at step 1 is required, and it is the step people miss. Alarm.com sets a `twoFactorAuthenticationId` cookie whether or not you tick the box, so the value looks right either way. Only the trusted version is durable: an untrusted one works in the browser that created it and nowhere else. Replay it from Homebridge and Alarm.com answers `409 TwoFactorAuthenticationRequired` even though the sign-in itself appears to succeed.

You still do not need to trust your Homebridge machine. Once the cookie exists it carries the verification with it, and Alarm.com honours it from a host it reports as untrusted. Trust the browser you copy *from*, not the machine you replay *on*.

Copy only that one cookie's value. Not the whole `Cookie` header, and not several cookies joined by semicolons.

The plugin refuses to start — with an error naming the field, and without affecting the rest of your bridge — if this value is a six-digit authenticator code, contains characters that are not valid in a cookie value, or is implausibly long. It warns, but still tries, if the value is shorter than 20 characters, since a real cookie is far longer and a short one is usually a truncated paste. The development scripts apply the same six-digit check.

## Treat it as a password

Anyone who has the cookie can sign in as you without your password and without a two-factor prompt. Homebridge stores it in plaintext in `config.json` next to your username and password.

- Do not paste it into issues, logs, screenshots, or chat.
- Prefer a dedicated Alarm.com login for Homebridge, with only the permissions you need.
- If it leaks, rotate the Alarm.com account password — that invalidates outstanding two-factor tokens — then capture a fresh cookie.

## When it expires

You will see a `TwoFactorRequiredError` in the log, together with a line telling you to copy a fresh cookie. The plugin will not keep retrying — repeated attempts against a two-factor challenge are what get Alarm.com accounts locked — so it re-reports the same problem rather than quietly backing off.

Repeat the steps above, then **restart Homebridge**. Configuration is read once at startup, so a new cookie in `config.json` has no effect until then.

How long a cookie lasts is not something the plugin can see; Alarm.com sets no expiry it exposes. In practice they last weeks to months, and they are invalidated early by rotating the account password or ending your Alarm.com sessions.

The security implications of this cookie are covered in [SECURITY.md](../SECURITY.md). The wire protocol around it is in [PROTOCOL.md](PROTOCOL.md).
