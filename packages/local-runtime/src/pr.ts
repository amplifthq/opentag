import type { PublicationProviderObservation } from "@opentag/github";
import type { OpenTagClient } from "@opentag/client";
import {
  computePublicationOperationReceiptDigestV1,
  type PublicationOperationCapabilityV1,
  type PublicationOperationReceiptV1,
} from "@opentag/control-protocol";

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
          baseBranch: input.capability.repository.baseBranch, state: "open" as const,
          ...(input.observation.headBranch && input.observation.headRepository
            ? { headBranch: input.observation.headBranch,
                headRepository: input.observation.headRepository } : {}) }
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
