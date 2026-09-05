# Releasing

Releases are fully automated with [release-please](https://github.com/googleapis/release-please). Versions, `CHANGELOG.md`, git tags, GitHub Releases, and `npm publish` are all derived from commit messages — none are edited or run by hand.

## Flow

1. A branch is created and changes are committed.
2. A PR is opened with a **Conventional Commit title**. The title determines the next version when the PR is squash-merged into `main`:

   | PR title prefix                                   | Example                                | Version bump |
   | ------------------------------------------------- | -------------------------------------- | ------------ |
   | `fix:`, `perf:`                                   | `fix: handle 409 two-factor challenge` | patch (1.0.0 → 1.0.1) |
   | `feat:`                                           | `feat: add night arming support`       | minor (1.0.0 → 1.1.0) |
   | `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer | `feat!: drop Node 20`                  | major (1.0.0 → 2.0.0) |
   | `chore:`, `docs:`, `refactor:`, `test:`, `ci:`    | `docs: fix typo`                       | no release |

   From `1.0.0` onward these are normal SemVer meanings: a `feat:` is a minor bump and a breaking change is a major bump. The repo still sets `bump-minor-pre-major` / `bump-patch-for-minor-pre-major` in `release-please-config.json`, but those only damp bumps while the version is below `1.0.0`.

3. The **Tests** workflow runs on the PR (matrix: Node 22, 24, 26, plus a security audit). The PR is squash-merged to `main`.
4. **release-please** opens or updates a **Release PR** titled `chore(main): release X.Y.Z`. It carries the version bump in `package.json` and the generated `CHANGELOG.md` entries. Multiple code PRs merged before a release are batched into one Release PR.
5. Merging the Release PR triggers the `release.yml` workflow, which:
   - creates the `vX.Y.Z` git tag,
   - publishes a GitHub Release with the changelog notes,
   - runs the `publish` job (build → typecheck → lint → test → `npm publish --dry-run` → `npm publish --provenance --access public`) on Node 24.

A release therefore reduces to: merge the code PR(s), approve the Release PR's checks, then merge the Release PR.

## Recovery

`release.yml` has three triggers, so a run that failed after tagging does not need the tag deleting:

- **Push to `main`** — the normal path; this is what release-please's merge produces.
- **`release: published`** — publishing the GitHub Release by hand re-triggers the `publish` job. Use this when the tag and Release exist but the publish step failed.
- **`workflow_dispatch`** — run it manually from the Actions tab.

All three converge on the same `publish` job, which re-verifies build, typecheck, lint, and tests before publishing, so none of them can ship something untested.

## Approve the Release PR checks

The Release PR is authored by `github-actions[bot]`, because `release.yml` passes `github.token` to release-please. GitHub creates its checks but holds them until a user with write access approves.

**Open the Release PR's Checks tab and click "Approve and run" before merging.**

- There is no CLI for this. `POST /actions/runs/{run_id}/approve` is documented for forks from first-time contributors and does not cover this gate.
- The approval does not stick. It is needed on every release, and again whenever release-please updates an open Release PR.
- **Merging without approving turns the runs red.** They finalise as `failure` with zero jobs and no logs. That means nobody approved them, not that anything broke.

This gate arrived with GitHub's [bot-created pull requests change](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/) and reached these repos in late August 2026. It applies to same-repo branches, not just forks, and has no repository-level opt-out. The only way to remove the step is to author the Release PR as a different identity, which needs a GitHub App or a PAT. Neither is set up here, and the click is cheaper.

## Branch protection

`main` is protected with settings chosen to be compatible with the automated flow above:

- **Require a pull request before merging** (0 required approvals) — keeps direct pushes off `main` without blocking a solo maintainer.
- **Block force-pushes and deletions.**
- **No required status checks.** The Tests workflow runs on every code PR and is visible there, but it is intentionally *not* a hard merge gate. The Release PR's own checks are held for approval, so a required check there would sit unresolved until someone approves it. The `publish` job re-runs the whole gate — build, typecheck, lint, test — before `npm publish`, so releases are still gated on a green build. That job is deliberately not weaker than the one a code PR passes.

> Required checks on the Release PR are now possible, because its runs do execute once approved. They would make approval mandatory instead of advisory. Removing the approval step altogether needs a GitHub App or a PAT.

## Publishing authentication

Publishing uses **npm Trusted Publishing (OIDC)** — there is no `NPM_TOKEN` secret. The package is linked to this repo's `release.yml` workflow on npmjs.com:

- Package → **Settings → Trusted Publisher** (Publishing access)
- GitHub Actions publisher: organization/user `tbaur`, repository `homebridge-myalarmcom`, workflow `release.yml`, no environment.

This link only needs to exist before the first Release PR is merged; it does not need to be reconfigured per release.

## Forcing a version

To ship an exact version (for example graduating `0.x` to `1.0.0`), put a `Release-As:` footer on the squash commit that lands on `main`:

```text
feat: graduate to 1.0.0

Release-As: 1.0.0
```

This repository's squash merge setting uses the PR title as the subject and a **blank** body, so a footer in the PR description alone is discarded. When merging with `gh`, pass the footer explicitly:

```bash
gh pr merge <n> --squash \
  --subject "feat: graduate to 1.0.0" \
  --body "Release-As: 1.0.0"
```

release-please then opens a Release PR for that version. Do not hand-edit `package.json`, `.release-please-manifest.json`, or `CHANGELOG.md`.

## Notes

- **PR titles drive releases.** With squash merges, the PR title becomes the commit release-please reads. `chore:`/`docs:`/`ci:` titles intentionally produce no release.
- **The Release PR's checks wait for approval.** They do not run on their own, and go red if the PR is merged first. See [Approve the Release PR checks](#approve-the-release-pr-checks). The code was already tested on its own PR, and the `publish` job builds, lints and tests again before publishing, so nothing ships untested.
- **Version source of truth** is `.release-please-manifest.json`. The `package.json` version is owned by release-please and is not hand-edited.
- Behavior is configured in `release-please-config.json`.

## Manual fallback

Manual publishing is rarely needed and bypasses CI provenance and manifest syncing. If unavoidable:

```bash
npm run clean && npm run build && npm run lint && npm run typecheck && npm test
npm publish --dry-run                  # verify contents
npm publish --access public            # requires npm login + OTP
```

Provenance is unavailable outside CI, so a manually published version carries none. Prefer the `release: published` recovery trigger above.
