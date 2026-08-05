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
| `lib/cli.mjs` | `--help`, flag reading, and numeric flag validation shared by every script. |
| `lib/plugin-logger.mjs` | Wraps a terminal logger in the plugin's own redaction, for the scripts that drive `dist/`. |

Every script takes `--help`, and `--help` works before the project is built. Each script exits non-zero with an actionable message when a credential is missing, when there is no terminal to prompt at, or when a numeric flag is malformed — rather than silently skipping the phase that flag configures. Numeric flags are validated before anything spends a login.

`probe --ws` needs Node 22 or newer for the global `WebSocket`; on Node 20 it says so and skips the event capture rather than failing after the login.

They answer different questions. `probe.mjs` reimplements the protocol in order to *discover* it, and is the right tool when Alarm.com changes something and you need to find out what. `verify.mjs` exercises the code that actually ships, and is the right tool for confirming a change behaves correctly against real hardware. `watch-arming.mjs` observes rather than interprets, which is what you want when the question is "what does Alarm.com actually send when I do this?"

## Verifying the plugin against real hardware

```bash
npm run verify                        # build, discover, show mappings, listen 90s
node scripts/verify.mjs --listen 300  # longer window, e.g. while walking the house
node scripts/verify.mjs --verbose     # include every frame, not just decoded ones
node scripts/verify.mjs --arm stay    # send one arming command: stay, away, or disarm
node scripts/verify.mjs --arm-cycle   # arm stay, watch it settle, then disarm again
```

These need a build. `npm run verify` builds first; running the file directly does not, and will tell you so.

It prints each sensor's raw `state` and `openClosedStatus` alongside the HomeKit value the plugin derives, so a mapping error is visible by reading it against what you can see with your own eyes. Anything the plugin cannot resolve confidently is flagged `AMBIGUOUS`.

Listening is how the remaining protocol gaps get closed: walk past a motion sensor while it runs and the event, the device it resolves to, and the re-read state all appear together.

`--arm` and `--arm-cycle` are the only parts that write, and both really do command the panel. Each requires typing the action name to confirm. On a read-only account the resulting refusal is itself the useful output, since it pins down the error shape. Everything else is `GET` only.

`--arm-cycle` attempts a disarm on its way out, including after Ctrl-C, and a second Ctrl-C during that disarm is ignored with a message rather than killing the process mid-disarm — the handler stays installed *through* the disarm, not just up to it. Leaving someone's house armed because a development script exited badly is not an acceptable outcome.

`--arm` on its own deliberately does *not* disarm afterwards, and says so once the command is accepted. Ctrl-C from there stops the event listener and leaves the panel armed.

The output lists your device names and which doors are currently open. Treat it as sensitive.

## Watching a real arm or disarm

```bash
npm run watch-arming                       # run until interrupted
node scripts/watch-arming.mjs --minutes 5  # stop on its own after 5 minutes
```

This one never writes anything. Start it, then arm or disarm from the Alarm.com app, and it records what arrives: raw event frames with their fields decoded, and a poll-driven diff of every partition and sensor attribute that changed. Attribute changes that no event announced are flagged, which is how you find the state transitions the event stream does not tell you about.

On exit it prints a timeline and writes a scrubbed, timestamped JSON capture to `probe-output/`, so a second run does not overwrite the first. Ctrl-C exits `130` rather than `0`, so a wrapper can tell an interrupted watch from a completed one. The arming behaviour recorded in [docs/PROTOCOL.md](../docs/PROTOCOL.md) came from this script.

## Running the probe

```bash
node scripts/probe.mjs             # prompts for credentials
node scripts/probe.mjs --ws 60     # also listen 60s for WebSocket events
```

The password and MFA prompts do not echo. No secret is printed to the terminal or written to disk: the run reports cookie *names* and a non-reversible scrypt fingerprint of the anti-CSRF value, so you can confirm the session worked and tell one token from another without exposing either.

Credentials may be supplied as environment variables instead — needed for a non-interactive run, and the only way to run these scripts without a terminal:

```bash
ADC_USERNAME='you@example.com' ADC_PASSWORD='…' ADC_MFA_TOKEN='…' node scripts/probe.mjs
```

Prefer the prompts when a terminal is available. Inline assignments land in your shell history and are visible to other local users in `ps` output for the lifetime of the process. If you must use them, `read -rs` into a variable first, or at minimum prefix the command with a space where your shell honours `HISTCONTROL=ignorespace`.

## Getting `ADC_MFA_TOKEN`

If two-factor authentication is enabled, set `ADC_MFA_TOKEN` to the `twoFactorAuthenticationId` browser cookie — not a six-digit authenticator code. Capture steps and why to treat it like a password: [docs/AUTH.md](../docs/AUTH.md).

## Diagnosing a stream that will not connect

```bash
npm run diagnose-stream               # build, then try each client and encoding
node scripts/diagnose-stream.mjs --verbose
```

It opens and immediately closes one socket per client/encoding combination and reports which ones the server accepts. Read-only. Like the plugin, it refuses to send the live stream token to an endpoint that is not `wss:` on an `alarm.com` host, falling back to the known-good default and saying so.

## Safety

Two constraints are built in, and both matter:

- **Alarm.com locks accounts that authenticate or poll too aggressively.** The probe uses a single login for the whole run and spaces every request 1.5 seconds apart.
- **Capability discovery issues `GET` requests only.** This is a live security system. Probing an unknown endpoint with `POST` could arm, disarm, or unlock something, so nothing in this script is capable of changing state.
- **Interrupting the probe keeps what it captured.** A run spends a login, which is the operation Alarm.com polices hardest, so Ctrl-C leaves the fixtures already written in place rather than discarding the whole run.
- **Scripts that drive `dist/` log through the plugin's own redaction.** The "every line is redacted" guarantee belongs to the plugin's logger, not to its components, so a script that supplied a plain stdout logger would opt out of it — and `ws` reports a malformed endpoint by throwing the whole URL, token included.

## Output

`probe-output/` is git-ignored. Payloads are scrubbed before they are written — identifiers are pseudonymized consistently (so cross-references between documents still resolve), device names are replaced, MAC and IP addresses are zeroed, contact details are removed regardless of the key they arrive under, and redirect targets are reduced to their path because a post-login redirect query string carries account identifiers. The scrubber is best-effort: read the files before sharing them or promoting them into `tests/fixtures/`.

Terminal output is a different matter. It names your devices and shows which doors are open by design, because that is what makes it useful — so review it separately before pasting it anywhere.
