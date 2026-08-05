---
name: Bug Report
about: Report a bug to help us improve
title: '[Bug] '
labels: bug
assignees: ''
---

## Description
A clear description of what the bug is.

## Environment

- **Plugin version**: 
- **Homebridge version**: 
- **Node.js version**: 
- **Operating system**: 

## Steps to Reproduce

1. 
2. 
3. 

## Expected Behavior
What you expected to happen.

## Actual Behavior
What actually happened.

## Logs

The most useful log comes from setting both of these in the plugin config, restarting, and reproducing the problem:

```json
{ "debug": true, "diagnosticsInterval": 300 }

DEBUG lines also require Homebridge Debug Mode (the -D flag, or
Settings -> Homebridge Debug Mode in the UI). Both changes need a restart.
```

Then include the `Health:` lines and the surrounding output. Each line is prefixed with the component that produced it — `[auth]`, `[api]`, `[events]`, `[platform]`, and so on.

**Read it before pasting.** Credentials and cookies are redacted automatically, but device names and Alarm.com identifiers are not, so a log describes your home's layout and activity.

<details>
<summary>Click to expand logs</summary>

```
Paste logs here, after redacting device names and system/device IDs if you would rather not share them
```

</details>

## Additional Context
Any other context about the problem.
