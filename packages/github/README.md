# @opentag/github

GitHub adapter helpers for OpenTag.

Use this package to turn GitHub comments into `OpenTagEvent` objects, reconcile provider-verified pull request completion evidence, and render GitHub-friendly callback text.

## Install

```bash
pnpm add @opentag/github
```

## Exports

- `normalizeGitHubIssueComment`: converts an issue comment payload shape into an `OpenTagEvent`.
- `normalizeGitHubPullRequestReviewComment`: converts a PR review comment payload shape into an `OpenTagEvent`.
- `renderAcknowledgement`, `renderProgress`, `renderFinalResult`: markdown text helpers for GitHub callbacks.
- `createPullRequest`: low-level GitHub REST helper for opening PRs from runner-created branches.
- `reconcileGitHubCompletionEvidence`: re-reads the pull request, check runs, and commit statuses for the current PR head SHA and returns a sanitized evidence snapshot.
- `createGitHubCompletionApi`: minimal authenticated GitHub REST adapter used by completion reconciliation.

Completion webhook handling is deliberately separate from command admission. `pull_request`, `check_run`, `check_suite`, and `status` deliveries never create runs. When a GitHub token and dispatcher evidence sink are configured, the webhook handler re-reads current provider state, persists the normalized snapshot through the dispatcher, and only then returns a successful acknowledgement. Without completion reconciliation configuration, legacy repositories continue to ignore those event types.

The webhook payload is only a trigger and correlation hint. Completion is evaluated against the current pull request head SHA returned by GitHub. A reported PR URL, a `closed` webhook action, or checks from an older head cannot prove completion.

## Example

```ts
import { normalizeGitHubIssueComment } from "@opentag/github";

const event = normalizeGitHubIssueComment({
  id: String(payload.comment.id),
  commentBody: payload.comment.body,
  commentUrl: payload.comment.html_url,
  apiCommentsUrl: payload.issue.comments_url,
  issueUrl: payload.issue.html_url,
  issueNumber: payload.issue.number,
  owner: payload.repository.owner.login,
  repo: payload.repository.name,
  actorId: payload.sender.id,
  actorLogin: payload.sender.login,
  private: payload.repository.private,
  receivedAt: new Date().toISOString()
});

if (event) {
  // Send event to @opentag/client or your own OpenTag-compatible control plane.
}
```

## Permissions

`fix` and `run` commands receive write-capable permissions such as `repo:write` and `pr:create`. Review, explain, and investigate-style commands stay read/comment oriented.

## Stability

Normalizer input shapes are intentionally small and provider-specific. Prefer adding optional fields over changing existing fields.
