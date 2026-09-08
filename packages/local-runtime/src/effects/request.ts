import {
  EffectRequestV1Schema,
  computeEffectRequestDigestV1,
  type EffectRequestV1,
} from "@opentag/control-protocol";
import type { RepositoryBindingConfig } from "../config.js";

const EFFECT_APPROVAL_WINDOW_MS = 24 * 60 * 60_000;

export type PublicationEffectSettlement = {
  runId: string;
  attemptId: string;
  attemptNumber: number;
  fencingToken: string;
  fencingTokenDigest: string;
  runnerGeneration: number;
  projectTargetId: string;
  targetBindingDigest: string;
  policySnapshotId: string;
  policySnapshotDigest: string;
  candidateId: string;
  candidateDigest: string;
  branch: string;
  baseRevision: string;
  finalRevision: string;
  finalTree: string;
  proposalCreatedAt: string;
};

export type PublicationEffectTarget = {
  projectTargetId: string;
  bindingDigest: string;
  bindingGeneration: number;
  provider: "github";
  owner: string;
  repo: string;
  defaultBranch: string | null;
};

function digestSuffix(candidateDigest: string): string {
  return candidateDigest.slice("sha256:".length, "sha256:".length + 48);
}

export async function buildPublicationEffectRequest(input: {
  organizationId: string;
  runnerId: string;
  runnerGeneration: number;
  settlement: PublicationEffectSettlement;
  target: PublicationEffectTarget;
  binding: RepositoryBindingConfig;
  now: Date;
}): Promise<EffectRequestV1> {
  const { settlement, target, binding } = input;
  const requestedAtMs = Date.parse(settlement.proposalCreatedAt);
  const approvalExpiresAtMs = requestedAtMs + EFFECT_APPROVAL_WINDOW_MS;
  if (!Number.isFinite(requestedAtMs)
    || new Date(requestedAtMs).toISOString() !== settlement.proposalCreatedAt
    || requestedAtMs > input.now.getTime()
    || approvalExpiresAtMs <= input.now.getTime()) {
    throw new Error("publication_effect_request_stale");
  }
  if (settlement.runnerGeneration !== input.runnerGeneration
    || target.projectTargetId !== settlement.projectTargetId
    || target.bindingDigest !== settlement.targetBindingDigest
    || binding.projectTargetId !== target.projectTargetId
    || target.provider !== "github"
    || binding.provider !== "github"
    || binding.owner.toLowerCase() !== target.owner.toLowerCase()
    || binding.repo.toLowerCase() !== target.repo.toLowerCase()
    || target.defaultBranch === null
    || binding.baseBranch !== target.defaultBranch
    || settlement.branch !== `opentag/${settlement.runId}`) {
    throw new Error("publication_effect_local_authority_missing");
  }

  const suffix = digestSuffix(settlement.candidateDigest);
  const digestInput = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.effect-authority.v1"] as ["relay.effect-authority.v1"],
    requestId: `request_effect_${suffix}`,
    effectId: `effect_${suffix}`,
    idempotencyKey: `effect_request_${suffix}`,
    organizationId: input.organizationId,
    runnerId: input.runnerId,
    runnerGeneration: input.runnerGeneration,
    work: {
      runId: settlement.runId,
      attemptId: settlement.attemptId,
      attemptNumber: settlement.attemptNumber,
      epoch: settlement.attemptNumber,
      fencingToken: settlement.fencingToken,
      fencingTokenDigest: settlement.fencingTokenDigest,
    },
    effectKind: "github.create_draft_pull_request" as const,
    candidate: {
      candidateId: settlement.candidateId,
      candidateDigest: settlement.candidateDigest,
    },
    authority: {
      approvalPolicy: "human_approval_required" as const,
      policySnapshotId: settlement.policySnapshotId,
      policySnapshotDigest: settlement.policySnapshotDigest,
      approvalRequestId: `approval_request_${suffix}`,
      approvalExpiresAt: new Date(approvalExpiresAtMs).toISOString(),
    },
    target: {
      projectTargetId: target.projectTargetId,
      targetBindingDigest: target.bindingDigest,
      targetBindingGeneration: target.bindingGeneration,
      provider: "github" as const,
      owner: target.owner,
      repo: target.repo,
      remote: binding.pushRemote,
      baseBranch: binding.baseBranch,
      branch: settlement.branch,
      frozenBaseRevision: settlement.baseRevision,
      workspaceTreeDigest: settlement.finalTree,
      expectedHeadSha: settlement.finalRevision,
    },
    requestedAt: settlement.proposalCreatedAt,
  };
  return EffectRequestV1Schema.parse({
    ...digestInput,
    requestDigest: await computeEffectRequestDigestV1(digestInput),
  });
}
