import type { OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import type { FetchLike, PublicationProviderObservation } from "@opentag/github";
import type { OpenTagClient } from "@opentag/client";
import {
  computePublicationOperationReceiptDigestV1,
  type PublicationOperationCapabilityV1,
  type PublicationOperationReceiptV1,
} from "@opentag/control-protocol";
import {
  branchNameForRun,
  commitChangedFiles,
  nodeCommandRunner,
  pushBranch,
  type CommandRunner,
  type ExecutorCapabilityContract
} from "@opentag/runner";
import {
  canonicalRepositoryIdentity,
  type RepositoryBindingConfig,
} from "./config.js";

export type PullRequestOptions = {
  githubToken?: string;
  preparePullRequestBranch?: boolean;
  allowAutoCreatePullRequest?: boolean;
  commandRunner?: CommandRunner;
  fetchImpl?: FetchLike;
};

function hasPermission(event: OpenTagEvent, scope: string): boolean {
  return event.permissions.some((permission) => permission.scope === scope);
}

function isGitHubRepositoryTarget(input: { event: OpenTagEvent; binding: RepositoryBindingConfig }): boolean {
  const repoProvider = input.event.metadata["repoProvider"];
  return input.binding.provider.toLowerCase() === "github"
    && (repoProvider == null
      || (typeof repoProvider === "string" && repoProvider.toLowerCase() === "github"));
}

function repositoryTargetMatchesBinding(input: { event: OpenTagEvent; binding: RepositoryBindingConfig }): boolean {
  const owner = input.event.metadata["owner"];
  const repo = input.event.metadata["repo"];
  if (typeof owner !== "string" || typeof repo !== "string") return false;
  const provider = input.event.metadata["repoProvider"];
  const targetIdentity = canonicalRepositoryIdentity({
    provider: typeof provider === "string" ? provider : input.binding.provider,
    owner,
    repo,
  });
  const bindingIdentity = canonicalRepositoryIdentity(input.binding);
  return targetIdentity.provider === bindingIdentity.provider
    && targetIdentity.owner === bindingIdentity.owner
    && targetIdentity.repo === bindingIdentity.repo;
}

type CreatePullRequestIntent = {
  head: string;
  base?: string;
  title?: string;
  body?: string;
};

function createPullRequestIntent(result: OpenTagRunResult): CreatePullRequestIntent | null {
  for (const snapshot of result.suggestedChanges ?? []) {
    for (const intent of snapshot.intents) {
      if (intent.domain !== "pull_request" || intent.action !== "create_pull_request") continue;
      const head = intent.params?.["head"];
      if (typeof head !== "string" || head.length === 0) continue;
      const base = intent.params?.["base"];
      const title = intent.params?.["title"];
      const body = intent.params?.["body"];
      return {
        head,
        ...(typeof base === "string" && base.length > 0 ? { base } : {}),
        ...(typeof title === "string" && title.length > 0 ? { title } : {}),
        ...(typeof body === "string" && body.length > 0 ? { body } : {})
      };
    }
  }
  return null;
}

export async function maybeCreatePullRequest(input: {
  run: OpenTagRun;
  executorCapability?: Pick<ExecutorCapabilityContract, "sourceControl">;
  event: OpenTagEvent;
  binding: RepositoryBindingConfig;
  result: OpenTagRunResult;
  options: PullRequestOptions;
  assertExecutionCurrent?: () => Promise<boolean>;
}): Promise<OpenTagRunResult> {
  return input.result;
}

export type PublicationOperationCapability = {
  schemaVersion: 1; protocolVersion: "1.0"; capabilityId: string;
  organizationId: string; runId: string; attemptId: string; attemptNumber: number;
  epoch: number; fencingTokenDigest: string; candidateId: string; candidateDigest: string;
  repository: { provider: "github"; owner: string; repo: string; remote: string; baseBranch: string };
  branch: string; expectedHeadSha: string;
  step: "push_owned_branch" | "create_draft_pull_request";
  operationId: string; idempotencyKey: string; runnerId: string; runnerGeneration: number;
  issuedAt: string; expiresAt: string;
};

type PublicationAuthority = Pick<PublicationOperationCapability,
  "organizationId" | "runId" | "attemptId" | "attemptNumber" | "epoch" |
  "fencingTokenDigest" | "candidateId" | "candidateDigest" | "runnerId" |
  "runnerGeneration"> & { now: string };

export type PublicationOperationReceipt = {
  capabilityId: string; operationId: string;
  step: PublicationOperationCapability["step"];
  outcome: "succeeded" | "failed" | "outcome_unknown";
  observedAt: string; providerObservation: PublicationProviderObservation;
};

function assertExactCapability(capability: PublicationOperationCapability,
  authority: PublicationAuthority): void {
  const keys = ["organizationId", "runId", "attemptId", "attemptNumber", "epoch",
    "fencingTokenDigest", "candidateId", "candidateDigest", "runnerId",
    "runnerGeneration"] as const;
  if (keys.some((key) => capability[key] !== authority[key])
    || Date.parse(authority.now) < Date.parse(capability.issuedAt)
    || Date.parse(authority.now) >= Date.parse(capability.expiresAt)) {
    throw new Error("publication_capability_identity_mismatch");
  }
  if (capability.branch === capability.repository.baseBranch) {
    throw new Error("publication_operation_prohibited");
  }
}

export async function executePublicationOperation(input: {
  capability: PublicationOperationCapability; localAuthority: PublicationAuthority;
  credential: { githubToken: string };
  begin(): Promise<{ kind: "begun" | "replayed" | "stale_fence" | "conflict" }>;
  createDraftPullRequest(): Promise<PublicationProviderObservation>;
  pushOwnedBranch?: () => Promise<PublicationProviderObservation>;
  record(receipt: PublicationOperationReceipt): Promise<PublicationOperationReceipt>;
}): Promise<PublicationOperationReceipt> {
  assertExactCapability(input.capability, input.localAuthority);
  const begun = await input.begin();
  if (begun.kind !== "begun") throw new Error(`publication_begin_${begun.kind}`);
  let observation: PublicationProviderObservation;
  try {
    observation = input.capability.step === "push_owned_branch"
      ? await (input.pushOwnedBranch?.() ?? Promise.resolve({ kind: "ambiguous" as const }))
      : await input.createDraftPullRequest();
  } catch {
    observation = { kind: "ambiguous" };
  }
  const receipt: PublicationOperationReceipt = {
    capabilityId: input.capability.capabilityId,
    operationId: input.capability.operationId,
    step: input.capability.step,
    outcome: observation.kind === "present" ? "succeeded"
      : observation.kind === "absent" ? "failed" : "outcome_unknown",
    observedAt: input.localAuthority.now,
    providerObservation: observation,
  };
  return input.record(receipt);
}

function controlObservation(input: {
  observation: PublicationProviderObservation;
  capability: PublicationOperationCapabilityV1;
}) {
  if (input.observation.kind !== "present") return input.observation;
  return {
    kind: "present" as const,
    headSha: input.observation.headSha,
    ...("pullRequestNumber" in input.observation
      ? { externalId: `github_pr_${input.observation.pullRequestNumber}`,
          externalUri: input.observation.pullRequestUrl, draft: true as const,
          provider: "github" as const,
          repository: { owner: input.capability.repository.owner, repo: input.capability.repository.repo },
          baseBranch: input.capability.repository.baseBranch, state: "open" as const }
      : {}),
  };
}

/**
 * The local-only bridge for a coordinator-issued publication capability.  The
 * GitHub token remains a closure over the provider call: the client receives
 * only capability and receipt facts.  It intentionally has no retry loop;
 * `outcome_unknown` must be reconciled by the paired Runner first.
 */
export async function executePublicationControlV1(input: {
  client: Pick<OpenTagClient, "beginPublicationOperationControlV1" | "recordPublicationOperationReceiptControlV1">;
  capability: PublicationOperationCapabilityV1;
  fencingToken: string;
  now: () => string;
  pushOwnedBranch?: () => Promise<PublicationProviderObservation>;
  createDraftPullRequest: () => Promise<PublicationProviderObservation>;
}): Promise<PublicationOperationReceiptV1> {
  const capability = input.capability;
  const begunAt = input.now();
  await input.client.beginPublicationOperationControlV1({ schemaVersion: 1,
    protocolVersion: "1.0", requiredCapabilities: ["relay.publication.v1"],
    requestId: `request_begin_${capability.capabilityId}`, fencingToken: input.fencingToken,
    capability, begunAt });
  let provider: PublicationProviderObservation;
  try {
    provider = capability.step === "push_owned_branch"
      ? await (input.pushOwnedBranch?.() ?? Promise.resolve({ kind: "ambiguous" as const }))
      : await input.createDraftPullRequest();
  } catch {
    provider = { kind: "ambiguous" };
  }
  const observation = controlObservation({ observation: provider, capability });
  const receiptSeed = {
    schemaVersion: 1 as const, protocolVersion: "1.0" as const,
    receiptId: `receipt_${capability.capabilityId}`, capabilityId: capability.capabilityId,
    operationId: capability.operationId, organizationId: capability.organizationId,
    runId: capability.runId, attemptId: capability.attemptId,
    candidateId: capability.candidateId, candidateDigest: capability.candidateDigest,
    step: capability.step, runnerId: capability.runnerId,
    runnerGeneration: capability.runnerGeneration,
    fencingTokenDigest: capability.fencingTokenDigest, observation,
    outcome: observation.kind === "present" ? "succeeded" as const
      : observation.kind === "absent" ? "failed" as const : "outcome_unknown" as const,
    observedAt: input.now(),
  };
  const receipt = { ...receiptSeed,
    receiptDigest: await computePublicationOperationReceiptDigestV1(receiptSeed) };
  await input.client.recordPublicationOperationReceiptControlV1({ runnerId: capability.runnerId,
    fencingToken: input.fencingToken, receipt });
  return receipt;
}
