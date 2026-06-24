# @opentag/github

GitHub adapter helpers for OpenTag.

Use this package to turn GitHub comments into `OpenTagEvent` objects and to render GitHub-friendly callback text.

## Install

```bash
pnpm add @opentag/github
```

## Exports

- `normalizeGitHubIssueComment`: converts an issue comment payload shape into an `OpenTagEvent`.
- `normalizeGitHubPullRequestReviewComment`: converts a PR review comment payload shape into an `OpenTagEvent`.
- `renderAcknowledgement`, `renderProgress`, `renderFinalResult`: markdown text helpers for GitHub callbacks.
- `createPullRequest`: low-level GitHub REST helper for opening PRs from runner-created branches.

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
