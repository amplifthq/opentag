# OpenTag

OpenTag is the open mention layer for agents.

Tag Codex, Claude Code, Pi, or your own local runner from GitHub, Slack, or Lark. OpenTag turns the mention into an auditable run, dispatches it to an approved local or hosted executor, and reports the result back to the original workspace.

## Why

Claude Tag brings Claude into Slack. OpenTag brings any agent into any workspace.

## V0 Direction

The first implementation focuses on a narrow GitHub-to-local-runner loop:

1. A GitHub comment mentions `@opentag`.
2. A Probot app normalizes the event.
3. A thin hosted dispatcher stores and leases the run.
4. A local daemon claims the run.
5. An executor adapter runs the task.
6. OpenTag reports the result back to GitHub.

The dispatcher only leases a run to a runner that is explicitly bound to the source repository, and the local daemon only executes runs whose repository is mapped to a configured local checkout.

## Packages

- `packages/core`: protocol schemas and mention parsing.
- `packages/github`: GitHub event normalization and callback rendering.
- `packages/store`: SQLite/Drizzle persistence and lease primitives.
- `packages/runner`: executor contracts and the echo executor.
- `apps/dispatcher`: hosted dispatcher API.
- `apps/opentagd`: local runner daemon.
- `apps/github-probot`: GitHub App ingress.

## Commands

```bash
pnpm install
pnpm test
pnpm build
pnpm typecheck
```

## Local Runner Config

`opentagd` can read a JSON config through `OPENTAG_CONFIG_PATH`:

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
      "defaultExecutor": "codex",
      "baseBranch": "main",
      "pushRemote": "origin"
    }
  ],
  "githubToken": "ghs_optional_token_for_pr_creation"
}
```

`defaultExecutor` can be `echo` for smoke tests or `codex` for a real local Codex CLI run. If `githubToken` is present and the normalized event grants `pr:create`, `opentagd` pushes the `opentag/<runId>` branch and creates a GitHub pull request after the executor reports changed files.

## Design

See [docs/design.md](docs/design.md).
