# Real Integration Smoke Test

This guide captures the exact sequence that worked for validating OpenTag against real GitHub and Slack services, plus the failure modes we actually hit along the way.

Use this document when you want to prove that OpenTag works beyond local unit tests:

- real GitHub App webhook delivery
- real Slack Events API delivery
- real dispatcher and daemon execution
- real callback messages posted back to the source thread
- real local Claude Code execution
- protocol metrics that show callback noise and artifact flow

## Goal

A smoke test is complete when all of these are true:

1. A real GitHub comment or Slack app mention reaches the matching ingress service.
2. The dispatcher creates a run and records audit events.
3. The local daemon claims the run and executes the configured executor.
4. The final result is posted back to the original GitHub thread or Slack thread.
5. Metrics show low human callback noise relative to audit events.

## Shared Local Prerequisites

- Node 22.x
- pnpm 9.x
- A clean local checkout for any repository you want to bind
- `pnpm install`

The examples below assume:

- dispatcher on `http://localhost:3031`
- GitHub Probot ingress on `http://localhost:3000`
- Slack Events ingress on `http://localhost:3040`
- a pairing token of `dev_pairing_token`

## Recommended Local Config

Create a local runner config that binds the repository you want to test:

```json
{
  "runnerId": "runner_local",
  "dispatcherUrl": "http://localhost:3031",
  "pairingToken": "dev_pairing_token",
  "pollIntervalMs": 5000,
  "heartbeatIntervalMs": 15000,
  "repositories": [
    {
      "provider": "github",
      "owner": "amplifthq",
      "repo": "opentag",
      "checkoutPath": "/absolute/path/to/opentag",
      "defaultExecutor": "echo",
      "baseBranch": "main",
      "pushRemote": "origin"
    }
  ],
  "slackChannels": [
    {
      "teamId": "T_REAL",
      "channelId": "C_REAL",
      "repoProvider": "github",
      "owner": "amplifthq",
      "repo": "opentag"
    }
  ]
}
```

Start with `"defaultExecutor": "echo"` until the end-to-end callback loop is proven. Switch to `"codex"` or `"claude-code"` only after GitHub or Slack replies are working.

For Claude Code, set the repository binding to:

```json
"defaultExecutor": "claude-code"
```

Optional daemon-level Claude Code settings can be added to the same config:

```json
"claudeCode": {
  "command": "claude",
  "permissionMode": "acceptEdits"
}
```

You can also configure these through environment variables:

```bash
OPENTAG_CLAUDE_COMMAND=claude
OPENTAG_CLAUDE_MODEL=sonnet
OPENTAG_CLAUDE_PERMISSION_MODE=acceptEdits
```

`OPENTAG_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=true` is supported for explicitly sandboxed environments, but it is not enabled by default.

## GitHub Smoke Test

### GitHub CLI-Assisted Smoke Test

The fastest real GitHub test does not require a GitHub App webhook. It uses the active `gh` CLI login to create a GitHub-shaped run directly in the dispatcher, then lets `opentagd` execute locally and callback to a real issue.

Use an existing issue:

```bash
OPENTAG_GH_REPO=amplifthq/opentag-test \
OPENTAG_WORKSPACE_PATH=/absolute/path/to/clean/opentag-test \
OPENTAG_GH_TEST_ISSUE=1 \
scripts/dev/run-gh-claude-local-test.sh
```

Or create a temporary issue:

```bash
OPENTAG_GH_REPO=amplifthq/opentag-test \
OPENTAG_WORKSPACE_PATH=/absolute/path/to/clean/opentag-test \
OPENTAG_GH_CREATE_ISSUE=true \
scripts/dev/run-gh-claude-local-test.sh
```

Set `OPENTAG_GH_CREATE_PR=true` when you want the daemon to commit executor-produced file changes, push the run branch, and create a pull request. Without that flag, the smoke test validates callback delivery and local execution without opening a PR.

This path has been validated with:

```text
GitHub issue -> dispatcher -> opentagd -> local Claude Code -> commit branch -> push -> PR -> GitHub callback
```

GitHub callbacks update one comment per run in place. The first callback creates the run comment, and later progress/final callbacks patch that same comment instead of creating a new issue comment for every state change.

### GitHub App Setup

1. Create a GitHub App for local testing.
2. Install it to the target repository.
3. Use a webhook URL that points to your public tunnel and GitHub webhook path.

Recommended webhook path:

```text
/github/webhooks
```

Recommended minimum repository permissions:

- `Issues: Read and write`
- `Pull requests: Read`
- `Metadata: Read`

Recommended subscribed events:

- `Issue comment`
- `Pull request review comment`

### Public Tunnel

Expose the Probot ingress port:

```bash
ngrok http 3000
```

Use the resulting public URL in the GitHub App webhook URL:

```text
https://<ngrok-host>/github/webhooks
```

### Local Processes

Start the dispatcher with a GitHub callback token:

```bash
OPENTAG_DATABASE_PATH=opentag.github-test.db \
OPENTAG_PAIRING_TOKEN=dev_pairing_token \
OPENTAG_GITHUB_TOKEN=<github-token> \
PORT=3031 \
apps/dispatcher/node_modules/.bin/tsx apps/dispatcher/src/index.ts
```

Register the runner and bind the repository:

```bash
OPENTAG_CONFIG_PATH=/absolute/path/to/opentag.real.json \
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts register-runner

OPENTAG_CONFIG_PATH=/absolute/path/to/opentag.real.json \
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts bind-repos
```

Start the daemon:

```bash
OPENTAG_CONFIG_PATH=/absolute/path/to/opentag.real.json \
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts serve
```

Start Probot from built output:

```bash
APP_ID=<github-app-id> \
WEBHOOK_SECRET=<github-webhook-secret> \
PRIVATE_KEY_PATH=/absolute/path/to/github-app.private-key.pem \
PORT=3000 \
WEBHOOK_PATH=/github/webhooks \
OPENTAG_DISPATCHER_URL=http://localhost:3031 \
OPENTAG_DISPATCHER_TOKEN=dev_pairing_token \
OPENTAG_DISPATCHER_OWNS_CALLBACKS=true \
pnpm --filter @opentag/github-probot exec probot run ./dist/index.js
```

### Real Trigger

Create or reuse a real issue, then post:

```text
@opentag investigate this
```

Expected result:

- Probot receives `issue_comment`
- dispatcher creates a run
- daemon claims and executes the run
- GitHub thread receives:
  - acknowledgement
  - progress
  - final result

For GitHub App webhook testing, keep `OPENTAG_DISPATCHER_OWNS_CALLBACKS=true` on the Probot app so the dispatcher owns the run comment lifecycle.

### GitHub Failure Modes We Hit

- **Probot setup mode**
  This happened when Probot did not receive `APP_ID`, `WEBHOOK_SECRET`, and `PRIVATE_KEY_PATH` in the names it expects. `GITHUB_APP_ID` is not enough by itself.

- **Webhook path mismatch**
  The GitHub App must point to the actual Probot webhook path, not just the tunnel root.

- **App installed but repo missing**
  The App installation must explicitly include the repository you are testing.

- **PR push failed because no commit existed**
  Local executors leave file changes in the run branch. `opentagd` now stages and commits changed files before pushing a run branch for PR creation.

## Slack Smoke Test

### Slack API-Assisted Smoke Test

The fastest real Slack test does not require a public Events API tunnel. It uses the configured Slack bot token to post a seed message in the bound channel, then creates a Slack-shaped OpenTag run against that thread.

```bash
OPENTAG_ENV_FILE=/absolute/path/to/.env.slack-test \
scripts/dev/run-slack-claude-local-test.sh
```

By default this script reads `OPENTAG_CONFIG_PATH` from the env file, creates a temporary clean checkout for the configured repo, executes local Claude Code, and prints the run metrics plus Slack thread replies.

This path has been validated with:

```text
Slack thread -> dispatcher -> opentagd -> local Claude Code -> Slack final callback + metrics
```

Expected Slack thread shape:

- original user/bot seed message
- OpenTag acknowledgement
- OpenTag final result

Routine progress stays audit-only by default, so it should not produce additional Slack thread replies.

### Slack Events API App Setup

Required bot scopes:

- `app_mentions:read`
- `chat:write`

Required bot event:

- `app_mention`

Install the app to the workspace, then collect:

- `Signing Secret`
- `Bot User OAuth Token`
- target `teamId`
- target `channelId`

Invite the bot user into the test channel before sending any mention.

### Events API Transport

This smoke path uses Events API over a public Request URL. Disable Socket Mode for this specific app setup.

If Socket Mode is still enabled, Slack may give confusing signals in the dashboard and you end up debugging the wrong transport.

### Public Tunnel

Expose the Slack Events ingress port:

```bash
ngrok http 3040
```

Use the resulting public URL in Slack Event Subscriptions:

```text
https://<ngrok-host>/slack/events
```

### Local Processes

Start the dispatcher with both GitHub and Slack callback tokens when you want both integrations live:

```bash
OPENTAG_DATABASE_PATH=opentag.github-test.db \
OPENTAG_PAIRING_TOKEN=dev_pairing_token \
OPENTAG_GITHUB_TOKEN=<github-token> \
OPENTAG_SLACK_BOT_TOKEN=<xoxb-token> \
PORT=3031 \
apps/dispatcher/node_modules/.bin/tsx apps/dispatcher/src/index.ts
```

Bind the Slack channel to the repository:

```bash
OPENTAG_CONFIG_PATH=/absolute/path/to/opentag.real.json \
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts bind-slack-channels
```

Start Slack ingress:

```bash
SLACK_SIGNING_SECRET=<signing-secret> \
OPENTAG_DISPATCHER_URL=http://localhost:3031 \
OPENTAG_DISPATCHER_TOKEN=dev_pairing_token \
PORT=3040 \
apps/slack-events/node_modules/.bin/tsx apps/slack-events/src/index.ts
```

The daemon process can be the same one already running for GitHub.

### Real Trigger

In the bound channel, post:

```text
@little_pig investigate this
```

Expected result:

- `slack-events` receives `app_mention`
- dispatcher creates a run
- daemon claims and executes the run
- the Slack thread receives:
  - acknowledgement
  - final result

Routine progress should be visible in dispatcher audit events, not as Slack replies.

### Slack Failure Modes We Hit

- **Request URL pointed at the wrong port**
  We accidentally reused a tunnel that still pointed at `3000` for GitHub, while Slack needed `3040`.

- **`url_verification` returned the wrong shape**
  Slack validation required the raw `challenge` body. Returning a JSON object caused dashboard verification to fail. The correct behavior now lives in `apps/slack-events/src/app.ts`.

- **Channel binding missing**
  Slack requests were accepted but ignored as `unbound_channel` until the dispatcher had a Slack channel binding.

- **Bot token missing on dispatcher**
  Runs executed successfully, but nothing appeared in Slack because the dispatcher callback sink started without `OPENTAG_SLACK_BOT_TOKEN`.

- **Replies show up in the thread, not the main channel stream**
  Slack callback delivery uses `thread_ts`, so the most reliable place to check for bot replies is the message thread you mentioned the bot in.

## Protocol Metrics Checks

Every real smoke test should inspect run metrics:

```bash
curl -H "authorization: Bearer $OPENTAG_PAIRING_TOKEN" \
  http://localhost:3031/v1/runs/<run-id>/metrics
```

Important fields:

- `humanCallbackCount`
- `auditEventCount`
- `threadNoiseRatio`
- `suggestedChangesCount`
- `approvalDecisionCount`
- `applyPlanCount`
- `childRunCount`
- `applyOutcomeCounts`

For Slack, `humanCallbackCount` should normally be `2` for a completed run: acknowledgement plus final. A low `threadNoiseRatio` means OpenTag is recording detail in audit without flooding the human thread.

## Debugging Order

When something is broken, debug in this order:

1. **Public tunnel**
   Confirm it points at the right local port.
2. **Ingress health**
   Confirm the ingress process is listening locally.
3. **Platform handshake**
   GitHub webhook delivery or Slack `url_verification` must succeed first.
4. **Binding**
   Confirm repository binding or Slack channel binding exists in the dispatcher.
5. **Run creation**
   Confirm the dispatcher recorded `run.created`.
6. **Claim and execution**
   Confirm the daemon recorded `run.claimed`, `run.running`, `run.completed`.
7. **Callback token**
   Confirm the dispatcher was started with the right token for the platform being tested.

## Recommendation

For real integration work, keep two separate public tunnels or be deliberate about switching one tunnel between GitHub and Slack. Reusing the same public hostname across both ports is possible, but it is an easy way to lose half an hour to the wrong endpoint.

## Combined GitHub + Slack + Claude Code Stack

After the individual GitHub and Slack paths work, you can run both ingress services against one local Claude Code daemon:

```bash
OPENTAG_CONFIG_PATH=/absolute/path/to/opentag.real.json \
OPENTAG_GITHUB_TOKEN=<github-token> \
OPENTAG_SLACK_BOT_TOKEN=<xoxb-token> \
SLACK_SIGNING_SECRET=<signing-secret> \
APP_ID=<github-app-id> \
WEBHOOK_SECRET=<github-webhook-secret> \
PRIVATE_KEY_PATH=/absolute/path/to/github-app.private-key.pem \
scripts/dev/start-github-slack-claude-test.sh
```

The config file should bind the target repository and Slack channel, and the repository binding should use `"defaultExecutor": "claude-code"`.

Use `scripts/dev/run-gh-claude-local-test.sh` and `scripts/dev/run-slack-claude-local-test.sh` first. They are easier to debug because they do not require public webhook tunnels. Use the combined stack once both assisted paths work.
