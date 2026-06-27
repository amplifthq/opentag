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
| GitHub ingress | `apps/github-probot` | GitHub App webhooks and GitHub event normalization |
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
  "pollIntervalMs": 5000,
  "heartbeatIntervalMs": 15000,
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
| `pairingToken` | none | Shared Bearer token for dispatcher `/v1/*` calls |
| `repositories` | `[]` | Current compatibility array for Project Target bindings this daemon is allowed to claim |
| `channelBindings` | none | Generic channel bindings such as Telegram `botId/chatId -> Project Target` |
| `slackChannels` | none | Slack compatibility bindings that map `teamId/channelId` into the generic channel binding table |
| `larkChannels` | none | Lark bindings that map `tenantKey/chatId` into the generic channel binding table |
| `claudeCode` | none | Claude Code executor settings |
| `security` | none | Runner security policy |
| `githubToken` | none | Optional token for PR creation from daemon-produced branches |
| `allowAutoCreatePullRequest` | `false` | Enables PR creation when executor results include changes |
| `pollIntervalMs` | `5000` | Poll interval for `serve` |
| `heartbeatIntervalMs` | `15000` | Heartbeat interval for claimed runs |

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
| `OPENTAG_SECURITY_MODE` | none | `enforce`, `audit`, or `off` |
| `OPENTAG_ALLOWED_WORKSPACE_ROOT` | none | Restricts allowed checkout paths |
| `OPENTAG_ALLOW_UNSAFE_PROMPTS` | `false` | Allows prompts normally rejected by runner security |
| `OPENTAG_EXTRA_SAFE_ENV` | none | Comma-separated env names preserved for executor processes |
| `OPENTAG_GITHUB_TOKEN` | none | Optional GitHub token for PR creation |
| `OPENTAG_ALLOW_AUTO_CREATE_PR` | `false` | Allows daemon PR creation |
| `OPENTAG_PAIRING_TOKEN` | none | Shared dispatcher token |
| `OPENTAG_POLL_INTERVAL_MS` | `5000` | Poll interval |
| `OPENTAG_HEARTBEAT_INTERVAL_MS` | `15000` | Heartbeat interval |

## Dispatcher Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3030` | Dispatcher HTTP port |
| `OPENTAG_DATABASE_PATH` | `opentag.db` | SQLite database path |
| `OPENTAG_PAIRING_TOKEN` | none | Requires `Authorization: Bearer <token>` for `/v1/*` |
| `OPENTAG_GITHUB_TOKEN` | none | Enables GitHub callback posting and GitHub apply helpers |
| `OPENTAG_SLACK_BOT_TOKEN` | none | Single Slack bot token for callback posting |
| `OPENTAG_SLACK_BOT_TOKENS_JSON` | none | JSON object mapping `agentId` to Slack bot token |
| `LARK_APP_ID` | none | Lark app id for the callback sink that posts replies via the Lark API |
| `LARK_APP_SECRET` | none | Lark app secret for the callback sink |
| `LARK_DOMAIN` | `lark` | `lark` or `feishu`; selects the Lark vs Feishu API host |
| `OPENTAG_TELEGRAM_BOT_TOKEN` | none | Single Telegram bot token for callback posting |
| `OPENTAG_TELEGRAM_BOT_TOKENS_JSON` | none | JSON object mapping `agentId` to Telegram bot token |

If `OPENTAG_PAIRING_TOKEN` is set on the dispatcher, use the same value as:

- daemon `pairingToken` or `OPENTAG_PAIRING_TOKEN`
- ingress `OPENTAG_DISPATCHER_TOKEN`

## GitHub Ingress Environment

`apps/github-probot` uses Probot for GitHub App webhooks.

| Variable | Required | Notes |
| --- | --- | --- |
| `APP_ID` | yes | GitHub App ID expected by Probot |
| `WEBHOOK_SECRET` | yes | GitHub App webhook secret |
| `PRIVATE_KEY_PATH` | yes | Path to GitHub App private key |
| `PORT` | no | Usually `3000` in local scripts |
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

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENTAG_DISPATCHER_URL` | yes | Dispatcher URL |
| `OPENTAG_DISPATCHER_TOKEN` | when dispatcher is paired | Bearer token for dispatcher `/v1/*` |
| `PORT` | no | Defaults to `3040` |
| `SLACK_SIGNING_SECRET` | yes unless using JSON config | Signing secret for a single Slack app |
| `OPENTAG_SLACK_AGENT_ID` | no | Agent id for single-app mode. Defaults to `opentag` |
| `OPENTAG_SLACK_APP_ID` | no | Slack app id for single-app mode |
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

## Lark Ingress Environment

`apps/lark-events` opens a Lark/Feishu WebSocket long connection (no public
tunnel) and creates OpenTag runs from `im.message.receive_v1` events.

For the shortest local setup, run `scripts/dev/start-lark.sh` and choose the QR
scan path. It creates a Personal Agent app, connects the chat to a Project
Target, saves the Personal Agent credentials to `.opentag/lark/lark.local.json`,
and exports these values for the local dispatcher and Lark ingress. Rerunning
the script reuses that saved app unless `OPENTAG_LARK_APP_SETUP=scan` or
`OPENTAG_LARK_APP_SETUP=manual` is set explicitly. Use the environment variables
below for manual or hosted setups.

| Variable | Required | Notes |
| --- | --- | --- |
| `LARK_APP_ID` | yes | Lark app id used for the long connection |
| `LARK_APP_SECRET` | yes | Lark app secret used for the long connection |
| `LARK_DOMAIN` | no | `lark` or `feishu`; defaults to `lark` |
| `OPENTAG_DISPATCHER_URL` | yes | Dispatcher URL |
| `OPENTAG_DISPATCHER_TOKEN` | when dispatcher is paired | Bearer token for dispatcher `/v1/*` |
| `LARK_BOT_OPEN_ID` | for group chats | Bot open id; group messages must @-mention it. Direct p2p chats do not need it |
| `OPENTAG_LARK_AGENT_ID` | no | Agent id for the ingress. Defaults to `opentag` |
| `OPENTAG_LARK_DEFAULT_REPO` | no | Optional Project Target ref formatted as `owner/repo` or `provider:owner/repo`; unbound chats auto-connect to it before creating the first run |

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
    "secretToken": "telegram-secret",
    "callbackUri": "https://api.telegram.org/sendMessage"
  }
]
```

Set `OPENTAG_TELEGRAM_BOT_TOKEN` or `OPENTAG_TELEGRAM_BOT_TOKENS_JSON` on the
dispatcher, not on the Telegram ingress, when you want final replies posted
back to Telegram chats.

## Secret Handling

- Do not commit config files that contain real tokens, signing secrets, or private keys.
- Prefer environment variables or a local secret manager for `OPENTAG_GITHUB_TOKEN`,
  `OPENTAG_SLACK_BOT_TOKEN`, Slack signing secrets, and GitHub App private keys.
- Treat `pairingToken` as a secret when the dispatcher is reachable by other
  machines.
- Keep `checkoutPath` pointed at a clean local checkout. Coding executors refuse
  dirty workspaces before making changes.
- Keep `security.mode` set to `enforce` unless you are deliberately auditing a new
  executor or adapter path.
