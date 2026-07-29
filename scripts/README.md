# Development scripts

| Script | Purpose |
| --- | --- |
| `probe.mjs` | Signs in to Alarm.com once, reports what the account exposes, probes for a better authentication path, and writes scrubbed JSON:API payloads to `probe-output/` for use as test fixtures. |
| `verify.mjs` | Drives the **compiled plugin** in `dist/` against a live account and prints how each device maps to HomeKit. |
| `watch-arming.mjs` | Streams events while polling partition and sensor state, printing every change with a diff. Built for watching a real arm/disarm driven from the mobile app. |
| `diagnose-stream.mjs` | Connects to the event stream four ways (two clients × raw and encoded token) and reports which combinations work. Run it when the stream stops connecting. |
| `lib/session.mjs` | Minimal Alarm.com web-session client (WebForms login, cookie jar, anti-CSRF header) used by the scripts that reimplement the protocol. |
| `lib/prompt.mjs` | Credential prompts shared by every script. Secrets are read without echoing. |
| `lib/scrub.mjs` | Removes account-identifying data from captured payloads. |

They answer different questions. `probe.mjs` reimplements the protocol in order to *discover* it, and is the right tool when Alarm.com changes something and you need to find out what. `verify.mjs` exercises the code that actually ships, and is the right tool for confirming a change behaves correctly against real hardware. `watch-arming.mjs` observes rather than interprets, which is what you want when the question is "what does Alarm.com actually send when I do this?"

## Verifying the plugin against real hardware

```bash
npm run verify                        # build, discover, show mappings, listen 90s
node scripts/verify.mjs --listen 300  # longer window, e.g. while walking the house
node scripts/verify.mjs --verbose     # include every frame, not just decoded ones
node scripts/verify.mjs --arm stay    # send one arming command: stay, away, or disarm
node scripts/verify.mjs --arm-cycle   # arm stay, watch it settle, then disarm again
```

It prints each sensor's raw `state` and `openClosedStatus` alongside the HomeKit value the plugin derives, so a mapping error is visible by reading it against what you can see with your own eyes. Anything the plugin cannot resolve confidently is flagged `AMBIGUOUS`.

Listening is how the remaining protocol gaps get closed: walk past a motion sensor while it runs and the event, the device it resolves to, and the re-read state all appear together.

`--arm` and `--arm-cycle` are the only parts that write, and both really do command the panel. Each requires typing the action name to confirm. On a read-only account the resulting refusal is itself the useful output, since it pins down the error shape. Everything else is `GET` only.

The output lists your device names and which doors are currently open. Treat it as sensitive.

## Watching a real arm or disarm

```bash
npm run watch                            # run until interrupted
node scripts/watch-arming.mjs --minutes 5  # stop on its own after 5 minutes
```

This one never writes anything. Start it, then arm or disarm from the Alarm.com app, and it records what arrives: raw event frames with their fields decoded, and a poll-driven diff of every partition and sensor attribute that changed. Attribute changes that no event announced are flagged, which is how you find the state transitions the event stream does not tell you about.

On exit it prints a timeline and writes a scrubbed JSON capture to `probe-output/`. The arming behaviour recorded in [docs/PROTOCOL.md](../docs/PROTOCOL.md) came from this script.

## Running the probe

```bash
node scripts/probe.mjs             # prompts for credentials
node scripts/probe.mjs --ws 60     # also listen 60s for WebSocket events
```

Credentials may be supplied as environment variables instead of being prompted for:

```bash
ADC_USERNAME='you@example.com' ADC_PASSWORD='…' ADC_MFA_TOKEN='…' node scripts/probe.mjs
```

The password and MFA prompts do not echo. No secret is printed to the terminal or written to disk — the run reports cookie *names* and a truncated hint of the anti-CSRF value so you can confirm the session worked without exposing it.

## Getting `ADC_MFA_TOKEN`

If two-factor authentication is enabled, set `ADC_MFA_TOKEN` to the `twoFactorAuthenticationId` browser cookie — not a six-digit authenticator code. Capture steps and why to treat it like a password: [docs/AUTH.md](../docs/AUTH.md).

## Safety

Two constraints are built in, and both matter:

- **Alarm.com locks accounts that authenticate or poll too aggressively.** The probe uses a single login for the whole run and spaces every request 1.5 seconds apart.
- **Capability discovery issues `GET` requests only.** This is a live security system. Probing an unknown endpoint with `POST` could arm, disarm, or unlock something, so nothing in this script is capable of changing state.

## Output

`probe-output/` is git-ignored. Payloads are scrubbed before they are written — identifiers are pseudonymized consistently (so cross-references between documents still resolve), device names are replaced, and MAC addresses and IP addresses are zeroed. The scrubber is best-effort: read the files before sharing them or promoting them into `tests/fixtures/`.
