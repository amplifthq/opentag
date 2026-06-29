# @opentag/cli

OpenTag CLI for setting up and running a local OpenTag stack.

## Install

```bash
npm install -g @opentag/cli
```

Then run:

```bash
opentag setup
opentag doctor
opentag start
```

`opentag setup` walks through the local configuration:

- Choose a language.
- Choose a platform: Lark / Feishu, Slack, or GitHub.
- Choose a coding agent: Codex, Claude Code, or Echo for local testing.
- Configure platform credentials.
- Bind the selected project.
- Optionally start OpenTag immediately.

## Commands

```bash
opentag setup
opentag start
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
