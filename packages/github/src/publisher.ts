import type { FetchLike } from "./pull-request.js";
import { createPullRequestViaFetch } from "./pull-request.js";

export type DraftPullRequestPresence = {
  kind: "present";
  pullRequestNumber: number;
  pullRequestUrl: string;
  headSha: string;
  draft: true;
};

export type OwnedBranchPresence = {
  kind: "present";
  headSha: string;
};

export type PublicationProviderObservation = DraftPullRequestPresence | OwnedBranchPresence
  | { kind: "absent" }
  | { kind: "ambiguous" };

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
    return { kind: "present", pullRequestNumber: number, pullRequestUrl,
      headSha: input.expectedHeadSha, draft: true };
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
