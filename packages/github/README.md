# @opentag/github

GitHub Project Target publication and exact-head readback helpers for OpenTag.

GitHub is a Project Target in the paired product profile. It identifies the
repository that a Runner may work against, receives explicitly authorized
publication actions, and supplies provider observations for completion gates.
Slack owns the source conversation in this profile.

## Install

```bash
pnpm add @opentag/github
```

## Supported surface

- `createPullRequestViaFetch`: opens a draft pull request through the GitHub
  REST API. Non-draft creation is rejected.
- `createExactDraftPullRequest`: opens a draft pull request and immediately
  reads it back, returning `present` only when the repository, pull-request
  identity, branch, base branch, and exact expected head SHA all match.
- `assertPublicationOperationAllowed`: restricts publication to an owned-branch
  push or draft pull-request creation and rejects force pushes and base-branch
  writes.
- `createGitHubCompletionApi`: creates the minimal authenticated REST adapter
  used for pull-request and check readback.
- `reconcileGitHubCompletionEvidence`: re-reads the pull request, check runs,
  and commit statuses for the current head and returns a sanitized snapshot.
- `assessExactPullRequestReadiness`: compares a provider snapshot with the
  exact repository, head SHA, base branch, and required-check policy.

## Publication boundary

Draft pull-request publication is a material provider action. Callers must
establish approval, capability, fencing, idempotency, and receipt policy before
calling this package. These helpers do not grant authority and do not own Run,
Attempt, approval, retry, cancellation, or terminal state.

`createExactDraftPullRequest` treats any failed or inconclusive create/readback
sequence as `ambiguous`. A successful create response or pull-request URL alone
does not establish exact-head provenance. Callers must preserve an ambiguous
provider result as `outcome_unknown` and reconcile it before considering a
retry.

## Exact-head readback

Completion evidence is tied to the current provider state:

- exact repository owner and name;
- pull-request number and resource reference;
- head commit SHA;
- base branch and base SHA;
- complete check-run and commit-status observations;
- provider observation time and semantic payload digest.

Readback is evidence for a completion gate. It is not an approval decision and
does not, by itself, mark a Run complete.

## Example

```ts
import {
  assessExactPullRequestReadiness,
  createGitHubCompletionApi,
  reconcileGitHubCompletionEvidence
} from "@opentag/github";

const api = createGitHubCompletionApi({ token: process.env.GITHUB_TOKEN! });
const [snapshot] = await reconcileGitHubCompletionEvidence({
  eventName: "pull_request",
  deliveryId: "delivery-123",
  payload,
  api,
  now: () => new Date().toISOString()
});

if (snapshot) {
  const readiness = assessExactPullRequestReadiness({
    snapshot,
    expectedRepository: { owner: "acme", repo: "demo" },
    expectedHeadSha: approvedHeadSha,
    expectedBaseBranch: "main",
    requiredChecks: ["build", "test"]
  });
  // Persist the observation and let the Control Plane evaluate the gate.
}
```

The package exports only the target publication and exact-head readback surface
listed above. Automatic merge, deployment, and release behavior remain outside
this boundary.
