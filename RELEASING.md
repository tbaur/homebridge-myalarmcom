# Releasing

Releases are fully automated with [release-please](https://github.com/googleapis/release-please). Versions, `CHANGELOG.md`, git tags, GitHub Releases, and `npm publish` are all derived from commit messages — none are edited or run by hand.

## Flow

1. A branch is created and changes are committed.
2. A PR is opened with a **Conventional Commit title**. The title determines the next version when the PR is squash-merged into `main`:

   | PR title prefix                                   | Example                                | Version bump (pre-1.0) |
   | ------------------------------------------------- | -------------------------------------- | ---------------------- |
   | `fix:`                                            | `fix: handle 409 two-factor challenge` | patch (0.1.0 → 0.1.1)  |
   | `feat:`                                           | `feat: add night arming support`       | patch (0.1.0 → 0.1.1)  |
   | `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer | `feat!: drop Node 20`                  | minor (0.1.0 → 0.2.0)  |
   | `chore:`, `docs:`, `refactor:`, `test:`, `ci:`    | `docs: fix typo`                       | no release             |

   The bumps above are damped while the version is below `1.0.0`, because `release-please-config.json` sets `bump-minor-pre-major` and `bump-patch-for-minor-pre-major`. A `0.x` release therefore never implies API stability that does not exist yet. Once `1.0.0` ships, the same prefixes resume their normal meaning: `feat:` becomes a minor bump and a breaking change becomes a major one.

3. The **Tests** workflow runs on the PR (matrix: Node 20, 22, 24, plus a security audit). The PR is squash-merged to `main`.
4. **release-please** opens or updates a **Release PR** titled `chore(main): release X.Y.Z`. It carries the version bump in `package.json` and the generated `CHANGELOG.md` entries. Multiple code PRs merged before a release are batched into one Release PR.
5. Merging the Release PR triggers the `release.yml` workflow, which:
   - creates the `vX.Y.Z` git tag,
   - publishes a GitHub Release with the changelog notes,
   - runs the `publish` job (build → lint → test → `npm publish` with provenance) on Node 24.

A release therefore reduces to: merge the code PR(s), then merge the Release PR.

## Branch protection

`main` is protected with settings chosen to be compatible with the automated flow above:

- **Require a pull request before merging** (0 required approvals) — keeps direct pushes off `main` without blocking a solo maintainer.
- **Block force-pushes and deletions.**
- **No required status checks.** The Tests workflow runs on every code PR and is visible there, but it is intentionally *not* a hard merge gate. The Release PR is opened by the built-in `GITHUB_TOKEN`, and GitHub does not trigger workflows for such PRs (loop prevention), so a required check would leave every Release PR permanently unmergeable. The `publish` job re-runs build → lint → test before `npm publish`, so releases are still gated on a green build.

> If enforced required checks on the Release PR are ever wanted, the only way to get them is to have release-please open its PR with a Personal Access Token instead of the built-in token, so the Tests workflow fires. That trades a stored secret for enforced checks; the current setup avoids the secret.

## Publishing authentication

Publishing uses **npm Trusted Publishing (OIDC)** — there is no `NPM_TOKEN` secret. The package is linked to this repo's `release.yml` workflow on npmjs.com:

- Package → **Settings → Trusted Publisher** (Publishing access)
- GitHub Actions publisher: organization/user `tbaur`, repository `homebridge-myalarmcom`, workflow `release.yml`, no environment.

This link only needs to exist before the first Release PR is merged; it does not need to be reconfigured per release.

## Notes

- **PR titles drive releases.** With squash merges, the PR title becomes the commit release-please reads. `chore:`/`docs:`/`ci:` titles intentionally produce no release.
- **The Release PR does not re-run the Tests workflow.** GitHub does not trigger workflows for PRs opened by the built-in token (loop prevention). The code was already tested on its own PR, and the `publish` job builds, lints, and tests again before publishing, so nothing ships untested.
- **Version source of truth** is `.release-please-manifest.json`. The `package.json` version is owned by release-please and is not hand-edited.
- Behavior is configured in `release-please-config.json`.

## Manual fallback

Manual publishing is rarely needed and bypasses CI provenance and manifest syncing. If unavoidable:

```bash
npm run clean && npm run build && npm run lint && npm test
npm publish --dry-run   # verify contents
npm publish             # requires npm login + OTP
```
