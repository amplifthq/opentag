# Live E2E Smoke Harness

The replay harness proves protocol behavior without live provider APIs. The live
E2E smoke harness is the next layer: it collects the existing ACP, GitHub,
Slack, Lark, and Linear dogfood scripts behind one safe entry point so a release
or PR reviewer can run the live cases intentionally and keep a JSON evidence
report.

The harness does not run live provider calls by default. You must select cases
with `--case` or `--all`.

## List Cases

```bash
corepack pnpm smoke:live -- --list
```

Current cases:

| Case | Live provider? | Purpose |
| --- | --- | --- |
| `protocol-runtime` | No | In-memory GitHub-shaped protocol smoke using dispatcher/client/store paths |
| `slack-protocol` | No | In-memory Slack-shaped protocol smoke with quiet progress and Block Kit final callback |
| `openclaw-acp` | Yes | Fail-closed OpenClaw 2026.7.1 candidate gate for worktree cwd, scratch cwd, fresh sessions, and cancellation through the generic ACP host |
| `github-webhook-live` | Yes | Real GitHub repository webhook, local CLI stack, final action receipt, optional `apply 1` PR flow |
| `github-cli-live` | Yes | Real GitHub issue callback using dispatcher-assisted run creation |
| `slack-local-live` | Yes | Real Slack callback using dispatcher-assisted run creation |
| `slack-ui-live` | Yes | Real Slack source-thread mention or button flow through Socket Mode or Events API |
| `lark-patch-live` | Yes | Real Lark reply plus final card patch through `lark-cli` |
| `linear-workspace-live` | Yes | Real Linear GraphQL `commentCreate` and `issueUpdate` through a signed local Linear webhook payload |

## Dry Run

Use dry-run before any provider call. It checks local commands and required
environment variables, then prints what would run.

```bash
corepack pnpm smoke:live -- --case github-webhook-live --dry-run
corepack pnpm smoke:live -- --case slack-ui-live --dry-run --allow-missing
```

`--allow-missing` turns missing credentials or commands into `SKIPPED` instead
of a failure. This is useful in CI jobs that collect readiness reports without
holding live provider tokens.

## Evidence Report

Every run can write a local JSON report:

```bash
corepack pnpm smoke:live -- \
  --case protocol-runtime \
  --case slack-protocol \
  --report .omx/live-e2e/local-protocol-smoke.json
```

Reports include selected cases, command strings, preflight gaps, warnings,
duration, exit code, and pass/skip/fail status. Reports should not contain raw
provider tokens, local checkout paths beyond the command itself, or raw provider
payloads.

## Recommended Sequence

1. Run local protocol cases first:

```bash
corepack pnpm smoke:live -- --case protocol-runtime --case slack-protocol
```

2. Run one live provider at a time with a report path:

```bash
corepack pnpm smoke:live -- \
  --case github-webhook-live \
  --report .omx/live-e2e/github-webhook-live.json
```

3. Inspect the provider thread and local status:

```bash
opentag status --run <run_id>
```

The live pass is only credible when the source thread has a concise final
callback, `opentag status --run` shows the Context Packet and Agent Work Ledger,
artifacts exist, and provider-visible action receipts do not expose raw executor
logs.

## Case Notes

### Built-in Coding-Agent ACP

`builtin-acp` wraps `corepack pnpm smoke:builtin-acp-conformance`. It runs the
same provider-backed gate for bundled Codex ACP, bundled Claude Agent ACP, and
Hermes ACP: initialize readiness, exact scratch `cwd`, isolated repository
worktree plus commit, and cancellation of the real shell/tool process tree.
The process-tree assertion currently targets POSIX hosts; Windows can exercise
ACP cancellation, but descendant-process termination is not yet a claimed gate.

Use `OPENTAG_BUILTIN_ACP_AGENTS` or `OPENTAG_BUILTIN_ACP_CASES` for a
comma-separated subset. Hermes uses `OPENTAG_HERMES_PROFILE` (default:
`opentag`) and must have a working inference provider before its execution cases
can pass. For example:

```bash
OPENTAG_BUILTIN_ACP_AGENTS=codex,claude-code \
corepack pnpm smoke:live -- --case builtin-acp
```

### OpenClaw ACP

`openclaw-acp` wraps `corepack pnpm smoke:openclaw-acp-conformance`. It expects
OpenClaw `2026.7.1`, a running Gateway, and an isolated profile named
`opentag-conformance` by default. Override the command, profile, Gateway URL, or
expected version with `OPENTAG_OPENCLAW_COMMAND`, `OPENTAG_OPENCLAW_PROFILE`,
`OPENTAG_OPENCLAW_GATEWAY_URL`, and
`OPENTAG_OPENCLAW_EXPECTED_VERSION`.

The case uses OpenTag's generic ACP executor; it does not invoke a dedicated
OpenClaw adapter. It fails closed unless real file tools write into the exact
OpenTag-created repository worktree and repository-free scratch directory,
each ACP process creates a distinct disposable Gateway session, a long-running
real tool call stops before its completion marker, and no marker appears in the
source checkout or OpenClaw's configured default workspace. The stock OpenClaw
bridge carries the ACP cwd into the Gateway request using its default cwd prefix,
so do not add `--no-prefix-cwd` to the integration binding.

The current stock 2026.7.1 result is intentionally non-zero. Worktree, scratch,
and distinct Gateway session checks pass, but after ACP cancellation marks the
Gateway session `killed`, the in-flight shell still reaches its completion
marker. Until that external effect stops, this gate does not authorize an
OpenClaw manifest and OpenTag does not ship one.

The test Gateway may use no authentication only when it is isolated and bound
to loopback. A reusable or remote profile must own its Gateway authentication;
do not put tokens in an OpenTag manifest. To retain a sanitized case report:

```bash
OPENTAG_OPENCLAW_CONFORMANCE_REPORT=.omx/live-e2e/openclaw-acp.json \
corepack pnpm smoke:live -- --case openclaw-acp
```

This live case covers OpenClaw-specific workspace, session, and cancellation
behavior. Run it alongside the generic ACP executor tests, governance matrix,
and privacy scan for the permission, Action fencing, presentation, and
credential-isolation parts of the full conformance checklist.

### GitHub Repository Webhook

`github-webhook-live` wraps `scripts/dev/run-github-webhook-live-test.sh`.
It requires:

- `gh` authenticated as a user with admin or maintain access to
  `OPENTAG_GH_REPO`.
- A working local Claude login when `OPENTAG_GH_LIVE_EXECUTOR` is
  `claude-code`; the Claude ACP adapter itself is bundled.
- `ngrok` unless `OPENTAG_GH_PUBLIC_URL` points at an existing public tunnel.

### Slack UI

`slack-ui-live` wraps `scripts/dev/run-slack-ui-trigger-local-test.sh`.
It requires:

- `OPENTAG_CONFIG_PATH`.
- `OPENTAG_SLACK_BOT_TOKEN`.
- Socket Mode token via `OPENTAG_SLACK_APP_TOKEN` or `SLACK_APP_TOKEN`, or
  Events API signing secret via `SLACK_SIGNING_SECRET`.

### Lark Patch

`lark-patch-live` wraps `scripts/dev/run-lark-message-patch-live-test.ts`.
It requires `lark-cli` or `OPENTAG_LARK_CLI`, with a ready bot identity and a
ready user identity or cached user `openId`. It can create a private seed
message or reuse an existing message when `OPENTAG_LARK_LIVE_CHAT_ID` and
`OPENTAG_LARK_LIVE_SOURCE_MESSAGE_ID` are set together.

### Linear Workspace

`linear-workspace-live` wraps
`scripts/dev/run-linear-workspace-live-test.ts`. It requires:

- `OPENTAG_LINEAR_SMOKE_TOKEN`: Linear OAuth app actor access token header
  value. Include the `Bearer ` prefix for OAuth access tokens. API-key
  compatibility smoke runs must also set
  `OPENTAG_LINEAR_SMOKE_ALLOW_NON_APP_TOKEN=true`.
- `OPENTAG_LINEAR_SMOKE_ISSUE`: Linear issue key, model UUID, or issue URL to
  use as the smoke source issue. `OPENTAG_LINEAR_SMOKE_ISSUE_ID` remains
  supported for compatibility.

Optional inputs:

- `OPENTAG_LINEAR_SMOKE_WEBHOOK_SECRET`: override the temporary signing secret
  stored on the generated relay installation. When omitted, the script
  generates one for the local signed webhook payloads.
- `OPENTAG_LINEAR_SMOKE_OAUTH_WEBHOOK_SECRET`: override the temporary
  OAuth App webhook signing secret used for the fixed
  `/linear/oauth/webhooks` hosted relay path. When omitted, the script
  generates one.
- `OPENTAG_LINEAR_SMOKE_OAUTH_WEBHOOK_PATH`: fixed hosted OAuth webhook path to
  exercise. Defaults to `/linear/oauth/webhooks`.
- `OPENTAG_LINEAR_SMOKE_ORGANIZATION_ID`: override the Linear organization id
  used to route the fixed OAuth App webhook to the temporary installation. When
  omitted, the script tries to query the workspace organization id and falls
  back to a local smoke id.
- `OPENTAG_LINEAR_SMOKE_GRAPHQL_URL`: Linear GraphQL endpoint override.
- `OPENTAG_LINEAR_SMOKE_ALLOW_NON_APP_TOKEN`: allow API-key compatibility smoke
  runs where `viewer.app` is not `true`. Defaults to `false`.
- `OPENTAG_LINEAR_SMOKE_DISCOVERY_LIMIT`: page size for Linear metadata
  discovery. Defaults to `100`.
- `OPENTAG_LINEAR_SMOKE_AGENT_SESSION_ID`: existing Linear Agent Session id to
  additionally validate the native agent path. When set, the smoke submits both
  `created` and `prompted` `AgentSessionEvent` payloads, verifies the prompted
  activity queues behind the active session run before promotion, and expects
  `agentSessionUpdate` plus `agentActivityCreate` delivery.
- `OPENTAG_LINEAR_SMOKE_REPO_PROVIDER`, `OPENTAG_LINEAR_SMOKE_REPO_OWNER`, and
  `OPENTAG_LINEAR_SMOKE_REPO_NAME`: local Project Target metadata to embed in
  the normalized Linear event.

The script registers a temporary Linear relay installation for token/project
target storage, then submits signed Linear Comment webhook payloads through the
fixed hosted OAuth App webhook path (`/linear/oauth/webhooks` by default). The
dispatcher verifies the app-level signature, verifies the token is a Linear
OAuth app actor by default, routes by `organizationId`, creates a run, completes
it with a safe priority update proposal, submits a second signed Linear
`apply 1` payload, posts a real Linear `commentCreate` callback, executes a real
Linear `issueUpdate`, and runs metadata discovery for teams, users, workflow
states, and labels. By default the issue update re-applies the issue's current
priority value, so it proves the mutation path without intentionally changing
the issue. The metadata step verifies the smoke issue's team appears in
discovery and that status/priority/user/label mapping drafts are generated.
When `OPENTAG_LINEAR_SMOKE_AGENT_SESSION_ID` is set, the same script also
submits signed `created` and `prompted`
`AgentSessionEvent` webhooks and verifies native Linear Agent Session / Agent
Activity GraphQL calls. The prompted payload is sent while the created session
run is still active; the script checks that it first appears as a queued
follow-up, then proves the same follow-up request is promoted into the claimed
follow-up run after the active run completes. Successful runs include
`linearGraphqlEvidence.operationCounts` and
`linearGraphqlEvidence.requiredOperations` so the exact Linear GraphQL paths are
auditable from the JSON output. The output also includes `metadataDiscovery`
counts and mapping value counts, `oauthActor.appActorVerified` for the default
app-token path, and `singleStatusComment.graphql.statusCommentUpdateVerified`
proving `commentUpdate` calls target the reused status comment id.
When Agent Session smoke is enabled, the output also includes
`agentSessionSmoke.prompted` with the queued follow-up id,
`followUpStatus: "promoted"`, and the promoted follow-up run id.

## Boundary

This harness is validation infrastructure, not a product surface. It should not
become an agent workspace, provider dashboard, or external runtime plugin
system. Its job is to prove that the real source threads still exercise the same
protocol evidence as replay fixtures: Context Packet, executor capability,
Action Receipt, Agent Work Ledger, artifacts, quiet callback, and final outcome.
