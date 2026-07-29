# Authentication

Alarm.com publishes no consumer API. This plugin signs in the way the website does: username, password, and — when two-factor is enabled — a browser cookie named `twoFactorAuthenticationId`.

That cookie is **not** the six-digit code from your authenticator app. It is a long, opaque value Alarm.com sets after you complete two-factor verification, and it tells Alarm.com this sign-in has already passed 2FA.

## Getting the cookie

1. Sign in to [alarm.com](https://www.alarm.com) in a desktop browser and complete two-factor verification.
2. Open developer tools (F12, or Cmd-Option-I on macOS).
3. Open the cookies panel: **Application → Cookies →** `https://www.alarm.com` in Chrome or Edge, or **Storage → Cookies** in Firefox and Safari.
4. Find the row named `twoFactorAuthenticationId` and copy its **value**.
5. Paste that value into the plugin's Two-Factor Cookie field (or into `ADC_MFA_TOKEN` for the development scripts).

You do not need to mark the browser as trusted, and you do not need to trust your Homebridge machine. The cookie is scoped to your Alarm.com *account*, not to a device.

The development scripts reject six-digit input for this field on purpose: that is the authenticator code, and it will not work here.

## Treat it as a password

Anyone who has the cookie can sign in as you without your password and without a two-factor prompt. Homebridge stores it in plaintext in `config.json` next to your username and password.

- Do not paste it into issues, logs, screenshots, or chat.
- Prefer a dedicated Alarm.com login for Homebridge, with only the permissions you need.
- If it leaks, rotate the Alarm.com account password — that invalidates outstanding two-factor tokens — then capture a fresh cookie.

When the cookie expires you will see a `TwoFactorRequiredError` in the log. Repeat the steps above.

The security implications of this cookie are covered in [SECURITY.md](../SECURITY.md). The wire protocol around it is in [PROTOCOL.md](PROTOCOL.md).
