import {
  createExactDraftPullRequest,
  createGitHubCompletionApi,
  reconcileGitHubCompletionEvidence,
} from "@opentag/github";
import type {
  EffectEvidenceV1,
  EffectPermitV1,
} from "@opentag/control-protocol";
import { EffectEvidenceV1Schema } from "@opentag/control-protocol";
import {
  assertCommandSucceeded,
  nodeCommandRunner,
  type CommandRunner,
} from "@opentag/runner";
import {
  canonicalRepositoryIdentity,
  type RepositoryBindingConfig,
} from "../config.js";
import type {
  GitHubDraftPullRequestEffectAdapter,
  GitHubDraftPullRequestEffectEvidence,
} from "./index.js";

type GitHubEffectPermit = EffectPermitV1 & {
  effectKind: "github.create_draft_pull_request";
};
type GitHubDraftPullRequestObservation = Extract<
  EffectEvidenceV1,
  { kind: "present" }
>["observation"];

export function findGitHubEffectRepositoryBinding(
  repositories: RepositoryBindingConfig[],
  permit: GitHubEffectPermit,
): RepositoryBindingConfig | null {
  const expected = canonicalRepositoryIdentity(permit.target);
  return repositories.find((candidate) => {
    const actual = canonicalRepositoryIdentity(candidate);
    return candidate.projectTargetId === permit.target.projectTargetId
      && actual.provider === expected.provider
      && actual.owner === expected.owner
      && actual.repo === expected.repo
      && candidate.pushRemote === permit.target.remote
      && candidate.baseBranch === permit.target.baseBranch;
  }) ?? null;
}

function providerRepository(
  fullName: string | undefined,
): { owner: string; repo: string } | null {
  const parts = fullName?.split("/");
  return parts?.length === 2 && parts[0] && parts[1]
    ? { owner: parts[0], repo: parts[1] }
    : null;
}

function abortableFetch(fetchImpl: typeof fetch, signal: AbortSignal): typeof fetch {
  return (url, init) => fetchImpl(url, { ...init, signal });
}

function providerFailure(error: unknown): GitHubDraftPullRequestEffectEvidence {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return {
    kind: "ambiguous",
    errorCode: /invalid|malformed|missing|mismatch/u.test(message)
      ? "malformed_response"
      : "transport_error",
  };
}

export async function readLocalEffectBranchHead(input: {
  runner: CommandRunner;
  binding: RepositoryBindingConfig;
  branch: string;
}): Promise<string | null> {
  const result = await input.runner.run(
    "git",
    ["rev-parse", `${input.branch}^{commit}`],
    { cwd: input.binding.checkoutPath },
  );
  if (result.exitCode !== 0) return null;
  const head = result.stdout.trim();
  return /^[a-f0-9]{40,64}$/u.test(head) ? head : null;
}

async function remoteBranchIsExact(input: {
  runner: CommandRunner;
  binding: RepositoryBindingConfig;
  permit: GitHubEffectPermit;
}): Promise<boolean> {
  const result = await input.runner.run(
    "git",
    [
      "ls-remote",
      "--heads",
      input.permit.target.remote,
      `refs/heads/${input.permit.target.branch}`,
    ],
    { cwd: input.binding.checkoutPath },
  );
  await assertCommandSucceeded(result, "observe Effect branch after push");
  const fields = result.stdout.trim().split(/\s+/u);
  return fields.length >= 2 && fields[0] === input.permit.target.expectedHeadSha;
}

async function pushExactEffectCommit(input: {
  runner: CommandRunner;
  binding: RepositoryBindingConfig;
  permit: GitHubEffectPermit;
}): Promise<void> {
  const result = await input.runner.run("git", [
    "push",
    input.permit.target.remote,
    `${input.permit.target.expectedHeadSha}:refs/heads/${input.permit.target.branch}`,
  ], { cwd: input.binding.checkoutPath });
  await assertCommandSucceeded(result, "push frozen Effect commit");
}

async function observeExactDraftPullRequest(input: {
  permit: GitHubEffectPermit;
  token: string;
  fetchImpl: typeof fetch;
  now: () => Date;
}): Promise<GitHubDraftPullRequestEffectEvidence> {
  try {
    const target = input.permit.target;
    const api = createGitHubCompletionApi({ token: input.token, fetchImpl: input.fetchImpl });
    const candidates = await api.listPullRequestsForCommit({
      owner: target.owner,
      repo: target.repo,
      ref: target.expectedHeadSha,
    });
    const exact: Array<Awaited<ReturnType<typeof api.getPullRequest>>> = [];
    for (const candidate of candidates) {
      const pullRequest = await api.getPullRequest({
        owner: target.owner,
        repo: target.repo,
        pullRequestNumber: candidate.number,
      });
      const repository = `${target.owner}/${target.repo}`.toLowerCase();
      const headRepository = providerRepository(pullRequest.head.repo?.full_name);
      const expectedUrl = `https://github.com/${target.owner}/${target.repo}/pull/${pullRequest.number}`;
      if (pullRequest.state === "open"
        && pullRequest.merged === false
        && pullRequest.draft === true
        && pullRequest.htmlUrl === expectedUrl
        && pullRequest.head.sha === target.expectedHeadSha
        && pullRequest.head.ref === target.branch
        && headRepository
        && pullRequest.head.repo?.full_name?.toLowerCase() === repository
        && pullRequest.base.ref === target.baseBranch
        && pullRequest.base.repo?.full_name?.toLowerCase() === repository) {
        exact.push(pullRequest);
      }
    }
    if (exact.length === 0) {
      const observedAt = input.now().toISOString();
      return candidates.length === 0
        ? {
            kind: "absent",
            observationScope: {
              provider: "github",
              repository: { owner: target.owner, repo: target.repo },
              baseBranch: target.baseBranch,
              headBranch: target.branch,
              expectedHeadSha: target.expectedHeadSha,
              bindingGeneration: target.targetBindingGeneration,
              targetBindingDigest: target.targetBindingDigest,
              observationPolicy: "github.exact_draft_pr.v1",
              observedAt,
            },
          }
        : { kind: "ambiguous", errorCode: "malformed_response" };
    }
    if (exact.length !== 1) {
      return { kind: "ambiguous", errorCode: "malformed_response" };
    }
    const pullRequest = exact[0]!;
    const snapshots = await reconcileGitHubCompletionEvidence({
      eventName: "pull_request",
      deliveryId: `effect:${input.permit.effectId}:${input.permit.effectAttemptNumber}`,
      payload: {
        number: pullRequest.number,
        repository: { name: target.repo, owner: { login: target.owner } },
      },
      api,
      now: () => input.now().toISOString(),
    });
    const snapshot = snapshots.find((candidate) =>
      candidate.pullRequest.number === pullRequest.number);
    const finalPullRequest = await api.getPullRequest({
      owner: target.owner,
      repo: target.repo,
      pullRequestNumber: pullRequest.number,
    });
    const headRepository = providerRepository(finalPullRequest.head.repo?.full_name);
    const repository = `${target.owner}/${target.repo}`.toLowerCase();
    const finalState = finalPullRequest.merged
      ? "merged" as const
      : finalPullRequest.state === "closed" ? "closed" as const : "open" as const;
    const expectedUrl = `https://github.com/${target.owner}/${target.repo}/pull/${pullRequest.number}`;
    if (!snapshot || !headRepository
      || finalPullRequest.number !== pullRequest.number
      || finalPullRequest.state !== "open"
      || finalPullRequest.merged !== false
      || finalPullRequest.draft !== true
      || finalPullRequest.htmlUrl !== expectedUrl
      || finalPullRequest.head.sha !== target.expectedHeadSha
      || finalPullRequest.head.ref !== target.branch
      || finalPullRequest.head.repo?.full_name?.toLowerCase() !== repository
      || finalPullRequest.base.ref !== target.baseBranch
      || finalPullRequest.base.repo?.full_name?.toLowerCase() !== repository
      || snapshot.pullRequest.headSha !== target.expectedHeadSha
      || snapshot.pullRequest.baseBranch !== target.baseBranch
      || snapshot.pullRequest.baseSha !== finalPullRequest.base.sha
      || snapshot.pullRequest.state !== finalState) {
      return { kind: "ambiguous", errorCode: "malformed_response" };
    }
    const observedAt = input.now().toISOString();
    const observation: GitHubDraftPullRequestObservation = {
      provider: "github",
      repository: { owner: target.owner, repo: target.repo },
      remote: target.remote,
      branch: target.branch,
      baseBranch: target.baseBranch,
      pullRequestNumber: pullRequest.number,
      pullRequestResourceRef: `github_pr_${pullRequest.number}`,
      pullRequestUrl: finalPullRequest.htmlUrl,
      draft: true,
      state: finalState,
      headSha: finalPullRequest.head.sha,
      headBranch: finalPullRequest.head.ref,
      headRepository,
      baseSha: snapshot.pullRequest.baseSha,
      checks: snapshot.checks,
      checksComplete: snapshot.checksComplete,
      observedAt,
    };
    const evidence = EffectEvidenceV1Schema.safeParse({ kind: "present", observation });
    return evidence.success && evidence.data.kind !== "not_started"
      ? evidence.data
      : { kind: "ambiguous", errorCode: "malformed_response" };
  } catch (error) {
    return providerFailure(error);
  }
}

export function createGitHubDraftPullRequestEffectAdapter(input: {
  repositories: RepositoryBindingConfig[];
  githubToken?: string;
  runner?: CommandRunner;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): GitHubDraftPullRequestEffectAdapter {
  const runner = input.runner ?? nodeCommandRunner;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  return {
    async createDraftPullRequest(permit, signal) {
      const binding = findGitHubEffectRepositoryBinding(input.repositories, permit);
      if (!binding) {
        return { kind: "attention", reasonCode: "local.effect-target-unavailable" };
      }
      if (!input.githubToken) {
        return { kind: "attention", reasonCode: "local.github-credential-unavailable" };
      }
      if (await readLocalEffectBranchHead({ runner, binding, branch: permit.target.branch })
        !== permit.target.expectedHeadSha) {
        return { kind: "attention", reasonCode: "local.expected-head-unavailable" };
      }
      try {
        if (signal.aborted) throw new Error("Effect provider call aborted before push.");
        try {
          await pushExactEffectCommit({
            runner,
            binding,
            permit,
          });
        } catch {
          // A lost git response is not proof the push failed. Read the remote
          // branch before deciding whether it is safe to proceed.
        }
        if (signal.aborted || !await remoteBranchIsExact({ runner, binding, permit })) {
          return { kind: "ambiguous", errorCode: "provider_receipt_missing" };
        }
        await createExactDraftPullRequest({
          token: input.githubToken,
          owner: permit.target.owner,
          repo: permit.target.repo,
          title: `OpenTag run ${permit.runId}`,
          body: `Approved OpenTag publication candidate ${permit.candidate.candidateId}.`,
          head: permit.target.branch,
          base: permit.target.baseBranch,
          expectedHeadSha: permit.target.expectedHeadSha,
          fetchImpl: abortableFetch(fetchImpl, signal),
        });
        return observeExactDraftPullRequest({
          permit,
          token: input.githubToken,
          fetchImpl: abortableFetch(fetchImpl, signal),
          now,
        });
      } catch (error) {
        return providerFailure(error);
      }
    },

    async observeDraftPullRequest(permit, signal) {
      if (!findGitHubEffectRepositoryBinding(input.repositories, permit)) {
        return { kind: "attention", reasonCode: "local.effect-target-unavailable" };
      }
      if (!input.githubToken) {
        return { kind: "attention", reasonCode: "local.github-credential-unavailable" };
      }
      return observeExactDraftPullRequest({
        permit,
        token: input.githubToken,
        fetchImpl: abortableFetch(fetchImpl, signal),
        now,
      });
    },
  };
}
