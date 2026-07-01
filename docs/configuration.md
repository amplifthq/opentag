# Configuration

This guide explains which OpenTag process reads which settings. Use it as the
configuration map, then jump to the runnable examples for end-to-end commands:

- [GitHub to echo](../examples/github-to-echo/README.md)
- [Real integration smoke test](./real-integration-smoke-test.md)
- [Embedded dispatcher](../examples/embedded-dispatcher/README.md)

## Configuration Layers

OpenTag has five runtime surfaces today:

| Surface | Process | Owns |
| --- | --- | --- |
| Dispatcher | `apps/dispatcher` | Run storage, leases, callbacks, pairing token checks |
| Local daemon | `apps/opentagd` | Runner identity, Project Target bindings, local checkout paths, executor settings |
| GitHub ingress | `@opentag/cli` / `apps/github-probot` | Repository webhooks or GitHub App webhooks and GitHub event normalization |
| Slack ingress | `@opentag/cli` / `apps/slack-events` | Slack Socket Mode or Events API transport and Slack event normalization |
| Telegram ingress | `apps/telegram-events` | Telegram webhook ingestion and Telegram event normalization |

Keep these boundaries separate. Ingress apps should know how to receive platform
events and create runs. The dispatcher should coordinate runs and callbacks. The
daemon should decide whether it can claim and execute work for a bound Project Target.

## Local Daemon Config

`opentagd` prefers a JSON config file. Point to it with `OPENTAG_CONFIG_PATH`.
When `OPENTAG_CONFIG_PATH` is set, the daemon reads that file and does not build
Project Target bindings from the environment fallback variables.

Minimal local config:

```json
{
  "runnerId": "runner_local",
  "dispatcherUrl": "http://localhost:3030",
  "pairingToken": "dev_pairing_token",
  "runnerToken": "dev_runner_token",
  "pollIntervalMs": 5000,
  "heartbeatIntervalMs": 15000,
  "runTimeoutMs": 1800000,
  "repositories": [
    {
      "provider": "github",
      "owner": "acme",
      "repo": "demo",
      "checkoutPath": "/absolute/path/to/demo",
      "defaultExecutor": "echo",
      "baseBranch": "main",
      "pushRemote": "origin",
      "keepWorktree": "on_failure"
    }
  ]
}
```

Add Slack channel bindings when a chat surface should route work to a Project Target:

```json
{
  "slackChannels": [
    {
      "teamId": "T123",
      "channelId": "C123",
      "repoProvider": "github",
      "owner": "acme",
      "repo": "demo"
    }
  ]
}
```

Add generic channel bindings when a non-Slack chat surface should route work to
a Project Target:

```json
{
  "channelBindings": [
    {
      "provider": "telegram",
      "accountId": "bot_123",
      "conversationId": "456",
      "repoProvider": "github",
      "owner": "acme",
      "repo": "demo"
    }
  ]
}
```

Add Lark channel bindings the same way for a Lark chat or group:

```json
{
  "larkChannels": [
    {
      "tenantKey": "<tenant_key>",
      "chatId": "oc_...",
      "repoProvider": "github",
      "owner": "acme",
      "repo": "demo"
    }
  ]
}
```

Sync these generic bindings with:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- bind-channels
```

Add Claude Code settings when using the built-in `claude-code` executor:

```json
{
  "claudeCode": {
    "command": "claude",
    "model": "sonnet",
    "permissionMode": "acceptEdits"
  }
}
```

Use daemon security settings to keep executor runs constrained:

```json
{
  "security": {
    "mode": "enforce",
    "allowedWorkspaceRoot": "/absolute/path/to/repos",
    "allowUnsafePrompts": false,
    "extraSafeEnv": ["OPENTAG_DEBUG"]
  }
}
```

## Daemon Config Fields

| Field | Default | Notes |
| --- | --- | --- |
| `runnerId` | `runner_local` | Stable identity used by the dispatcher lease and binding tables |
| `dispatcherUrl` | `http://localhost:3030` | Dispatcher base URL |
| `pairingToken` | none | Legacy shared Bearer token for dispatcher `/v1/*` calls and pairing/bootstrap compatibility |
| `runnerToken` | `pairingToken` fallback | Preferred runner-scoped Bearer token for claim, heartbeat, progress, completion, status, cancel, and local hook ingest calls |
| `runnerTokens` | none | Additional runner-scoped tokens accepted by the local dispatcher during a rotation window |
| `revokedRunnerTokenFingerprints` | none | SHA-256 fingerprints of revoked runner tokens that must fail closed |
| `repositories` | `[]` | Current compatibility array for Project Target bindings this daemon is allowed to claim |
| `channelBindings` | none | Generic channel bindings such as Telegram `botId/chatId -> Project Target` |
| `slackChannels` | none | Slack compatibility bindings that map `teamId/channelId` into the generic channel binding table |
| `larkChannels` | none | Lark bindings that map `tenantKey/chatId` into the generic channel binding table |
| `claudeCode` | none | Claude Code executor settings |
| `hermes` | none | Hermes executor command/profile settings; `profile` and `profileTemplate` still override the Hermes CLI `-p` argument |
| `agentSessionProfile` | derived per run | Executor-neutral session identity. Use `profile` for a fixed local agent identity or `profileTemplate` for a stable identity derived from provider, source thread, Project Target, and actor metadata. The `opentag status` session-profile section shows the active rule without embedding local checkout paths or secret values in the session identity. |
| `security` | none | Runner security policy |
| `githubToken` | none | GitHub token for callback comments, dispatcher GitHub apply helpers, and optional legacy PR creation |
| `githubApplyToken` | `githubToken` | Optional dispatcher direct-apply token override. Set to `null` to keep GitHub callbacks enabled while rendering direct-apply actions as setup-required. |
| `preparePullRequestBranch` | `false` | Commits and pushes executor run branches so a later source-thread `apply 1` can create the PR through an ApplyPlan |
| `allowAutoCreatePullRequest` | `false` | Legacy mode that creates a PR immediately when executor results include changes |
| `pollIntervalMs` | `5000` | Poll interval for `serve` |
| `heartbeatIntervalMs` | `15000` | Heartbeat interval for claimed runs |
| `runTimeoutMs` | none | Optional hard timeout for one executor run. When it fires, OpenTag requests cancellation and records the run as `timed_out`. |

`opentag status --run <run_id>` shows the timeout policy for that run. Once the
runner has marked the run as running, the command prefers the run-specific
`run.running` audit payload over the current config default so status output
matches the policy that was active when execution started.

The same run status view also includes relay/audit provenance derived from the
run creation timeline: source delivery id when one exists, webhook signature
state, matched Project Target, admission decision, expected runner, and claimed
runner. This gives operators a local way to answer "why did this run exist, was
the source verified, and which runner was allowed to claim it?" without exposing
checkout paths or secret values in source-thread replies.

## Service Runtime Readiness

`opentag service status` reports two different layers:

- `Running` is the OS controller state. On macOS, this means launchd has the
  OpenTag LaunchAgent loaded.
- `OpenTag runtime` is the OpenTag readiness probe. When the service is running
  and the config is readable, the CLI probes the configured dispatcher
  `/healthz` endpoint and then runs the same core readiness checks as
  `opentag doctor`. A healthy launchd job can still show `unreachable` if the
  dispatcher is not accepting requests yet, or `degraded` if the dispatcher is
  reachable but runner registration, Project Target bindings, local checkout,
  executor capability, or action setup checks are not healthy. The readiness
  probe also checks the runner registration heartbeat so a background process can
  be distinguished from a runner that has actually connected recently.
- `Connectors` is the configured platform readiness summary. It is intentionally
  redacted and local-config based: it shows whether each configured platform has
  the required ingress and callback credentials, source container hints, and
  Project Target information, but it does not print token values or replace the
  runtime probe above. Use it to distinguish "the service process is up" from
  "this platform has enough local config to receive and reply."

Use this distinction when debugging background mode:

```text
Running: running
OpenTag runtime: ready (dispatcher healthz ok (http://localhost:3030))
Connectors:
  github: ingress=repository_webhook path=/github/webhooks port=3050, callback=ready (daemon.githubToken), apply=ready, target=github:acme/demo
```

or:

```text
Running: running
OpenTag runtime: unreachable (dispatcher healthz failed (http://localhost:3030))
```

or:

```text
Running: running
OpenTag runtime: degraded (doctor checks degraded (1 fail, 0 warn))
Runtime Checks:
  FAIL runner registration: getRunner failed: 404 {"error":"runner_not_found"}
```

or:

```text
Running: running
OpenTag runtime: stale_heartbeat (stale; last heartbeat 2026-06-24T00:00:00.000Z ...)
Runtime Checks:
  WARN runner heartbeat: stale; last heartbeat 2026-06-24T00:00:00.000Z ...
```

If the runtime is unreachable, check `opentag service logs`,
`opentag status`, and the platform-specific connector setup before assuming the
LaunchAgent itself is broken. If the runtime is `starting`, wait for the first
runner registration heartbeat. If it is `stale_heartbeat` or `degraded`, use the
listed `Runtime Checks` or run `opentag doctor` for the full diagnosis.

LaunchAgent services do not inherit your interactive shell environment. To keep
local runtime hardening enabled in background mode, persist only the non-secret
dispatcher and ingress thresholds when installing the service:

```bash
opentag service install \
  --max-request-body-bytes 1048576 \
  --rate-limit-window-ms 60000 \
  --rate-limit-max-requests 120
```

These options write `OPENTAG_MAX_REQUEST_BODY_BYTES`,
`OPENTAG_RATE_LIMIT_WINDOW_MS`, and `OPENTAG_RATE_LIMIT_MAX_REQUESTS` into the
LaunchAgent plist next to `OPENTAG_CONFIG_PATH`. `OPENTAG_MAX_REQUEST_BODY_BYTES`
applies to dispatcher JSON endpoints and local public source ingress endpoints
such as Slack Events API and GitHub repository webhooks. They do not copy other
`OPENTAG_*` variables from the shell. Keep secrets in the OpenTag config as
SecretRefs, environment refs resolved by the service process, or a local secret
manager rather than writing raw token values into the plist.

`opentag status` and `opentag service status` also include a `Secrets` section,
and `opentag doctor` includes the same redacted credential sources as a doctor
check. These surfaces report secret sources such as `inline (redacted)`,
`env ref`, `file ref`, `keychain ref`, or fallback state. They never print
resolved secret values. Use them to confirm that the runtime is using SecretRef
entries instead of only relying on config file permissions. If a SecretRef
cannot be resolved, `opentag doctor` reports a credential resolution failure
alongside the redacted reference so the missing env/file/keychain entry is
actionable without exposing the secret.

## Local Hook Ingest

External local agent runtimes can report progress or completion through the CLI
without exposing a new public webhook. `opentag ingest` reads the same local
config as the daemon, requires the configured `runnerId`, `dispatcherUrl`, and
`runnerToken` (or legacy `pairingToken` fallback), and calls the runner-scoped
dispatcher endpoints. The token can be stored inline for local development or
resolved through a SecretRef such as `{ "kind": "env", "name": "OPENTAG_RUNNER_TOKEN" }`.
`opentag doctor` and `opentag service status` report `hook ingest auth` so an
unauthenticated runner API is visible before external hooks start reporting.

Progress events stay audit-visible by default and do not create source-thread
callbacks. The CLI hook path intentionally keeps external runtime detail in
audit/status instead of posting it into the human thread:

```bash
opentag ingest --run run_123 --event progress --source hermes --idempotency-key hermes:run_123:progress:started --message "post_llm_call completed"
opentag ingest --run run_123 --event post_llm_call --source hermes --idempotency-key hermes:run_123:progress:post_llm_call --message "LLM call completed."
opentag ingest --run run_123 --event before_agent_finalize --source hermes --idempotency-key hermes:run_123:progress:before_agent_finalize --message "Final answer is being prepared."
```

Use the same `--idempotency-key` when retrying the same progress hook delivery.
The dispatcher treats duplicate keys for the same run as a replay: it returns
success but does not append another `run.progress` audit event or source-thread
progress callback.

The same replay rule applies to runner lifecycle calls that mark a run as
running or completed. Local daemon runs use a stable `runnerId:runId:running`
key when they enter the running state, so retrying that request does not append a
second `run.running` audit event and does not resend the running liveness
message.

Completion events map external lifecycle names into OpenTag result semantics:

```bash
opentag ingest --run run_123 --event agent_end --idempotency-key hermes:run_123:complete:agent_end --result-json '{"conclusion":"success","summary":"External runtime completed."}'
opentag ingest --run run_123 --event failed --idempotency-key hermes:run_123:complete:failed --message "External runtime failed before finalization."
opentag ingest --run run_123 --event cancelled --idempotency-key hermes:run_123:complete:cancelled --message "Cancelled by external runtime."
opentag ingest --run run_123 --event interrupted --idempotency-key hermes:run_123:complete:interrupted --message "External runtime ended before finalization."
opentag ingest --run run_123 --event timed_out --idempotency-key hermes:run_123:complete:timed_out --message "External runtime exceeded its timeout policy."
```

Common hook aliases are normalized conservatively:

| External event | OpenTag behavior |
| --- | --- |
| `progress`, `agent_progress`, `post_llm_call`, `before_agent_finalize`, `tool_start`, `tool_end` | Adds an audit-visible progress event |
| `agent_end`, `completed`, `complete`, `final` | Completes the run with `success` unless `--result-json` or `--conclusion` says otherwise |
| `failed`, `failure`, `agent_failed`, `agent_error`, `error` | Completes the run with `failure` |
| `cancelled`, `canceled`, `agent_cancelled`, `stop`, `stopped` | Completes the run with `cancelled` |
| `timeout`, `timed_out`, `agent_timeout` | Completes the run with `timed_out` |
| `interrupted`, `agent_interrupted`, `session_end`, `on_session_end` | Completes the run with `interrupted` |

To bootstrap an external runtime hook, print the local shell template and adapt
only the source label and hook placement. Known sources render lifecycle-aware
templates; unknown safe labels fall back to a generic external-runtime template:

```bash
opentag ingest-template --source hermes
opentag ingest-template --source openclaw
opentag ingest-template --source custom-agent
```

External runtime wrappers that prefer a machine-readable contract can request a
manifest instead of a shell script:

```bash
opentag ingest-template --source hermes --format manifest
```

The manifest declares required environment variables, event aliases,
idempotency suffixes, terminal-event semantics, and the hook ingest permission
boundary. Hook ingest itself does not request source-thread transcript access,
does not mutate prompts, does not read raw provider context, and does not
execute source-thread write actions. It reports progress as audit-visible data
and leaves provider-facing final output to OpenTag's concise presentation layer.

The `--source` label is intentionally narrow: use a lowercase local runtime
label such as `hermes`, `openclaw`, or `custom-agent`. Do not pass local paths,
free-form names, or shell fragments.

The generated templates should stay local. They encode common hook placement
aliases, but OpenTag still maps everything into its own lifecycle semantics:
progress hooks are audit-visible by default, `before_agent_finalize` is not a
successful completion signal, and each run should report exactly one terminal
event such as `agent_end`, `agent_failed`, `agent_cancelled`,
`agent_interrupted`, or `agent_timeout`.

Do not pass dispatcher tokens, local paths, or raw executor logs through source
threads. Hook ingest is a local authenticated reporting path; source-thread
callbacks should remain concise and provider-rendered from OpenTag state.

Project Target binding fields:

| Field | Default | Notes |
| --- | --- | --- |
| `provider` | `github` | Project Target provider. GitHub-backed targets use `github`; local-only targets use `local` |
| `owner` | required | Repository owner for GitHub targets, or the stable canonical-path identity for local-only targets |
| `repo` | required | Repository name or readable local Project Target name |
| `checkoutPath` | required | Absolute local path attached to this Project Target |
| `defaultExecutor` | `echo` | `echo`, `codex`, or `claude-code` |
| `baseBranch` | `main` | PR target branch |
| `pushRemote` | `origin` | Remote used for PR branches |
| `worktreeRoot` | none | Optional root for executor-created worktrees |
| `keepWorktree` | `on_failure` | `always`, `on_failure`, or `never` |

## Daemon Environment Fallback

Use environment fallback for one-off local testing. Use `OPENTAG_CONFIG_PATH`
for repeatable setups.

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENTAG_CONFIG_PATH` | none | Path to daemon JSON config. Takes precedence over Project Target env fallback |
| `OPENTAG_RUNNER_ID` | `runner_local` | Runner identity |
| `OPENTAG_DISPATCHER_URL` | `http://localhost:3030` | Dispatcher URL |
| `OPENTAG_REPO_OWNER` | none | Required for env-derived Project Target binding |
| `OPENTAG_REPO_NAME` | none | Required for env-derived Project Target binding |
| `OPENTAG_WORKSPACE_PATH` | none | Required for env-derived Project Target binding |
| `OPENTAG_DEFAULT_EXECUTOR` | `echo` | `echo`, `codex`, or `claude-code` |
| `OPENTAG_BASE_BRANCH` | `main` | PR target branch |
| `OPENTAG_PUSH_REMOTE` | `origin` | Git remote for run branches |
| `OPENTAG_WORKTREE_ROOT` | none | Optional worktree root |
| `OPENTAG_KEEP_WORKTREE` | `on_failure` | `always`, `on_failure`, or `never` |
| `OPENTAG_SLACK_TEAM_ID` | none | Creates one env-derived Slack channel binding when paired with Project Target env |
| `OPENTAG_SLACK_CHANNEL_ID` | none | Creates one env-derived Slack channel binding when paired with Project Target env |
| `OPENTAG_SLACK_REPO_PROVIDER` | `github` | Project Target provider used for the env-derived Slack channel binding |
| `OPENTAG_LARK_TENANT_KEY` | none | Creates one env-derived Lark channel binding when paired with Project Target env |
| `OPENTAG_LARK_CHAT_ID` | none | Creates one env-derived Lark channel binding when paired with Project Target env |
| `OPENTAG_CLAUDE_COMMAND` | `claude` in executor default | Claude Code CLI command |
| `OPENTAG_CLAUDE_MODEL` | none | Optional Claude model |
| `OPENTAG_CLAUDE_PERMISSION_MODE` | none | `acceptEdits`, `auto`, `bypassPermissions`, `default`, or `plan` |
| `OPENTAG_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS` | `false` | Only for explicitly sandboxed environments |
| `OPENTAG_AGENT_PROFILE` | none | Fixed executor-neutral agent session identity |
| `OPENTAG_AGENT_PROFILE_TEMPLATE` | derived per run | Executor-neutral profile template; supports tokens such as `{provider}`, `{projectTarget}`, `{accountId}`, `{conversationId}`, `{owner}`, `{repo}`, `{actorId}`, and `{runId}` |
| `OPENTAG_SECURITY_MODE` | none | `enforce`, `audit`, or `off` |
| `OPENTAG_ALLOWED_WORKSPACE_ROOT` | none | Restricts allowed checkout paths |
| `OPENTAG_ALLOW_UNSAFE_PROMPTS` | `false` | Allows prompts normally rejected by runner security |
| `OPENTAG_EXTRA_SAFE_ENV` | none | Comma-separated env names preserved for executor processes |
| `OPENTAG_GITHUB_TOKEN` | none | GitHub token for callback comments, dispatcher GitHub apply helpers, and optional legacy PR creation |
| `OPENTAG_GITHUB_APPLY_TOKEN` | `OPENTAG_GITHUB_TOKEN` | Optional token override for dispatcher direct-apply helpers |
| `OPENTAG_GITHUB_APPLY_DISABLED` | `false` | Set to `true` to keep callbacks enabled while forcing direct-apply receipts into setup-required state |
| `OPENTAG_PREPARE_PR_BRANCH` | `false` | Pushes executor run branches for thread-native PR creation after approval |
| `OPENTAG_ALLOW_AUTO_CREATE_PR` | `false` | Allows legacy immediate daemon PR creation |
| `OPENTAG_PAIRING_TOKEN` | none | Legacy shared dispatcher token and fallback for runner calls |
| `OPENTAG_RUNNER_TOKEN` | `OPENTAG_PAIRING_TOKEN` fallback | Preferred runner-scoped dispatcher token for claim/progress/completion, status, cancel, and local hook ingest |
| `OPENTAG_POLL_INTERVAL_MS` | `5000` | Poll interval |
| `OPENTAG_HEARTBEAT_INTERVAL_MS` | `15000` | Heartbeat interval |
| `OPENTAG_RUN_TIMEOUT_MS` | none | Optional hard timeout for one executor run |

## Dispatcher Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3030` | Dispatcher HTTP port |
| `OPENTAG_DATABASE_PATH` | `opentag.db` | SQLite database path |
| `OPENTAG_PAIRING_TOKEN` | none | Requires `Authorization: Bearer <token>` for `/v1/*` |
| `OPENTAG_RUNNER_TOKEN` | none | Optional runner-scoped token; when configured, runner claim/heartbeat/progress/completion must use this token instead of `OPENTAG_PAIRING_TOKEN` |
| `OPENTAG_RUNNER_TOKENS_JSON` | none | Optional JSON array of additional runner-scoped tokens accepted during a rotation window |
| `OPENTAG_REVOKED_RUNNER_TOKEN_FINGERPRINTS_JSON` | none | Optional JSON array of SHA-256 fingerprints for revoked runner tokens; revoked runner tokens fail closed with a re-pair message |
| `OPENTAG_MAX_REQUEST_BODY_BYTES` | dispatcher default | Optional positive integer request body limit for dispatcher JSON endpoints and local public source ingress bodies |
| `OPENTAG_RATE_LIMIT_WINDOW_MS` | none | Enables the self-hosted in-process fixed-window limiter when configured together with `OPENTAG_RATE_LIMIT_MAX_REQUESTS` |
| `OPENTAG_RATE_LIMIT_MAX_REQUESTS` | none | Maximum requests per fixed window for the self-hosted dispatcher limiter |
| `OPENTAG_RATE_LIMIT_DISABLED` | `false` | Set to `true` to explicitly leave the dispatcher rate limiter off; cannot be combined with rate-limit window/count variables |
| `OPENTAG_GITHUB_TOKEN` | none | Backward-compatible token used for GitHub callback posting and GitHub apply helpers unless more specific env vars are set |
| `OPENTAG_GITHUB_CALLBACK_TOKEN` | `OPENTAG_GITHUB_TOKEN` | Optional token override for GitHub callback posting |
| `OPENTAG_GITHUB_APPLY_TOKEN` | `OPENTAG_GITHUB_TOKEN` | Optional token override for GitHub direct apply |
| `OPENTAG_GITHUB_APPLY_DISABLED` | `false` | Set to `true` to disable GitHub direct apply while keeping callbacks enabled |
| `OPENTAG_SLACK_BOT_TOKEN` | none | Single Slack bot token for callback posting |
| `OPENTAG_SLACK_BOT_TOKENS_JSON` | none | JSON object mapping `agentId` to Slack bot token |
| `LARK_APP_ID` | none | Lark app id for the callback sink that posts replies via the Lark API |
| `LARK_APP_SECRET` | none | Lark app secret for the callback sink |
| `LARK_DOMAIN` | `lark` | `lark` or `feishu`; selects the Lark vs Feishu API host |
| `OPENTAG_TELEGRAM_BOT_TOKEN` | none | Single Telegram bot token for callback posting |
| `OPENTAG_TELEGRAM_BOT_TOKENS_JSON` | none | JSON object mapping `agentId` to Telegram bot token |

If `OPENTAG_PAIRING_TOKEN` is set on the dispatcher, legacy clients can use the
same value as:

- daemon `pairingToken` or `OPENTAG_PAIRING_TOKEN`
- ingress `OPENTAG_DISPATCHER_TOKEN`

For relay hardening, configure dispatcher `OPENTAG_RUNNER_TOKEN` together with
daemon `runnerToken` or `OPENTAG_RUNNER_TOKEN`. When the dispatcher has a runner
token, runner claim, heartbeat, progress, and completion calls must use it
instead of the pairing token. Status, cancel, and hook-ingest calls also prefer
the runner token, while admin/bootstrap and ingress calls continue to use the
pairing token.

During rotation, set `OPENTAG_RUNNER_TOKEN` to the new token and optionally put
old still-accepted tokens in `OPENTAG_RUNNER_TOKENS_JSON`, for example
`["old-runner-token"]`. To revoke a runner token without printing the token in
relay config or logs, put its raw-token SHA-256 fingerprint in
`OPENTAG_REVOKED_RUNNER_TOKEN_FINGERPRINTS_JSON`:

```bash
printf %s "$OLD_OPENTAG_RUNNER_TOKEN" | shasum -a 256
```

For self-hosted relay hardening, set `OPENTAG_MAX_REQUEST_BODY_BYTES` and the
two `OPENTAG_RATE_LIMIT_*` window/count variables on the dispatcher process.
`opentag start` also reads these hardening variables when it starts the local
dispatcher and local source ingress endpoints, but dispatcher URL, database path,
pairing token, and runner token still come from the OpenTag config. These limits
protect a single local dispatcher/ingress process and are useful for MVP and
self-hosted deployments. The in-process limiter keys `/v1/*` requests by relay-token
fingerprint, runner id, source platform, tenant/account/owner hint, and normalized
endpoint, so different tenants do not consume each other's local bucket. Hosted
or multi-instance relays still need durable or edge-backed tenant quotas and
replay retention outside the process. In service mode, use
`opentag service install` with the explicit hardening flags shown above so
launchd starts with the same non-secret dispatcher/ingress thresholds after
login.

## GitHub Ingress Environment

`opentag start` uses the publishable `@opentag/github` repository-webhook
ingress. This is the CLI default. GitHub must send webhooks to a public URL
that forwards to the local listener, usually:

```text
https://<your-tunnel-host>/github/webhooks
```

The CLI stores the repository webhook secret in `platforms.github.webhookSecret`.
`opentag setup` writes the CLI local webhook port to `platforms.github.port`;
new CLI configs default to `3050` to avoid common frontend dev-server port
collisions.
It verifies `x-hub-signature-256` and handles these GitHub events:

- `issue_comment`
- `pull_request_review_comment`

`apps/github-probot` is the advanced GitHub App ingress and uses Probot.

| Variable | Required | Notes |
| --- | --- | --- |
| `APP_ID` | yes | GitHub App ID expected by Probot |
| `WEBHOOK_SECRET` | yes | GitHub App webhook secret |
| `PRIVATE_KEY_PATH` | yes | Path to GitHub App private key |
| `PORT` | no | Probot app port; older local scripts usually use `3000`. CLI configs use `platforms.github.port` instead |
| `WEBHOOK_PATH` | no | Usually `/github/webhooks` |
| `OPENTAG_DISPATCHER_URL` | yes for real dispatch | Dispatcher URL. If omitted, the app logs and does not dispatch the run |
| `OPENTAG_DISPATCHER_TOKEN` | when dispatcher is paired | Bearer token for dispatcher `/v1/*` |
| `OPENTAG_DISPATCHER_OWNS_CALLBACKS` | no | Set `true` when dispatcher callback sinks should own acknowledgements |

Use `OPENTAG_DISPATCHER_OWNS_CALLBACKS=true` when `OPENTAG_GITHUB_TOKEN` is set
on the dispatcher. That avoids duplicate acknowledgement comments.

## Slack Ingress Environment

`opentag start` supports two Slack transports:

- Socket Mode, recommended for local CLI use. It uses a Slack App-Level Token and
  does not need a public URL.
- Events API, intended for hosted OpenTag or advanced local tunnel testing. It
  verifies signed Slack HTTP requests on `/slack/events`.

The legacy `apps/slack-events` process is still an Events API ingress only.

Slack suggested action buttons require **Interactivity & Shortcuts** in the Slack
app:

- Socket Mode: turn Interactivity on, but do not set a Request URL. Slack sends
  Block Kit actions over the Socket Mode WebSocket.
- Events API: turn Interactivity on and set its Request URL to the same public
  `/slack/events` URL used by Event Subscriptions, for example
  `https://<your-tunnel>/slack/events`.

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENTAG_DISPATCHER_URL` | yes | Dispatcher URL |
| `OPENTAG_DISPATCHER_TOKEN` | when dispatcher is paired | Bearer token for dispatcher `/v1/*` |
| `PORT` | no | Defaults to `3040` |
| `SLACK_SIGNING_SECRET` | yes unless using JSON config | Signing secret for a single Slack app |
| `OPENTAG_SLACK_AGENT_ID` | no | Agent id for single-app mode. Defaults to `opentag` |
| `OPENTAG_SLACK_APP_ID` | no | Slack app id for single-app mode |
| `OPENTAG_SLACK_BINDING_ADMIN_USER_IDS` | no | Comma-separated Slack user ids allowed to run `@OpenTag /bind` and `@OpenTag /unbind confirm` in channels |
| `OPENTAG_SLACK_POST_MESSAGE_URL` | no | Callback URI override. Defaults to Slack `chat.postMessage` |
| `OPENTAG_SLACK_APPS_JSON` | no | JSON array for multi-app ingress |

`OPENTAG_SLACK_APPS_JSON` shape:

```json
[
  {
    "signingSecret": "secret",
    "agentId": "opentag",
    "appId": "A123",
    "callbackUri": "https://slack.com/api/chat.postMessage"
  }
]
```

Set `OPENTAG_SLACK_BOT_TOKEN` or `OPENTAG_SLACK_BOT_TOKENS_JSON` on the
dispatcher, not on the Slack ingress, when you want final replies posted back to
Slack threads.

Slack source-thread self-service can bind a channel with
`/bind <owner>/<repo>` or `/bind <provider>:<owner>/<repo>` after the app is
mentioned. The command writes a Project Target binding such as
`github:owner/repo`; it does not accept absolute local checkout paths. The
target must already be registered on a runner through local config or setup
before the daemon can claim and execute runs for it. Binding changes require
the sender's Slack user id to be listed in
`OPENTAG_SLACK_BINDING_ADMIN_USER_IDS`, or the channel binding must be updated
from local config or the dispatcher API.

## Lark Ingress Environment

`apps/lark-events` opens a Lark/Feishu WebSocket long connection (no public
tunnel) and creates OpenTag runs from `im.message.receive_v1` events.

For the shortest local setup, run `scripts/dev/start-lark.sh` and choose the QR
scan path. It creates a Personal Agent app, detects the returned Lark / Feishu
tenant, connects the chat to a Project Target, saves the Personal Agent credentials to `.opentag/lark/lark.local.json`,
and exports these values for the local dispatcher and Lark ingress. Rerunning
the script reuses that saved app unless `OPENTAG_LARK_APP_SETUP=scan` or
`OPENTAG_LARK_APP_SETUP=manual` is set explicitly. OpenTag verifies saved and
manual Lark / Feishu app credentials against the provider before writing the
active CLI config. Use the environment variables below for manual or hosted setups.

| Variable | Required | Notes |
| --- | --- | --- |
| `LARK_APP_ID` | yes | Lark app id used for the long connection |
| `LARK_APP_SECRET` | yes | Lark app secret used for the long connection |
| `LARK_DOMAIN` | no | `lark` or `feishu`; use the tenant saved by setup for QR-created apps. Env-only runtime paths default to `lark` when omitted |
| `OPENTAG_DISPATCHER_URL` | yes | Dispatcher URL |
| `OPENTAG_DISPATCHER_TOKEN` | when dispatcher is paired | Bearer token for dispatcher `/v1/*` |
| `LARK_BOT_OPEN_ID` | for group chats | Bot open id; group messages must @-mention it. Direct p2p chats do not need it |
| `OPENTAG_LARK_AGENT_ID` | no | Agent id for the ingress. Defaults to `opentag` |
| `OPENTAG_LARK_DEFAULT_REPO` | no | Optional Project Target ref formatted as `owner/repo` or `provider:owner/repo`; unbound chats auto-connect to it before creating the first run |
| `OPENTAG_LARK_BINDING_ADMIN_OPEN_IDS` | no | Comma-separated Lark/Feishu sender open ids allowed to run `/bind` and `/unbind confirm` in group chats |
| `OPENTAG_LARK_BINDING_ADMIN_USER_IDS` | no | Comma-separated sender user ids allowed to manage group chat Project Target bindings when provided by the event |
| `OPENTAG_LARK_BINDING_ADMIN_UNION_IDS` | no | Comma-separated sender union ids allowed to manage group chat Project Target bindings when provided by the event |

Set `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN` on the dispatcher too, so
the Lark callback sink can post replies. Bind a chat to a Project Target with
`opentagd bind-lark-channels` (using `larkChannels`) or `POST /v1/channel-bindings`.

Each chat is bound independently (one `tenantKey/chatId` to one Project Target),
so one bot can serve several chats that each target a different local Project
Target.
Manual and hosted setups can still bind a chat from inside Lark with
`/bind <owner>/<repo>` or `/bind <provider>:<owner>/<repo>`. Treat that as an
advanced route; the local start script auto-connects the first chat to the
selected Project Target. The target must already be registered on a runner
(`opentagd bind-project-targets`; `bind-repos` remains available as a compatibility alias).
Direct p2p chats can manage their own binding by default. Group chat binding
changes require the sender to be listed in one of the
`OPENTAG_LARK_BINDING_ADMIN_*` allowlists, or the binding must be updated from
local config or the dispatcher API.
For newly-created runs, the Lark ingress sends short lifecycle replies such as
received, running, queued, or waiting for approval. It does not stream internal
executor progress into the chat by default; detailed process stays in
`/status`, `opentag status --run <run_id>`, logs, and audit events. `opentag
status --run <run_id>` also reports the provider liveness strategy, source
receipt delivery state, human callback count, thread-noise ratio, and any
suppressed progress callbacks so quiet chats can be distinguished from lost
progress events.

## Telegram Ingress Environment

`apps/telegram-events` receives Telegram webhook updates and creates OpenTag runs.

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENTAG_DISPATCHER_URL` | yes | Dispatcher URL |
| `OPENTAG_DISPATCHER_TOKEN` | when dispatcher is paired | Bearer token for dispatcher `/v1/*` |
| `PORT` | no | Defaults to `3050` |
| `OPENTAG_TELEGRAM_BOT_ID` | yes unless using JSON config | Bot id used in the webhook path and channel binding lookup |
| `OPENTAG_TELEGRAM_AGENT_ID` | no | Agent id for single-bot mode. Defaults to `opentag` |
| `OPENTAG_TELEGRAM_BOT_USERNAME` | no | Used to strip mentions in group chats |
| `OPENTAG_TELEGRAM_BOT_TOKEN` | no | Bot API token for Telegram ingress self-service replies such as `/help`, `/bind`, `/unbind`, `/status`, `/doctor`, and `/stop`; final callbacks can still be sent by the dispatcher |
| `OPENTAG_TELEGRAM_BINDING_ADMIN_USER_IDS` | no | Comma-separated Telegram user ids allowed to run `/bind` and `/unbind confirm` in group chats. Private chats can manage their own binding by default |
| `OPENTAG_TELEGRAM_SECRET_TOKEN` | no | Expected `x-telegram-bot-api-secret-token` header value |
| `OPENTAG_TELEGRAM_CALLBACK_URI` | no | Callback URI override. Defaults to `https://api.telegram.org/sendMessage` |
| `OPENTAG_TELEGRAM_BOTS_JSON` | no | JSON array for multi-bot ingress |

`OPENTAG_TELEGRAM_BOTS_JSON` shape:

```json
[
  {
    "botId": "bot_123",
    "agentId": "opentag",
    "botUsername": "opentag_bot",
    "botToken": "telegram-bot-token",
    "bindingAdminUserIds": ["789"],
    "secretToken": "telegram-secret",
    "callbackUri": "https://api.telegram.org/sendMessage"
  }
]
```

Set `OPENTAG_TELEGRAM_BOT_TOKEN` or `OPENTAG_TELEGRAM_BOT_TOKENS_JSON` on the
dispatcher, not on the Telegram ingress, when you want final replies posted
back to Telegram chats. Set `OPENTAG_TELEGRAM_BOT_TOKEN` on the ingress only
when you also want self-service replies for `/help`, `/bind`, `/unbind`,
`/status`, `/doctor`, and `/stop`; those replies stay concise and keep Project
Target binding separate from local checkout paths. `/bind <owner>/<repo>` and
`/bind <provider>:<owner>/<repo>` write only a Project Target binding such as
`github:acme/demo`; they do not accept absolute local checkout paths.
`/unbind confirm` disconnects the Telegram chat from its Project Target without
removing local checkout config, repository bindings, or allowlists. In private
chats, binding changes are allowed by default. In group and supergroup chats,
binding changes require the sender's Telegram user id to be listed in
`OPENTAG_TELEGRAM_BINDING_ADMIN_USER_IDS` or the bot's `bindingAdminUserIds`
JSON field. `/stop [run_id]` requests cancellation for the active chat run or
the specified run, and OpenTag does not treat that stop request as a successful
completion.

## Secret Handling

- Do not commit config files that contain real tokens, signing secrets, or private keys.
- Prefer `SecretRef` entries, environment variables, or a local secret manager
  for `OPENTAG_GITHUB_TOKEN`, `OPENTAG_SLACK_BOT_TOKEN`, Slack signing
  secrets, and GitHub App private keys.
- CLI config secret fields and direct daemon config secret fields accept either
  an inline string for local development or a reference object. Redacted config
  output prints the reference, not the secret value:

```json
{
  "daemon": {
    "pairingToken": { "kind": "env", "name": "OPENTAG_PAIRING_TOKEN" },
    "runnerToken": { "kind": "env", "name": "OPENTAG_RUNNER_TOKEN" },
    "runnerTokens": [{ "kind": "env", "name": "OPENTAG_OLD_RUNNER_TOKEN" }],
    "revokedRunnerTokenFingerprints": ["<sha256-fingerprint>"],
    "githubToken": { "kind": "file", "path": "/Users/alice/.config/opentag/github-token" },
    "githubApplyToken": { "kind": "keychain", "service": "opentag", "account": "github-apply-token" }
  },
  "platforms": {
    "lark": {
      "appSecret": { "kind": "keychain", "service": "opentag", "account": "lark-app-secret" }
    },
    "slack": {
      "botToken": { "kind": "env", "name": "OPENTAG_SLACK_BOT_TOKEN" },
      "signingSecret": { "kind": "file", "path": "/Users/alice/.config/opentag/slack-signing-secret" }
    },
    "github": {
      "webhookSecret": { "kind": "env", "name": "OPENTAG_GITHUB_WEBHOOK_SECRET" }
    }
  }
}
```

- `kind: "env"` is resolved from the current process environment when the CLI
  or daemon runtime reads the config. `kind: "file"` reads the referenced file
  and trims trailing whitespace. `kind: "keychain"` reads a macOS Keychain
  generic password with `/usr/bin/security find-generic-password -w -s <service>
  -a <account>`. Direct daemon configs support these references for
  `pairingToken`, `runnerToken`, `runnerTokens`, `githubToken`, and
  `githubApplyToken`. All SecretRef values must resolve to a non-empty secret;
  missing files, missing Keychain entries, and empty resolved values fail config
  loading before the runtime starts.
- `opentag status` and `opentag service status` summarize these references as
  redacted readiness information, for example `platforms.lark.appSecret: env
  ref (OPENTAG_LARK_APP_SECRET)`.
- To create a local macOS Keychain secret, run:

```bash
security add-generic-password -U -s opentag -a lark-app-secret -w '<secret-value>'
```

- Treat `pairingToken` and `runnerToken` as secrets when the dispatcher is
  reachable by other machines. Prefer `runnerToken` for runtime calls so a
  future pairing/registration token can be rotated independently.
- Keep `checkoutPath` pointed at a clean local checkout. Coding executors refuse
  dirty workspaces before making changes.
- Keep `security.mode` set to `enforce` unless you are deliberately auditing a new
  executor or adapter path.
