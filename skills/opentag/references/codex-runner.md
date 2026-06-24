# Codex Runner

Use this path when the user wants OpenTag to run real coding work and optionally open a pull request.

## Required Values

- A local repository checkout with no unrelated dirty changes
- `defaultExecutor`: `codex`
- `baseBranch`, usually `main`
- `pushRemote`, usually `origin`
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
      "pushRemote": "origin"
    }
  ]
}
```

## Behavior

The Codex executor:

- Refuses dirty workspaces.
- Creates an isolated branch named `opentag/<runId>`.
- Runs `codex exec` with the normalized command text.
- Reports changed files and verification details.
- Pushes the branch and opens a PR when the run intent and credentials allow it.

## Verification

Before a live run:

```bash
git -C /Users/example/repos/demo status --short
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- bind-repos
```

Then create a run through GitHub, Slack, or `POST /v1/runs`, and execute:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- run-once
```

## Success Criteria

- The daemon claims the run for the mapped repository.
- A branch named `opentag/<runId>` exists locally.
- The final result lists changed files or explains why no change was needed.
- If PR creation is enabled, the result includes the PR URL.
