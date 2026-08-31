import type { FetchLike } from "./pull-request.js";
import { createPullRequestViaFetch } from "./pull-request.js";
import { createGitHubCompletionApi } from "./completion-evidence.js";

export type DraftPullRequestPresence = {
  kind: "present";
  pullRequestNumber: number;
  pullRequestUrl: string;
  headSha: string;
  draft: true;
  provider?: "github";
  repository?: { owner: string; repo: string };
  baseBranch?: string;
  state?: "open";
  headBranch?: string;
  headRepository?: { owner: string; repo: string };
};

export type OwnedBranchPresence = {
  kind: "present";
  headSha: string;
};

export type PublicationProviderObservation = DraftPullRequestPresence | OwnedBranchPresence
  | { kind: "absent" }
  | { kind: "ambiguous" };

function providerRepository(fullName: string | undefined): { owner: string; repo: string } | null {
  const parts = fullName?.split("/");
  return parts?.length === 2 && parts[0] && parts[1]
    ? { owner: parts[0], repo: parts[1] }
    : null;
}

export async function createExactDraftPullRequest(input: {
  token: string; owner: string; repo: string; title: string; body: string;
  head: string; base: string; expectedHeadSha: string; fetchImpl?: FetchLike;
}): Promise<PublicationProviderObservation> {
  try {
    const pullRequestUrl = await createPullRequestViaFetch({
      token: input.token, owner: input.owner, repo: input.repo,
      title: input.title, body: input.body, head: input.head, base: input.base,
      draft: true,
    }, input.fetchImpl);
    const number = Number(new URL(pullRequestUrl).pathname.split("/").at(-1));
    if (!Number.isSafeInteger(number) || number <= 0) return { kind: "ambiguous" };
    // A successful create response is not itself exact-head provenance.  Read
    // the provider resource immediately with the same credential, then accept
    // only the resource the capability authorized.
    const pullRequest = await createGitHubCompletionApi({ token: input.token,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) })
      .getPullRequest({ owner: input.owner, repo: input.repo, pullRequestNumber: number });
    const repository = `${input.owner}/${input.repo}`.toLowerCase();
    const observedHeadRepository = providerRepository(pullRequest.head.repo?.full_name);
    if (pullRequest.number !== number || pullRequest.htmlUrl !== pullRequestUrl || pullRequest.draft !== true
      || pullRequest.state !== "open" || pullRequest.head.sha !== input.expectedHeadSha
      || pullRequest.head.ref !== input.head || !observedHeadRepository
      || pullRequest.head.repo?.full_name?.toLowerCase() !== repository
      || pullRequest.base.ref !== input.base || pullRequest.base.repo?.full_name?.toLowerCase() !== repository) {
      return { kind: "ambiguous" };
    }
    return { kind: "present", pullRequestNumber: number, pullRequestUrl,
      headSha: pullRequest.head.sha, draft: true, provider: "github",
      repository: { owner: input.owner, repo: input.repo }, baseBranch: pullRequest.base.ref, state: "open",
      headBranch: pullRequest.head.ref, headRepository: observedHeadRepository };
  } catch {
    return { kind: "ambiguous" };
  }
}

export function assertPublicationOperationAllowed(input: {
  step: string; branch: string; baseBranch: string; force?: boolean;
}): void {
  if (input.step !== "push_owned_branch" && input.step !== "create_draft_pull_request") {
    throw new Error("publication_operation_prohibited");
  }
  if (input.force || input.branch === input.baseBranch) {
    throw new Error("publication_operation_prohibited");
  }
}
