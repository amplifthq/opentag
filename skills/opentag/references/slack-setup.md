# Slack Mention Setup

Use this path when the user wants Slack `app_mention` events to create OpenTag runs.

## Required Values

- Slack signing secret
- Slack team id and channel id
- Repository owner and repo that the channel should map to
- Dispatcher URL
- Optional dispatcher pairing token
- Slack bot token if the dispatcher should post replies back to Slack

## Dispatcher

Start the dispatcher with Slack callback delivery when final replies should be posted to Slack:

```bash
OPENTAG_DATABASE_PATH=opentag.db \
OPENTAG_SLACK_BOT_TOKEN=xoxb_token \
pnpm --filter @opentag/dispatcher-app dev
```

If the dispatcher requires auth, set `OPENTAG_PAIRING_TOKEN` and pass the same value to Slack ingress as `OPENTAG_DISPATCHER_TOKEN`.

## Local Runner Binding

Add both repository and Slack channel bindings to `opentag.local.json`:

```json
{
  "runnerId": "runner_local",
  "dispatcherUrl": "http://localhost:3030",
  "repositories": [
    {
      "provider": "github",
      "owner": "acme",
      "repo": "demo",
      "checkoutPath": "/Users/example/repos/demo",
      "defaultExecutor": "echo",
      "baseBranch": "main",
      "pushRemote": "origin"
    }
  ],
  "slackChannels": [
    {
      "teamId": "T123",
      "channelId": "C123",
      "owner": "acme",
      "repo": "demo"
    }
  ]
}
```

Run:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- register-runner
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- bind-repos
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- bind-slack-channels
```

## Slack Events App

Start the Slack Events ingress:

```bash
SLACK_SIGNING_SECRET=secret \
OPENTAG_DISPATCHER_URL=http://localhost:3030 \
pnpm --filter @opentag/slack-events dev
```

If the dispatcher requires auth, also set `OPENTAG_DISPATCHER_TOKEN`.

Point Slack Events API to:

```text
https://your-public-url/slack/events
```

For local testing, expose the local Slack Events port with a tunnel and use its `/slack/events` URL. Slack `url_verification` must receive the raw challenge text.

## Success Criteria

- Slack URL verification succeeds.
- Unbound channels are ignored with `ignored: "unbound_channel"`.
- A bound channel `@opentag` mention creates a dispatcher run.
- `opentagd run-once` completes the run.
- Slack receives callbacks if `OPENTAG_SLACK_BOT_TOKEN` and callback URI are configured.
