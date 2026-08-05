# Contributing to homebridge-myalarmcom

Thank you for your interest in contributing! This guide will help you get started.

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/homebridge-myalarmcom.git
   cd homebridge-myalarmcom
   ```
3. Install dependencies:
   ```bash
   npm install
   ```

## Development Workflow

### Running Tests

```bash
npm test              # Run all tests with coverage
npm run typecheck     # Typecheck src/ and the test project
npm run lint          # Check code style
npm run lint:fix      # Auto-fix style issues
```

Node 22 or newer for development, matching what `homebridge` 2.x requires. `nvm use` picks that up from `.nvmrc`. The published plugin still supports Node 20 through Homebridge 1.6, which CI verifies by running the whole toolchain on 20, 22, and 24 — the Node 20 job emits an `EBADENGINE` warning for the dev-only `homebridge` dependency, which is expected and not a failure.

### Code Style

- Use `const`/`let`, never `var`
- Use async/await over raw Promises
- No semicolons, single quotes, trailing commas in multiline literals — `npm run lint:fix` applies all of this
- Add JSDoc comments for public functions
- Comments explain *why*, not *what*. A comment that restates the line below it is noise; a comment recording the defect or the empirical finding that produced the line is the most valuable thing in this repository
- Keep credentials out of logs — never log the account password, the `twoFactorAuthenticationId` cookie, session cookies, the anti-CSRF value, or the event-stream token. Always take a logger from `createScopedLogger`; the redaction guarantee lives there, not in the components
- Never throw out of the platform constructor. Homebridge does not guard that call, and a throw takes down every other plugin on the user's bridge
- Follow existing code patterns

### Working Against a Live Account

Alarm.com publishes no consumer API, so behavior is established empirically rather than from documentation. `npm run probe` captures scrubbed fixtures from a real account for that purpose. Read [scripts/README.md](scripts/README.md) before running it — it explains the rate-limit and read-only constraints that keep a probe run from locking an account or changing the state of a live security system.

Probe output lands in `probe-output/`, which is git-ignored and must never be committed. If you promote a captured payload into `tests/fixtures/`, read the file first and confirm the scrubber caught everything.

### Making Changes

1. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Make your changes
3. Add/update tests
4. Ensure all tests pass: `npm test`. Coverage thresholds are a ratchet set just under actual — raise them when coverage improves, never lower them to make a change pass
5. Ensure typechecking and linting pass: `npm run typecheck && npm run lint`
6. Rebuild `dist/`: `npm run build`. It is committed to the repository, and CI fails if it has drifted from `src/`. See [DEVELOPMENT.md](DEVELOPMENT.md#committed-dist).
7. Commit with a descriptive message, including the `dist/` changes

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org). PR titles drive automated releases via release-please, so use prefixes like:

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation only
- `test:` - Test changes
- `refactor:` - Code refactoring

Example: `feat: add night arming support for partitions`

## Pull Request Process

1. Update documentation if needed
2. Ensure CI passes (tests, linting)
3. Request review from maintainers

> `CHANGELOG.md` is generated automatically by release-please from your Conventional Commit / PR titles — do not edit it by hand. See [RELEASING.md](RELEASING.md).

### PR Checklist

- [ ] Tests added/updated
- [ ] Linting passes
- [ ] `dist/` rebuilt and committed alongside the `src/` change
- [ ] Documentation updated
- [ ] No credentials, cookies, account identifiers, or unscrubbed probe output in the diff
- [ ] Descriptive PR title (Conventional Commits)

## Adding Device Support

See [DEVELOPMENT.md](DEVELOPMENT.md#adding-new-device-support) for details on adding support for new Alarm.com device types.

## Reporting Bugs

Use the GitHub issue template. Include:
- Homebridge version
- Plugin version
- Node.js version
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs, with sensitive data redacted (Alarm.com username and password, the `twoFactorAuthenticationId` cookie, session cookies, and system/device identifiers)

## Feature Requests

Open an issue with:
- Clear description of the feature
- Use case / why it's needed
- Any implementation ideas

## Questions?

Open a discussion on GitHub or check existing issues.

---

Thank you for contributing! 🎉
