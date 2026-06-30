---
name: opentag
description: Set up, run, and troubleshoot OpenTag with the published CLI across Slack, GitHub, Lark / Feishu, Codex, Claude Code, local config, platform credentials, and callback delivery.
---

# OpenTag

OpenTag connects collaboration platforms to a local coding agent. Use this skill when a user wants help with `opentag setup`, `opentag start`, Slack, GitHub, Lark / Feishu, Codex, Claude Code, local OpenTag config, or end-to-end setup verification.

## Default Path

Use the published CLI first. Do not start from repo-internal apps, old shell scripts, or private package binaries unless the user is explicitly doing core development.

Recommended user path:

```bash
npm install -g @opentag/cli
opentag setup
opentag start
```

No global install:

```bash
npx @opentag/cli setup
npx @opentag/cli start
```

## Route The Request

Read only the reference needed for the user's path:

- First setup or Echo test loop: `references/local-echo.md`
- Slack setup: `references/slack-setup.md`
- GitHub setup: `references/github-setup.md`
- Codex / Claude Code execution: `references/codex-runner.md`
- Broken setup, missing callbacks, rejected runs, or auth errors: `references/troubleshooting.md`

For platform credential steps, use the repository docs as the source of truth:

- Slack: `docs/platforms/slack.en.md`
- GitHub: `docs/platforms/github.en.md`
- Lark / Feishu: `docs/platforms/lark.en.md`

## Working Rules

- Keep setup user-led. Never invent tokens, app IDs, Slack team/channel IDs, GitHub owner/repo names, or local project paths.
- Prefer Slack, then GitHub, then Lark / Feishu when listing platforms.
- Ask the user which platform and coding agent they want if it is not already clear outside Codex.
- In Codex, route setup choice collection through Codex Plan mode before calling `request_user_input` / askhuman. Collect non-secret choices before running `opentag setup`, then pass them as CLI flags so the terminal wizard does not silently choose defaults.
- Askhuman is only available in Codex Plan mode, not Codex Default mode. If setup choices are needed while Codex is in Default mode, use a Codex runtime-provided Plan-mode transition if one is actually available. If no such transition exists in the current host, stop and report that askhuman cannot render from Default mode in this run. Do not claim a handoff happened, do not ask the user to perform the switch, do not continue setup from Default mode, do not ask the same choices in plain text, and do not guess defaults.
- Never request secrets through askhuman. Tokens, app secrets, channel IDs, repository names, and project paths still need explicit user confirmation before they are entered.
- Use Codex when `codex` is available, Claude Code when `claude` is available, and Echo only for dev/test verification.
- Treat `opentag start` as a foreground process. Tell the user to keep it running and stop it with Ctrl-C.
- Do not expose secrets in responses. Use `opentag config show` for redacted config.
- When credentials are needed, point the user to the matching platform guide and walk them through the official setup.

## Codex Plan Mode Askhuman Setup Choices

When helping a Codex user install or configure OpenTag, enter Codex Plan mode before the CLI reaches platform setup prompts. In Plan mode, render `request_user_input` / askhuman choices for:

- Platform: Slack, GitHub, or Lark / Feishu.
- Coding agent: Codex, Claude Code, or Echo, using local detection from `opentag executors` when available.
- Local project: the current working directory as the recommended option, plus a free-form path option inside askhuman for another path.
- Platform mode choices that are not secrets, such as Slack Socket Mode vs Events API, Lark / Feishu domain, Lark scan vs manual setup, and default project binding vs bind later.

If the run is still in Codex Default mode at this point, first look for an actual runtime Plan-mode transition. If none exists, stop and report that the current Codex host cannot render askhuman from Default mode. Do not claim a Plan-mode handoff is complete, do not ask the user to switch modes, do not run `opentag setup`, do not ask the choices in plain text, and do not continue with CLI defaults.

After the user chooses, run `opentag setup` with the matching flags, for example `--platform`, `--executor`, `--project`, `--slack-mode`, `--lark-domain`, `--lark-setup`, and `--binding`. Stop before entering any credential, token, app ID, app secret, channel ID, repository, or unconfirmed project path.

## Setup Workflow

1. Check prerequisites.
   Completion: Node.js 20+ is available and the user has a local project path.

2. Install or run the CLI.
   Completion: `opentag --help` or `npx @opentag/cli --help` works.

3. Run setup.
   Completion: `opentag setup` has collected platform, executor, project path, and credentials.

4. Start OpenTag.
   Completion: `opentag start` reports the dispatcher and selected platform listener.

5. Verify the setup.
   Completion: `opentag status` or `opentag doctor` explains the current state, and one platform mention creates a visible response or a specific actionable error.

6. Report next steps.
   Completion: tell the user what was configured, what still needs platform-side setup, and how to stop or uninstall.

## Local Paths

Default config:

```text
~/.config/opentag/config.json
```

Default state and isolated worktrees:

```text
~/.local/state/opentag
```

## Useful Commands

```bash
opentag setup
opentag start
opentag status
opentag doctor
opentag platforms
opentag executors
opentag config path
opentag config show
```

For local development inside the OpenTag repository:

```bash
corepack pnpm opentag-dev
opentag-dev setup
```
