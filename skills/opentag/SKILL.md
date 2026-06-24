---
name: opentag
description: Configure and troubleshoot OpenTag agent mentions across dispatcher, local daemon, GitHub, Slack, and executor setup. Use when the user mentions OpenTag, @opentag, opentagd, OpenTag dispatcher, GitHub agent mentions, Slack agent mentions, runner binding, Codex executor, callback delivery, or local OpenTag smoke tests.
---

# OpenTag

OpenTag turns workspace mentions such as `@opentag fix this` into auditable agent runs. Use this skill to help a user configure the path from workspace event to dispatcher, local runner, executor, and callback.

## Route The Request

Read only the reference needed for the user's path:

- Local smoke test or first setup: `references/local-echo.md`
- GitHub issue or PR mentions: `references/github-setup.md`
- Slack app mentions: `references/slack-setup.md`
- Real coding execution or PR creation: `references/codex-runner.md`
- Broken runs, missing callbacks, rejected runs, or auth errors: `references/troubleshooting.md`

If the user asks for more than one path, configure and verify the smallest working loop first, then add the next adapter.

## Working Rules

- Prefer the local echo loop before real agents or live callbacks unless the user already has a working dispatcher and runner.
- Keep configuration explicit: do not invent repository owners, repo names, checkout paths, tokens, Slack IDs, or dispatcher URLs.
- Do not add fallback behavior. Missing required values should stop setup with a clear list of what is missing.
- Treat `opentagd` as local execution authority. It should only claim repositories listed in its config.
- Use `echo` for non-destructive smoke tests and `codex` only when the user wants real code execution.
- Separate proof layers: dispatcher health, runner registration, repo or Slack binding, run creation, daemon execution, and callback delivery.

## Setup Workflow

1. Identify the target loop.
   Completion: one loop is named: `local-echo`, `github`, `slack`, or `codex-runner`.

2. Collect required facts.
   Completion: the answer includes every missing value, or all required values are available.

3. Write or update the minimal config.
   Completion: config contains only the fields needed for the selected loop and uses the user's real repo/channel/checkouts.

4. Register bindings before creating runs.
   Completion: the runner is registered, repositories are bound, and Slack channels are bound when Slack is in scope.

5. Verify one real run.
   Completion: the run is visible through the dispatcher, has audit events, and ends as completed or fails with a specific error.

6. Report the result.
   Completion: tell the user what was configured, which command proved it, and what remains unconfigured.

## Command Defaults

Use these defaults unless the project changed:

- Dispatcher app: `pnpm --filter @opentag/dispatcher-app dev`
- Local daemon app: `pnpm --filter @opentag/opentagd dev -- <command>`
- Slack Events app: `pnpm --filter @opentag/slack-events dev`
- Dispatcher URL: `http://localhost:3030`
- Slack Events URL path: `/slack/events`
- Sample run payload: `examples/github-to-echo/run.example.json`

Before running package commands in this repo, use Node 22.x and install dependencies if needed.
