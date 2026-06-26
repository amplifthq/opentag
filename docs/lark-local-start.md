# Start OpenTag For Lark Locally

Use this guide when you want the shortest local loop:

```text
Lark message -> OpenTag dispatcher -> opentagd on this computer -> executor -> Lark reply
```

This is the current MVP setup path. It still uses a Lark app that you create in
Lark/Feishu, but it avoids manually starting the dispatcher, daemon, and Lark
ingress in separate terminals.

## What You Need

- Node 22.x
- Git
- A Lark or Feishu account
- A Lark/Feishu app with `LARK_APP_ID` and `LARK_APP_SECRET`
- A local git checkout for the project the agent should run in
- Optional: Codex CLI or Claude Code CLI for real local agent execution

If Codex and Claude Code are not installed, the script can still use the `echo`
executor to prove the Lark callback loop.

## Start

From the OpenTag repository:

```bash
./scripts/dev/start-lark.sh
```

The script prompts for:

- local project path
- executor: `codex`, `claude-code`, or `echo`
- Lark domain: `lark` or `feishu`
- `LARK_APP_ID`
- `LARK_APP_SECRET`
- `LARK_BOT_OPEN_ID` when you want to test in a group chat

It then:

1. Installs workspace dependencies if needed.
2. Generates `.opentag/lark/opentag.local.json`.
3. Starts the dispatcher.
4. Registers the local runner.
5. Binds the selected local checkout.
6. Starts `opentagd`.
7. Starts the Lark long-connection ingress.

## First Message

In a direct chat with the bot, send:

```text
say hello from my local computer
```

In a group chat, send:

```text
@OpenTag say hello from my local computer
```

The first chat that messages the bot is automatically connected to the selected
project path. This keeps the first-run path short. To point a chat at another
repository later, send:

```text
@OpenTag /bind owner/repo
```

## Expected Result

1. Lark replies with an acknowledgement.
2. The terminal shows the local daemon claiming and running the task.
3. Lark replies with the final result.

## Current Limits

- The script does not create a Lark app for you yet.
- Group chat triggers require `LARK_BOT_OPEN_ID`.
- Code tasks still need a git checkout because the current runner model is
  repository-scoped.
- The future package CLI should replace this repo-local script with
  `npx opentag lark`.
