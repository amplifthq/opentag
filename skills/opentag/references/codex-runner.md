# Codex Runner

Use this path when the user wants OpenTag to run real coding work and optionally open a pull request.

## Required Values

- A local repository checkout
- `defaultExecutor`: `codex`
- `baseBranch`, usually `main`
- `pushRemote`, usually `origin`
- Optional `worktreeRoot`, defaulting to `.worktrees/opentag/<runId>` under the checkout
- Optional `keepWorktree`: `always`, `on_failure`, or `never`
- GitHub token in `githubToken` when PR creation is desired
- A working Codex CLI available to the daemon process

## Config

Set the repository executor to `codex`:

```json
{
  "runnerId": "runner_local",
  "dispatcherUrl": "http://localhost:3030",
  "githubToken": "ghs_optional_token_for_pr_creation",
  "repositories": [
    {
      "provider": "github",
      "owner": "acme",
      "repo": "demo",
      "checkoutPath": "/Users/example/repos/demo",
      "defaultExecutor": "codex",
      "baseBranch": "main",
      "pushRemote": "origin",
      "worktreeRoot": "/Users/example/repos/demo/.worktrees/opentag",
      "keepWorktree": "on_failure"
    }
  ]
}
```

## Behavior

The Codex executor:

- Leaves the user's current checkout and branch alone.
- Creates an isolated worktree and branch named `opentag/<runId>`.
- Runs `codex exec` with the normalized command text inside the worktree.
- Cleans internal agent artifacts and commits changed files to the run branch.
- Reports changed files and verification details.
- Pushes the branch and opens a PR when the run intent and credentials allow it.

## Verification

Before a live run:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- bind-repos
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- doctor
```

Then create a run through GitHub, Slack, or `POST /v1/runs`, and execute:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- run-once
```

## Success Criteria

- The daemon claims the run for the mapped repository.
- A branch named `opentag/<runId>` exists locally.
- A per-run worktree exists when `keepWorktree` says to retain it.
- The final result lists changed files or explains why no change was needed.
- If PR creation is enabled, the result includes the PR URL.
