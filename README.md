# OpenTag

OpenTag is the open mention layer for agents.

Tag Codex, Claude Code, Pi, or your own local runner from GitHub, Slack, or Lark. OpenTag turns the mention into an auditable run, dispatches it to an approved local or hosted executor, and reports the result back to the original workspace.

## Why

Claude Tag brings Claude into Slack. OpenTag brings any agent into any workspace.

## V0 Direction

The first implementation focuses on a narrow GitHub-to-local-runner loop:

1. A GitHub comment mentions `@opentag`.
2. A Probot app normalizes the event.
3. A thin hosted dispatcher stores and leases the run.
4. A local daemon claims the run.
5. An executor adapter runs the task.
6. OpenTag reports the result back to GitHub.

The dispatcher only leases a run to a runner that is explicitly bound to the source repository, and the local daemon only executes runs whose repository is mapped to a configured local checkout.

GitHub ingress currently handles both `issue_comment.created` and `pull_request_review_comment.created`.
Slack ingress currently handles `url_verification` and `app_mention` events for bound channels.

## Packages

- `packages/core`: protocol schemas and mention parsing.
- `packages/github`: GitHub event normalization and callback rendering.
- `packages/slack`: Slack event normalization, thread keys, and callback helpers.
- `packages/store`: SQLite/Drizzle persistence and lease primitives.
- `packages/runner`: executor contracts and the echo executor.
- `apps/dispatcher`: hosted dispatcher API.
- `apps/opentagd`: local runner daemon.
- `apps/github-probot`: GitHub App ingress.
- `apps/slack-events`: Slack Events API ingress.

## Commands

```bash
pnpm install
pnpm test
pnpm build
pnpm typecheck
```

## Dispatcher Callback Delivery

Set `OPENTAG_GITHUB_TOKEN` on the dispatcher to let it post acknowledgement, progress, and final callback messages to GitHub comments. When dispatcher callbacks are enabled, set `OPENTAG_DISPATCHER_OWNS_CALLBACKS=true` on the Probot app to avoid duplicate acknowledgement comments.

Set `OPENTAG_SLACK_BOT_TOKEN` on the dispatcher to let it post acknowledgement, progress, and final callback messages to Slack threads via `chat.postMessage`.

Set `OPENTAG_PAIRING_TOKEN` on the dispatcher to require a shared Bearer token for `/v1/*` endpoints. Use the same value as `pairingToken` in `opentagd` config, and set `OPENTAG_DISPATCHER_TOKEN` on the Probot app when it creates runs through the dispatcher.

## Local Runner Config

`opentagd` can read a JSON config through `OPENTAG_CONFIG_PATH`:

```json
{
  "runnerId": "runner_local",
  "dispatcherUrl": "http://localhost:3030",
  "pairingToken": "shared_pairing_token",
  "pollIntervalMs": 5000,
  "heartbeatIntervalMs": 15000,
  "repositories": [
    {
      "provider": "github",
      "owner": "acme",
      "repo": "demo",
      "checkoutPath": "/Users/example/repos/demo",
      "defaultExecutor": "codex",
      "baseBranch": "main",
      "pushRemote": "origin"
    }
  ],
  "githubToken": "ghs_optional_token_for_pr_creation"
}
```

`defaultExecutor` can be `echo` for smoke tests or `codex` for a real local Codex CLI run. If `githubToken` is present and the normalized event grants `pr:create`, `opentagd` pushes the `opentag/<runId>` branch and creates a GitHub pull request after the executor reports changed files.

Use `opentagd serve` for the long-running daemon mode. It continuously polls for runs and emits periodic lease heartbeats while an executor is active.

## Slack Setup

Slack uses a small ingress service alongside the dispatcher:

- `apps/slack-events` expects `SLACK_SIGNING_SECRET` and `OPENTAG_DISPATCHER_URL`.
- Set `OPENTAG_DISPATCHER_TOKEN` on `apps/slack-events` when dispatcher pairing-token auth is enabled.
- Bind a Slack channel to a repo with `opentagd bind-slack-channels` or `POST /v1/slack-channel-bindings`.

After that, an `app_mention` in the bound channel is normalized into an `OpenTagEvent`, routed through the same dispatcher/local-daemon path, and replied to in the same Slack thread.

## Design

See [docs/design.md](docs/design.md).

The core package also exports JSON Schema definitions as `OpenTagJsonSchemas` for `OpenTagEvent`, `OpenTagRun`, and `OpenTagRunResult`.
