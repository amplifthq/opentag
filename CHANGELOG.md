# Changelog

## Unreleased

### Security

- Run admission on public GitHub/GitLab repositories now requires
  platform-reported write access by default. GitHub commenters are checked via
  the repository collaborator permission API when the GitHub App path is used;
  GitLab Note Hooks carry no access level, so public GitLab projects stay
  closed until `allowedActors` is configured on the repository binding.
  Private repositories, Slack, and Lark behavior is unchanged, and an explicit
  `allowedActors` list still overrides the default for write-capable runs.
- Source-thread approvals (`apply`, `approve`, ...) from public GitHub/GitLab
  threads follow the same default: without an `allowedActors` list, only
  actors with write access can approve or apply proposed actions.
- The Claude Code executor now matches the Codex executor's protections: it
  runs the pre-execution security assessment, spawns `claude` with a scrubbed
  environment (secrets-like variables are dropped; add auth variables to
  `security.extraSafeEnv` if the CLI authenticates from environment), and
  executes in an isolated git worktree instead of a branch in the main
  checkout.
- Codex runs admitted without a write scope now use the read-only sandbox
  (`--sandbox read-only`) instead of `--full-auto`, so granted permission
  scopes are enforced at the executor level.
- Claude Code runs admitted without `repo:write` now use `--permission-mode
  plan`; repo-write runs default to `acceptEdits` unless a narrower
  `permissionMode` is configured.
- Enabling `dangerouslySkipPermissions` for Claude Code now emits an audit
  warning on every run so the bypass stays visible in the run timeline.

## v0.3.0 - 2026-06-30

OpenTag 0.3.0 improves the local CLI setup path and makes source-thread
approvals clearer in Slack and GitHub.

### Added

- Slack source-thread action buttons for `apply`, `approve`, `reject`, and
  `continue`
- Slack Events API and Socket Mode handling for interactive Block Kit actions
- Slack source-message receipt reactions with a text acknowledgement fallback
- Custom executor command support in CLI setup and local runtime config
- Structured executor report parsing for Codex and Claude Code summaries
- GitHub suggested-action rendering with clearer action details and verification
  rows
- Real Slack UI trigger dogfood script for live end-to-end validation

### Changed

- Slack final callbacks are quieter and keep internal proposal metadata out of
  the main thread
- GitHub and Slack action decisions now route through the same source-thread
  action path as typed commands
- Executor summaries avoid presenting source-control handoff steps as manual
  user blockers
- `opentag doctor` catches deprecated Codex model tiers
- Public README setup flow now points users at the published CLI first

### Fixed

- Common repository-edit requests for extensionless files such as `Dockerfile`
  and `Makefile` receive the right local write scope
- GitHub suggested-action details keep summary-only verification rows visible
- Slack receipt delivery is bounded without silently losing acknowledgement
  fallback behavior

### Packages

- `@opentag/cli`
- `@opentag/local-runtime`
- `@opentag/core`
- `@opentag/client`
- `@opentag/dispatcher`
- `@opentag/github`
- `@opentag/lark`
- `@opentag/slack`
- `@opentag/telegram`
- `@opentag/runner`
- `@opentag/store`

## v0.2.0 - 2026-06-29

Coordinated package release that made the local CLI the primary published entry
point.

### Added

- Published `@opentag/cli` package with the `opentag` binary
- Published `@opentag/local-runtime`
- Published Lark / Feishu and Telegram adapter packages
- CLI setup, doctor, status, config, platform, and executor commands
- Release preflight that builds, packs, installs, and verifies the published
  CLI command from tarballs

### Changed

- README and release docs now point users at `npm install -g @opentag/cli` and
  `npx @opentag/cli`
- Public package versions are aligned across the `@opentag/*` package family

## v0.1.0 - 2026-06-24

Initial public v0 release of OpenTag.

### Added

- Core OpenTag event and run schemas
- GitHub issue and pull request comment mention normalization
- Slack app mention normalization
- Embeddable dispatcher package
- SQLite-backed store package
- Local daemon for polling and running assigned work
- Echo executor for local smoke tests
- Codex executor adapter
- GitHub and Slack callback helpers
- Local GitHub-to-echo smoke-test example
- Public `@opentag/*` npm package family

### Packages

- `@opentag/core`
- `@opentag/client`
- `@opentag/dispatcher`
- `@opentag/github`
- `@opentag/slack`
- `@opentag/store`
- `@opentag/runner`

### Notes

OpenTag is still a young v0 project. This release is intended for local evaluation, integration experiments, and early SDK feedback. Production multi-tenant dispatcher deployments need additional hardening.
