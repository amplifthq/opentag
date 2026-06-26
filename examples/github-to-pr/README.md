# GitHub to Pull Request Demo

This is the product demo path for OpenTag:

```text
GitHub issue mention
-> scoped OpenTag run
-> local daemon claims the bound repo
-> Claude Code or Codex works on an isolated branch
-> pull request and final callback return to GitHub
-> audit metrics preserve the detailed trace
```

Use this guide when you want to show the whole OpenTag loop, not just the echo executor smoke test.

## What This Demo Proves

- A work item thread can invoke an approved agent without moving context into a separate AI workspace.
- The dispatcher creates a scoped run with callback routing and audit events.
- The local daemon claims only the repository it is bound to handle.
- Coding work happens on an isolated `opentag/<runId>` branch or worktree.
- GitHub receives the useful result: a final callback and, when enabled, a pull request.
- Routine executor progress can stay in audit events instead of flooding the issue thread.

## Choose a Demo Path

| Path | Real GitHub needed | Best for |
| --- | --- | --- |
| README GIF | No | Explaining the golden path quickly without credentials |
| Local protocol smoke | No | Verifying the dispatcher/client/protocol chain in CI-like environments |
| GitHub CLI-assisted run | Yes | Fastest real GitHub issue -> local runner -> callback validation |
| GitHub CLI-assisted PR | Yes | Full product demo with local code changes, branch push, PR creation, and callback |
| GitHub App webhook | Yes | Validating real webhook delivery through `apps/github-probot` |

Start with local smoke tests, then run the GitHub CLI-assisted path, then move to the full GitHub App webhook path only when you need to validate public webhook delivery.

## Local Protocol Smoke

From the repository root:

```bash
pnpm install
pnpm test
pnpm smoke:protocol
pnpm build
```

This path does not touch GitHub. It starts an in-process dispatcher with a temporary SQLite database and verifies the protocol runtime.

## GitHub CLI-Assisted Callback Demo

This path uses the active `gh` CLI login to create a GitHub-shaped run directly in the dispatcher. It does not require a GitHub App webhook or public tunnel. Run these commands from the repository root.

Prerequisites:

- `gh` installed and authenticated with access to the target repo.
- Claude Code installed and authenticated if you use `scripts/dev/run-gh-claude-local-test.sh`.
- A clean checkout for the target repository.
- An existing issue, or permission to create a temporary issue.

The examples below set the repo-specific inputs: `OPENTAG_GH_REPO`, `OPENTAG_WORKSPACE_PATH`, and either `OPENTAG_GH_TEST_ISSUE` or `OPENTAG_GH_CREATE_ISSUE`. The script defaults `OPENTAG_RUNNER_ID=runner_claude_local`, `OPENTAG_PAIRING_TOKEN=dev_pairing_token`, and `OPENTAG_DISPATCHER_PORT=3032` unless you override them.

Use an existing issue:

```bash
OPENTAG_GH_REPO=amplifthq/opentag-test \
OPENTAG_WORKSPACE_PATH=/absolute/path/to/clean/opentag-test \
OPENTAG_GH_TEST_ISSUE=1 \
scripts/dev/run-gh-claude-local-test.sh
```

Or create a temporary issue:

```bash
OPENTAG_GH_REPO=amplifthq/opentag-test \
OPENTAG_WORKSPACE_PATH=/absolute/path/to/clean/opentag-test \
OPENTAG_GH_CREATE_ISSUE=true \
scripts/dev/run-gh-claude-local-test.sh
```

Expected result:

- The dispatcher starts locally.
- A runner is registered and bound to the target repository.
- A run is created for the target GitHub issue.
- `opentagd` claims the run and executes locally.
- GitHub receives the run callback comment.
- The local dispatcher database contains the run timeline and metrics.

## GitHub CLI-Assisted Pull Request Demo

Set `OPENTAG_GH_CREATE_PR=true` when you want the daemon to push the run branch and open a pull request after the executor changes files:

```bash
OPENTAG_GH_REPO=amplifthq/opentag-test \
OPENTAG_WORKSPACE_PATH=/absolute/path/to/clean/opentag-test \
OPENTAG_GH_CREATE_ISSUE=true \
OPENTAG_GH_CREATE_PR=true \
OPENTAG_GH_TEST_COMMAND='Make the smallest visible docs change that proves this OpenTag run can open a pull request. Keep it reversible.' \
scripts/dev/run-gh-claude-local-test.sh
```

Expected GitHub evidence:

- A temporary issue or selected test issue exists.
- A run callback appears on the issue.
- An `opentag/<runId>` branch is pushed.
- A pull request is opened against `main` or the configured `OPENTAG_BASE_BRANCH`.
- The final callback links or summarizes the result.

## Full GitHub App Webhook Demo

Use the GitHub App path when you need to prove that a real issue comment webhook can enter OpenTag through `apps/github-probot`.

Follow the setup in [Real integration smoke test](../../docs/real-integration-smoke-test.md), then trigger:

```text
@opentag investigate this
```

Use `OPENTAG_DISPATCHER_OWNS_CALLBACKS=true` on the Probot app when the dispatcher should own acknowledgement, progress, and final callback delivery.

## Safety Notes

- Use a disposable test repository or a clearly marked demo issue.
- Keep the target checkout clean before running coding executors.
- Start with callback-only validation before enabling `OPENTAG_GH_CREATE_PR=true`.
- Pull request creation is opt-in; direct writes to the target branch are not part of the v0 demo path.
- Do not commit `.env`, GitHub tokens, private keys, local SQLite databases, or temporary daemon config files.

## Troubleshooting

- If the script says `gh CLI not found`, install and authenticate GitHub CLI first.
- If the script says `Claude Code CLI not found`, install and log in to Claude Code or use the echo/manual path in [GitHub to echo](../github-to-echo/README.md).
- If no pull request appears, confirm `OPENTAG_GH_CREATE_PR=true`, the executor changed files, and the token can push branches and open PRs.
- If callbacks do not appear, check the dispatcher logs, the active `gh` CLI token that the script stores as `GITHUB_TOKEN`, and the stored run events.
- If a local checkout is dirty, clean or switch to a disposable checkout before running a coding executor.
