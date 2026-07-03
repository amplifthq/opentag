# Live E2E Smoke Harness

The replay harness proves protocol behavior without live provider APIs. The live
E2E smoke harness is the next layer: it collects the existing GitHub, Slack, and
Lark dogfood scripts behind one safe entry point so a release or PR reviewer can
run the live cases intentionally and keep a JSON evidence report.

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
| `github-webhook-live` | Yes | Real GitHub repository webhook, local CLI stack, final action receipt, optional `apply 1` PR flow |
| `github-cli-live` | Yes | Real GitHub issue callback using dispatcher-assisted run creation |
| `slack-local-live` | Yes | Real Slack callback using dispatcher-assisted run creation |
| `slack-ui-live` | Yes | Real Slack source-thread mention or button flow through Socket Mode or Events API |
| `lark-patch-live` | Yes | Real Lark reply plus final card patch through `lark-cli` |

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

### GitHub Repository Webhook

`github-webhook-live` wraps `scripts/dev/run-github-webhook-live-test.sh`.
It requires:

- `gh` authenticated as a user with admin or maintain access to
  `OPENTAG_GH_REPO`.
- `claude` or `OPENTAG_CLAUDE_COMMAND` when `OPENTAG_GH_LIVE_EXECUTOR` is
  `claude-code`.
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

## Boundary

This harness is validation infrastructure, not a product surface. It should not
become an agent workspace, provider dashboard, or external runtime plugin
system. Its job is to prove that the real source threads still exercise the same
protocol evidence as replay fixtures: Context Packet, executor capability,
Action Receipt, Agent Work Ledger, artifacts, quiet callback, and final outcome.
