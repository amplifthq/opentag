# Start OpenTag For Lark Locally

Use this guide when you want the shortest local loop:

```text
Lark message -> OpenTag dispatcher -> opentagd on this computer -> executor -> Lark reply
```

This is the current MVP setup path. It shows a Lark/Feishu Personal Agent QR
code, stores the created app credentials locally, and avoids manually starting
the dispatcher, daemon, and Lark ingress in separate terminals.

## What You Need

- Node 22.x
- Git
- A Lark or Feishu account
- A local git checkout for the project the agent should run in
- Codex CLI for a real local agent run

The `echo` executor is still available for plumbing checks, but the real demo
path should choose `codex`.

## Start

From the OpenTag repository:

```bash
./scripts/dev/start-lark.sh
```

The script prompts for:

- local project path
- executor: `codex`, `claude-code`, or `echo`
- Lark domain: `lark` or `feishu`
- Lark app setup: `scan` or `manual`
- a QR scan when using `scan`
- `LARK_APP_ID` and `LARK_APP_SECRET` only when using `manual`
- `LARK_BOT_OPEN_ID` only when group chat support cannot be detected automatically

It then:

1. Installs workspace dependencies if needed.
2. Creates a Lark/Feishu Personal Agent from the QR scan, unless manual app
   credentials are provided.
3. Generates `.opentag/lark/opentag.local.json`.
4. Starts the dispatcher.
5. Registers the local runner.
6. Binds the selected local checkout.
7. Starts `opentagd`.
8. Starts the Lark long-connection ingress.

## Project Target

The Lark MVP path is local-project first. The script asks for the folder where
the agent should run and connects the first Lark chat to that local project.
OpenTag still creates an internal project target so the dispatcher and local
daemon can route the run, but the first-run path does not require a GitHub repo.

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
project path. This keeps the first-run path short.

## Advanced GitHub Target

GitHub repository settings are optional for the Lark local loop. Use them later
when you want GitHub-specific behavior such as repository policy, branch push, or
pull request creation. Set `OPENTAG_REPO_OWNER` and `OPENTAG_REPO_NAME` before
starting the script to use a GitHub-style project target.

## Expected Result

1. Lark replies with an acknowledgement.
2. The terminal shows the local daemon claiming and running the task.
3. Lark replies with the final result.

## Current Limits

- The QR flow creates a Personal Agent app, but the user still finishes the app
  creation page opened by Lark/Feishu after scanning.
- Group chat triggers require the bot open id. The script tries to detect it
  automatically; if detection fails, direct chat still works.
- Code tasks still need a local git checkout because the Codex executor creates
  isolated worktrees for runs.
- The future package CLI should replace this repo-local script with
  `npx opentag lark`.
