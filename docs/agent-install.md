# Agent-Readable OpenTag Install Guide

This guide is written for AI coding agents such as Codex and Claude Code that
are helping a user install and verify OpenTag. Follow the published OpenTag CLI
flow. Do not invent credentials, platform IDs, repository names, local paths, or
secret values.

## Product Boundary

OpenTag is a source-thread action layer for coding agents. The source thread
where work starts remains the human workflow surface for status, safe action
receipts, and audit pointers. OpenTag is not a general chat remote-control
cockpit.

Keep setup and implementation aligned to these OpenTag concepts:

- Project Target: the repository or system of record a source container is
  bound to, such as `github:owner/repo`.
- RunScope: source provider, source thread, and Project Target.
- Readiness: service controller state, runtime health, connector readiness,
  credential verification, executor capability, and action setup.
- Artifacts: run outputs such as patches, reports, screenshots, log summaries,
  and pull request links carried through `OpenTagRunResult.artifacts`.
- Audit: local detail through commands such as `opentag status --run <run_id>`.

Keep external runtime integration on OpenTag-owned APIs and data shapes.
Adapter ingest must use OpenTag's own run lifecycle, idempotency key, terminal
semantics, audit visibility, and runner-scoped authentication.

## Fast Path

1. Confirm Node.js 20 or newer is available:

```bash
node --version
```

2. Check the published package is reachable:

```bash
npm view @opentag/cli version --fetch-timeout=15000
```

3. Install the published CLI, or choose the one-off setup command path:

```bash
npm install -g @opentag/cli@latest
```

For one-off setup without a global install, keep the `npx` prefix on the setup
command:

```bash
npx --yes @opentag/cli setup
```

Prefer the global install when the user wants background service mode, because
the service definition should point at a stable CLI path instead of an `npx`
temporary location. If the user chooses the one-off path, skip the service-mode
commands below unless they later install the CLI globally.

4. For a global install, run setup with the installed binary:

```bash
opentag setup
```

Help the user choose:

- Platform: Slack, GitHub, GitLab, Linear, Lark / Feishu, Telegram, or Discord.
- Coding agent: Codex, Claude Code, or Echo.
- Local project: the intended local checkout.
- Runtime mode: background service when supported, terminal mode otherwise.

5. When setup needs platform credentials, open the matching OpenTag guide and
walk the user through the provider console:

- Slack: `docs/platforms/slack.en.md`
- GitHub: `docs/platforms/github.en.md`
- GitLab: `docs/platforms/gitlab.en.md`
- Linear: `docs/platforms/linear.en.md`
- Lark / Feishu: `docs/platforms/lark.en.md`
- Telegram: `docs/platforms/telegram.en.md`
- Discord: `docs/platforms/discord.en.md`

Never ask the user to paste secrets into chat if a local prompt, environment
variable, keychain item, or provider console entry is the safer place to enter
them.

6. Start and verify OpenTag:

```bash
opentag service status
opentag doctor
opentag status
opentag platforms
opentag executors
```

If service mode is unsupported or the user selected terminal mode, run:

```bash
opentag start
```

Keep that terminal open while testing.

## Verification Checklist

Before claiming setup is complete, verify:

- `opentag service status` distinguishes controller state from OpenTag runtime
  readiness.
- `opentag doctor` reports no failing required checks.
- `opentag status` shows redacted secrets, configured repositories, runtime
  mode, capabilities, and agent session profile.
- `opentag platforms` and `opentag executors` expose the support and capability
  matrix from OpenTag's own catalog.
- A source-thread test produces a concise acknowledgement, final summary, and
  local audit pointer instead of streaming internal tool traces into the human
  thread.

## Troubleshooting

If npm metadata is unreachable, inspect npm's current network settings before
changing anything:

```bash
npm config get registry
npm config get proxy
npm config get https-proxy
```

Only use a proxy URL the user provides or one already active in the
environment. Do not permanently change npm config without explicit user
confirmation. Only after npm registry metadata is reachable should you retry:

```bash
npx --yes @opentag/cli --help
```

If service status says the OS controller is running but the runtime is
unreachable or degraded, use:

```bash
opentag service logs
opentag doctor
opentag status
```

Do not treat a healthy LaunchAgent or systemd unit as proof that connectors,
credentials, runner heartbeat, executor capability, or source-thread actions are
ready.
