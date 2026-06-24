# GitHub Mention Setup

Use this path when the user wants `@opentag` comments on GitHub issues or pull request review comments to create OpenTag runs.

## Required Values

- Dispatcher URL reachable by the GitHub Probot app
- Optional dispatcher pairing token, if the dispatcher requires auth
- GitHub App credentials required by Probot in the deployment environment
- Repository owner, repo name, and local checkout path for `opentagd`
- Whether the dispatcher or Probot posts acknowledgement callbacks

## Dispatcher

Start the dispatcher with callback delivery if GitHub comments should receive progress and final replies:

```bash
OPENTAG_DATABASE_PATH=opentag.db \
OPENTAG_GITHUB_TOKEN=ghs_or_ghp_token \
pnpm --filter @opentag/dispatcher-app dev
```

If the dispatcher should require auth, set `OPENTAG_PAIRING_TOKEN` and pass the same value to ingress apps as `OPENTAG_DISPATCHER_TOKEN` and to `opentagd` as `pairingToken`.

## GitHub Probot App

The app listens for:

- `issue_comment.created`
- `pull_request_review_comment.created`

It only creates a run when the comment contains an OpenTag mention parsed by the GitHub adapter.

Set:

```bash
OPENTAG_DISPATCHER_URL=http://localhost:3030
OPENTAG_DISPATCHER_TOKEN=dev_pairing_token
OPENTAG_DISPATCHER_OWNS_CALLBACKS=true
```

Use `OPENTAG_DISPATCHER_OWNS_CALLBACKS=true` when the dispatcher has `OPENTAG_GITHUB_TOKEN` and should post acknowledgement, progress, and final callback messages. Leave it unset when Probot should post only the initial acknowledgement.

## Local Runner Binding

Add the GitHub repository to `opentag.local.json`, then run:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- register-runner
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- bind-repos
```

The dispatcher rejects runs with `repo_not_bound` until this binding exists.

## Success Criteria

- GitHub comment with `@opentag` creates a dispatcher run.
- Dispatcher `/v1/runs/:runId` shows repository metadata for the expected owner and repo.
- `opentagd run-once` claims only the bound repository.
- GitHub receives acknowledgement and final callback if callback credentials are configured.
