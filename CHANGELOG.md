# Changelog

## Unreleased

No changes yet.

## v0.5.0 - 2026-07-14

OpenTag 0.5.0 adds Discord, Linear, and Microsoft Teams adapters and moves
agent execution onto durable, governed Attempts. It is a coordinated release
of all 15 public packages and contains breaking Client and Runner contract
changes described below.

### Added

- Published `@opentag/discord`, `@opentag/linear`, and `@opentag/teams` as
  first-class members of the coordinated package family.
- Discord Gateway and interactions-webhook ingest, channel replies, runtime
  readiness checks, and local-first CLI setup.
- Linear webhook ingest, issue comments, OAuth/API-key setup, workspace
  discovery, issue creation and mutation application, and source-thread action
  receipts.
- Microsoft Teams Bot Framework webhook ingest, tenant-aware authentication,
  channel replies, action application, and CLI/runtime setup.
- A generic stdio ACP host backed by the official ACP SDK. Named ACP agents can
  execute repository Attempts in isolated worktrees or ordinary non-repository
  Attempts in attempt-scoped scratch workspaces.
- Durable Attempt records with monotonically numbered claims, lease recovery,
  opaque fencing tokens, and attempt-scoped cancellation.
- Provider-neutral Channel protocol objects for normalized inbound messages,
  Run Card updates, approval prompts, action receipts, and final summaries.
- Governed ACP permission requests with `allow_once`, `allow_run`, and `deny`
  decisions delivered through the existing source-thread approval path.
- Material Action records for external side effects such as push, deploy,
  publish, and connector writes. Actions now carry stable IDs and idempotency
  keys, store normalized receipts, prevent duplicate execution, and require an
  explicit administrative reconciliation when an outcome remains `unknown`.
- Source-thread runtime controls and richer action receipts across supported
  chat and repository providers, plus local ledger/status evidence for runs,
  Attempts, artifacts, callbacks, and apply outcomes.

### Changed

- Every mutating runner operation now belongs to the active Attempt. Claims
  return `attemptId`, `attemptNumber`, and `fencingToken`; mark-running,
  heartbeat, progress, completion, permission, and material-action receipt
  calls must send the active Attempt lease.
- Lease expiry interrupts the prior Attempt before a new claim is issued. A
  stale worker receives `409 { "error": "stale_attempt" }` and can no longer
  append progress, complete the Run, resolve permissions, or write receipts.
- Agent integrations now use ACP instead of the unshipped
  `opentag.executor.v1` / `stdio-jsonl-basic` protocol. ACP sessions are
  disposable runtime state below durable Runs and Attempts.
- Repository execution uses OpenTag-owned isolation while non-repository ACP
  work uses scratch isolation. Failed, refused, cancelled, and interrupted ACP
  Attempts retain their workspace evidence instead of publishing a commit.
- Source-thread presentation is quieter: routine ACP/tool progress remains in
  audit evidence, while approvals, blockers, material-action receipts, and
  final summaries remain visible to people.
- CLI setup, start, status, doctor, pairing, service, and capability discovery
  now cover the expanded adapter family, ACP agent profiles, runtime readiness,
  secret readiness, and the installed CLI version.
- GitHub and GitLab source threads can run status/doctor/stop controls without
  creating a new Run, and supported source-thread actions reuse the governed
  approval/apply path.

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
- Fencing tokens are accepted only on authenticated runner mutation requests.
  They are redacted from Attempt records, audit events, callbacks, errors,
  snapshots, logs, and material-action receipts.
- ACP children receive a scrubbed environment, an explicit contained workspace,
  strict NDJSON framing, bounded cancellation, and no dispatcher/channel
  credentials. Child stderr and raw ACP frames do not enter durable Run results
  or source-thread messages.
- Credential-like values, local absolute paths, hidden reasoning, and provider
  secrets are sanitized at progress, completion, receipt, callback, and
  control-plane boundaries.
- Channel roles and ACP agent roles use separate credentials, lifecycle, and
  capability grants; a channel integration cannot silently inherit executor
  authority.
- Attempt lifecycle state and its audit evidence commit atomically so a failed
  evidence write cannot leave a partially advanced lease or terminal Run.

### Migration: Client and custom runners

`@opentag/client` consumers that claim Runs must keep the lease returned by
`claim` and pass it to every mutation:

```ts
import { createOpenTagClient } from "@opentag/client";

const runnerId = "runner_custom";
const client = createOpenTagClient({
  dispatcherUrl: "http://localhost:3030",
  pairingToken: process.env.OPENTAG_PAIRING_TOKEN
});

const claimed = await client.claim({ runnerId });
if (!claimed) throw new Error("No Run available");

const lease = {
  attemptId: claimed.attemptId,
  fencingToken: claimed.fencingToken
};

await client.markRunning({
  runnerId,
  runId: claimed.run.id,
  ...lease,
  executor: "custom"
});
await client.heartbeat({ runnerId, runId: claimed.run.id, ...lease });
await client.progress({
  runnerId,
  runId: claimed.run.id,
  ...lease,
  type: "executor.progress",
  message: "Working on the request"
});
await client.complete({
  runnerId,
  runId: claimed.run.id,
  ...lease,
  result: { conclusion: "success", summary: "Done" }
});
```

- `createDispatcherClient` callers must pass the lease as the new argument to
  `markRunning(runId, executor, lease, options)`, `heartbeat(runId, lease)`,
  `progress(runId, lease, input)`, and
  `complete(runId, lease, result, options)`.
- Direct HTTP runners must use the runner-scoped `/v1/runners/:runnerId/runs/*`
  endpoints and include `attemptId` plus `fencingToken` in every mutation body.
  The old unscoped running/progress/complete endpoints now return `410`.
- Treat `stale_attempt` as loss of ownership: cancel local execution and do not
  retry the mutation with the expired lease. Never log or persist a fencing
  token outside the active runner process.
- Custom `@opentag/runner` adapters must replace `input.workspacePath` with
  `input.workspace.path` (or `executorWorkspacePath(input)`). The workspace is
  now explicitly `{ kind: "repository" | "scratch", path }`, and
  `cancel(runId, attemptId?)` may receive the Attempt to cancel.
- Adapters that execute material side effects should use the injected
  `permissionResolver` before execution and `materialActionReporter` afterward
  so the action remains fenced, receipted, and retry-safe.
- Integrations built on the removed custom stdio protocol must migrate their
  manifest to an ACP agent role and use `createAcpExecutor`.

### Packages

- `@opentag/core`
- `@opentag/client`
- `@opentag/discord`
- `@opentag/github`
- `@opentag/gitlab`
- `@opentag/lark`
- `@opentag/linear`
- `@opentag/runner`
- `@opentag/slack`
- `@opentag/store`
- `@opentag/teams`
- `@opentag/telegram`
- `@opentag/dispatcher`
- `@opentag/local-runtime`
- `@opentag/cli`

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
