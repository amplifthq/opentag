# @opentag/cli

OpenTag CLI for setting up and running a local OpenTag stack.

## Install

```bash
npm install -g @opentag/cli@latest
```

Then run:

```bash
opentag setup
opentag service status
opentag doctor
```

`opentag setup` walks through the local configuration:

- Choose a language.
- Choose a platform: Lark / Feishu, Slack, GitHub, or GitLab.
- Choose a coding agent: Codex, Claude Code, or Echo for local testing.
- Configure platform credentials.
- Bind the selected project.
- Choose how OpenTag should run.

The recommended setup option keeps OpenTag running after the terminal closes. It installs and starts a background service on macOS and Linux. If background service mode is unsupported or you choose terminal mode, use `opentag start` and keep that terminal open.

## Commands

```bash
opentag setup
opentag start
opentag service start
opentag service stop
opentag service status
opentag service logs
opentag status
opentag doctor
opentag config path
opentag config show
opentag platforms
opentag executors
```

## Local Config

OpenTag stores local configuration at:

```text
~/.config/opentag/config.json
```

The config contains local secrets, so the CLI writes it with private file permissions.

## Platform Guides

The setup wizard links to the matching guide for each platform:

- Lark / Feishu: `docs/platforms/lark.en.md`
- Slack: `docs/platforms/slack.en.md`
- GitHub: `docs/platforms/github.en.md`
- GitLab: `docs/platforms/gitlab.en.md`

## Requirements

- Node.js 20 or newer.
- A local coding agent if you choose Codex or Claude Code.
- Platform credentials for the platform you connect.

## No Install

The scoped CLI package supports one-off runs without a global install:

```bash
npx @opentag/cli doctor
npx @opentag/cli setup
npx @opentag/cli start
```

For background service mode, install the CLI globally first so the generated service definition points at a stable CLI path instead of an `npx` temporary location.

## Local Development

Inside the OpenTag monorepo, install the development command:

```bash
corepack pnpm opentag-dev
```

Then run:

```bash
opentag-dev setup
opentag-dev start
```
