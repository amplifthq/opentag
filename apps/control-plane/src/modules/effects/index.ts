import { createHash } from "node:crypto";
import {
  AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
  AttemptWorkspaceAttestationV1Schema,
  EffectAcquireRequestV1Schema,
  EffectEvidenceEnvelopeV1Schema,
  EffectPermitV1Schema,
  EffectRequestV1Schema,
  EffectViewV1Schema,
  GitHubDraftPullRequestEffectTargetV1Schema,
  HostedAdmissionEnvelopeV1Schema,
  computeEffectEvidencePayloadDigestV1,
  computeEffectPermitDigestV1,
  computeEffectRequestDigestV1,
  computeEffectTargetDigestV1,
  verifyEffectEvidenceEnvelopeV1,
  verifyEffectPermitV1,
  verifyEffectRequestV1,
  type AdmissionPolicySnapshotReceiptEnvelopeV1,
  type AttemptWorkspaceAttestationV1,
  type EffectAcquireRequestV1,
  type EffectEvidenceEnvelopeV1,
  type EffectPermitV1,
  type EffectRequestV1,
  type EffectViewV1,
  type HostedAdmissionEnvelopeV1,
} from "@opentag/control-protocol";
import { canonicalJsonStringify } from "@opentag/control-protocol/canonical-json";
import { assessExactPullRequestReadiness } from "@opentag/github";
import type { Pool } from "pg";
import {
  withPostgresTransaction,
  type PostgresTransactionClient,
} from "../../database/postgres.js";
import type { RuntimePrincipal } from "../runners/index.js";

type Clock = { now(): Date };
type IdFactory = (kind: "permit") => string;

type EffectRow = {
  organization_id: string;
  effect_id: string;
  idempotency_key: string;
  effect_kind: "github.create_draft_pull_request";
  request_id: string;
  request_digest: string;
  runner_id: string;
  runner_generation: number;
  run_id: string;
  run_attempt_id: string;
  run_attempt_number: number;
  fencing_token_digest: string;
  candidate_id: string;
  candidate_digest: string;
  project_target_id: string;
  target_binding_digest: string;
  target_binding_generation: number;
  target_digest: string;
  target: unknown;
  policy_snapshot_id: string;
  policy_snapshot_digest: string;
  approval_request_id: string;
  approval_request_digest: string;
  approval_expires_at: Date;
  approval_id: string | null;
  approval_digest: string | null;
  approval: unknown | null;
  state: EffectViewV1["state"];
  current_attempt_number: number;
  current_evidence_digest: string | null;
  external_resource: unknown | null;
  reason_code: string | null;
  requested_at: Date;
  created_at: Date;
  updated_at: Date;
};

type AttemptRow = {
  organization_id: string;
  permit_id: string;
  effect_id: string;
  effect_attempt_number: number;
  permit_kind: "execute" | "reconcile";
  original_execute_permit_id: string | null;
  acquire_request_id: string;
  acquire_journal_digest: string;
  runner_id: string;
  runner_generation: number;
  request_digest: string;
  target_digest: string;
  approval_digest: string;
  permit_digest: string;
  permit: unknown;
  issued_at: Date;
  expires_at: Date;
  created_at: Date;
};

type RunAuthorityRow = {
  organization_id: string;
  run_id: string;
  runner_id: string;
  current_attempt_number: number;
  publication_mode: string;
  completion_mode: string;
  terminal_kind: string | null;
  publication_policy_digest: string;
  hosted_admission: unknown;
  admission_policy_snapshot: unknown;
};

type RunAttemptAuthorityRow = {
  organization_id: string;
  run_id: string;
  attempt_id: string;
  attempt_number: number;
  runner_id: string;
  state: string;
  fencing_token_digest: string;
  workspace_attestation: unknown | null;
};

type RunnerAuthorityRow = {
  organization_id: string;
  runner_id: string;
  registration_generation: number;
  credential_generation: number;
  current_credential_id: string;
};

type CandidateAuthorityRow = {
  organization_id: string;
  candidate_id: string;
  run_id: string;
  attempt_id: string;
  attempt_number: number;
  project_target_id: string;
  frozen_base_revision: string;
  workspace_tree_digest: string;
  publication_policy_digest: string;
  candidate: unknown;
};

type ProjectTargetAuthorityRow = {
  organization_id: string;
  project_target_id: string;
  runner_id: string;
  binding_digest: string;
  binding_generation: number;
  provider: string;
  owner: string;
  repo: string;
  default_branch: string;
};

type AuthorityRows = {
  run: RunAuthorityRow;
  attempt: RunAttemptAuthorityRow;
  runner: RunnerAuthorityRow;
  candidate: CandidateAuthorityRow;
  target: ProjectTargetAuthorityRow;
};

type LockedAuthority = AuthorityRows & {
  effect: EffectRow;
};

type EffectAuthorityExpectation = {
  organizationId: string;
  runnerId: string;
  runnerGeneration: number;
  runId: string;
  runAttemptId: string;
  runAttemptNumber: number;
  fencingTokenDigest: string;
  candidateId: string;
  candidateDigest: string;
  projectTargetId: string;
  targetBindingDigest: string;
  targetBindingGeneration: number;
  target: EffectRequestV1["target"];
  policySnapshotId: string;
  policySnapshotDigest: string;
};

type StoredAuthorityDocuments = {
  admission: HostedAdmissionEnvelopeV1;
  workspace: AttemptWorkspaceAttestationV1;
  policy: AdmissionPolicySnapshotReceiptEnvelopeV1;
};

export type EffectAuthorityStoredStateErrorCode =
  | "EFFECT_AUTHORITY_STORED_ADMISSION_INVALID"
  | "EFFECT_AUTHORITY_STORED_WORKSPACE_INVALID"
  | "EFFECT_AUTHORITY_STORED_POLICY_INVALID"
  | "EFFECT_AUTHORITY_STORED_TARGET_INVALID"
  | "EFFECT_AUTHORITY_STORED_TARGET_DIGEST_INVALID";

export class EffectAuthorityStoredStateError extends Error {
  override readonly name = "EffectAuthorityStoredStateError";

  constructor(readonly code: EffectAuthorityStoredStateErrorCode) {
    super(code);
  }
}

export type EffectApproval = {
  organizationId: string;
  effectId: string;
  approvalRequestId: string;
  approvalRequestDigest: string;
  approvalId: string;
  approvedBy: string;
  approvedAt: string;
};

export type EffectApprovalIssue = {
  organizationId: string;
  effectId: string;
  effectKind: "github.create_draft_pull_request";
  requestId: string;
  requestDigest: string;
  runnerId: string;
  runnerGeneration: number;
  work: {
    runId: string;
    attemptId: string;
    attemptNumber: number;
    epoch: number;
    fencingTokenDigest: string;
  };
  candidate: EffectRequestV1["candidate"];
  target: EffectRequestV1["target"];
  policy: {
    snapshotId: string;
    snapshotDigest: string;
  };
  approvalRequest: {
    approvalRequestId: string;
    approvalRequestDigest: string;
    expiresAt: string;
  };
  createdAt: Date;
};

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(value)).digest("hex")}`;
}

function asIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function approvalRequestDigest(request: EffectRequestV1): string {
  return digest({
    organizationId: request.organizationId,
    effectId: request.effectId,
    effectKind: request.effectKind,
    requestDigest: request.requestDigest,
    runnerId: request.runnerId,
    runId: request.work.runId,
    attemptId: request.work.attemptId,
    attemptNumber: request.work.attemptNumber,
    candidate: request.candidate,
    policySnapshotId: request.authority.policySnapshotId,
    policySnapshotDigest: request.authority.policySnapshotDigest,
    approvalRequestId: request.authority.approvalRequestId,
    approvalExpiresAt: request.authority.approvalExpiresAt,
  });
}

function approvalDigest(input: EffectApproval, effect: EffectRow): string {
  return digest({
    organizationId: input.organizationId,
    effectId: input.effectId,
    requestDigest: effect.request_digest,
    approvalRequestId: input.approvalRequestId,
    approvalRequestDigest: input.approvalRequestDigest,
    approvalId: input.approvalId,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
  });
}

function externalResource(observation: {
  provider: "github";
  pullRequestResourceRef: string;
  pullRequestUrl: string;
}) {
  return {
    provider: observation.provider,
    resourceRef: observation.pullRequestResourceRef,
    uri: observation.pullRequestUrl,
  } as const;
}

function projectEffect(row: EffectRow): EffectViewV1 {
  const base = {
    effectId: row.effect_id,
    effectKind: row.effect_kind,
    updatedAt: asIso(row.updated_at),
  } as const;
  switch (row.state) {
    case "requested":
    case "authorized":
      return EffectViewV1Schema.parse({ ...base, state: row.state, currentAttemptNumber: 0 });
    case "permit_issued":
      return EffectViewV1Schema.parse({ ...base, state: row.state,
        currentAttemptNumber: row.current_attempt_number });
    case "observing":
    case "succeeded":
      return EffectViewV1Schema.parse({ ...base, state: row.state,
        currentAttemptNumber: row.current_attempt_number,
        currentEvidenceDigest: row.current_evidence_digest,
        externalResource: row.external_resource });
    case "outcome_unknown":
      return EffectViewV1Schema.parse({ ...base, state: row.state,
        currentAttemptNumber: row.current_attempt_number,
        currentEvidenceDigest: row.current_evidence_digest,
        ...(row.external_resource ? { externalResource: row.external_resource } : {}),
        reasonCode: row.reason_code });
    case "retry_eligible":
      return EffectViewV1Schema.parse({ ...base, state: row.state,
        currentAttemptNumber: row.current_attempt_number,
        currentEvidenceDigest: row.current_evidence_digest,
        reasonCode: row.reason_code });
    case "attention":
      return EffectViewV1Schema.parse({ ...base, state: row.state,
        currentAttemptNumber: row.current_attempt_number,
        ...(row.current_evidence_digest
          ? { currentEvidenceDigest: row.current_evidence_digest } : {}),
        ...(row.external_resource ? { externalResource: row.external_resource } : {}),
        reasonCode: row.reason_code });
    case "cancelled_before_permit":
      return EffectViewV1Schema.parse({ ...base, state: row.state,
        currentAttemptNumber: 0, reasonCode: row.reason_code });
  }
}

type AuthorityIdentity = {
  organizationId: string;
  runId: string;
  runAttemptId: string;
  runAttemptNumber: number;
  runnerId: string;
  candidateId: string;
  projectTargetId: string;
};

async function lockAuthorityRows(
  client: PostgresTransactionClient,
  identity: AuthorityIdentity,
): Promise<AuthorityRows | null> {
  const run = await client.query<RunAuthorityRow>(
    `SELECT organization_id,run_id,runner_id,current_attempt_number,publication_mode,
       completion_mode,terminal_kind,publication_policy_digest,hosted_admission,
       admission_policy_snapshot
     FROM cp_hosted_run WHERE organization_id=$1 AND run_id=$2 FOR UPDATE`,
    [identity.organizationId, identity.runId],
  );
  const attempt = await client.query<RunAttemptAuthorityRow>(
    `SELECT organization_id,run_id,attempt_id,attempt_number,runner_id,state,
       fencing_token_digest,workspace_attestation
     FROM cp_hosted_attempt
     WHERE organization_id=$1 AND run_id=$2 AND attempt_number=$3 AND attempt_id=$4 FOR UPDATE`,
    [identity.organizationId, identity.runId, identity.runAttemptNumber, identity.runAttemptId],
  );
  const runner = await client.query<RunnerAuthorityRow>(
    `SELECT organization_id,runner_id,registration_generation,credential_generation,
       current_credential_id
     FROM cp_runner WHERE organization_id=$1 AND runner_id=$2 FOR UPDATE`,
    [identity.organizationId, identity.runnerId],
  );
  const candidate = await client.query<CandidateAuthorityRow>(
    `SELECT organization_id,candidate_id,run_id,attempt_id,attempt_number,project_target_id,
       frozen_base_revision,workspace_tree_digest,publication_policy_digest,candidate
     FROM cp_publication_candidate
     WHERE organization_id=$1 AND candidate_id=$2 FOR UPDATE`,
    [identity.organizationId, identity.candidateId],
  );
  const target = await client.query<ProjectTargetAuthorityRow>(
    `SELECT organization_id,project_target_id,runner_id,binding_digest,binding_generation,
       provider,owner,repo,default_branch
     FROM cp_project_target
     WHERE organization_id=$1 AND project_target_id=$2 FOR UPDATE`,
    [identity.organizationId, identity.projectTargetId],
  );
  if (!run.rows[0] || !attempt.rows[0] || !runner.rows[0]
    || !candidate.rows[0] || !target.rows[0]) return null;
  return { run: run.rows[0], attempt: attempt.rows[0], runner: runner.rows[0],
    candidate: candidate.rows[0], target: target.rows[0] };
}

async function lockAuthority(client: PostgresTransactionClient, input: {
  organizationId: string;
  effectId: string;
}): Promise<LockedAuthority | null> {
  const discovered = await client.query<Pick<EffectRow, "run_id" | "run_attempt_id" |
    "run_attempt_number" | "runner_id" | "candidate_id" | "project_target_id">>(
    `SELECT run_id,run_attempt_id,run_attempt_number,runner_id,candidate_id,project_target_id
     FROM cp_effect WHERE organization_id=$1 AND effect_id=$2`,
    [input.organizationId, input.effectId],
  );
  const identity = discovered.rows[0];
  if (!identity) return null;
  const rows = await lockAuthorityRows(client, {
    organizationId: input.organizationId,
    runId: identity.run_id,
    runAttemptId: identity.run_attempt_id,
    runAttemptNumber: identity.run_attempt_number,
    runnerId: identity.runner_id,
    candidateId: identity.candidate_id,
    projectTargetId: identity.project_target_id,
  });
  const effect = await client.query<EffectRow>(
    `SELECT * FROM cp_effect WHERE organization_id=$1 AND effect_id=$2 FOR UPDATE`,
    [input.organizationId, input.effectId],
  );
  return rows && effect.rows[0] ? { ...rows, effect: effect.rows[0] } : null;
}

function parseStoredAuthorityValue<T>(
  schema: { parse(value: unknown): T },
  value: unknown,
  code: EffectAuthorityStoredStateErrorCode,
): T {
  try {
    return schema.parse(value);
  } catch {
    throw new EffectAuthorityStoredStateError(code);
  }
}

function parseStoredPolicy(run: RunAuthorityRow): AdmissionPolicySnapshotReceiptEnvelopeV1 {
  return parseStoredAuthorityValue(
    AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
    run.admission_policy_snapshot,
    "EFFECT_AUTHORITY_STORED_POLICY_INVALID",
  );
}

function parseStoredEffectTarget(effect: EffectRow): EffectRequestV1["target"] {
  return parseStoredAuthorityValue(
    GitHubDraftPullRequestEffectTargetV1Schema,
    effect.target,
    "EFFECT_AUTHORITY_STORED_TARGET_INVALID",
  );
}

function parseStoredAuthorityDocuments(rows: AuthorityRows): StoredAuthorityDocuments | null {
  const admission = parseStoredAuthorityValue(
    HostedAdmissionEnvelopeV1Schema,
    rows.run.hosted_admission,
    "EFFECT_AUTHORITY_STORED_ADMISSION_INVALID",
  );
  const policy = parseStoredPolicy(rows.run);
  if (rows.attempt.workspace_attestation === null) return null;
  const workspace = parseStoredAuthorityValue(
    AttemptWorkspaceAttestationV1Schema,
    rows.attempt.workspace_attestation,
    "EFFECT_AUTHORITY_STORED_WORKSPACE_INVALID",
  );
  return { admission, workspace, policy };
}

function authorityExpectationFromRequest(request: EffectRequestV1): EffectAuthorityExpectation {
  return {
    organizationId: request.organizationId,
    runnerId: request.runnerId,
    runnerGeneration: request.runnerGeneration,
    runId: request.work.runId,
    runAttemptId: request.work.attemptId,
    runAttemptNumber: request.work.attemptNumber,
    fencingTokenDigest: request.work.fencingTokenDigest,
    candidateId: request.candidate.candidateId,
    candidateDigest: request.candidate.candidateDigest,
    projectTargetId: request.target.projectTargetId,
    targetBindingDigest: request.target.targetBindingDigest,
    targetBindingGeneration: request.target.targetBindingGeneration,
    target: request.target,
    policySnapshotId: request.authority.policySnapshotId,
    policySnapshotDigest: request.authority.policySnapshotDigest,
  };
}

function authorityExpectationFromEffect(
  effect: EffectRow,
  target: EffectRequestV1["target"],
): EffectAuthorityExpectation {
  return {
    organizationId: effect.organization_id,
    runnerId: effect.runner_id,
    runnerGeneration: effect.runner_generation,
    runId: effect.run_id,
    runAttemptId: effect.run_attempt_id,
    runAttemptNumber: effect.run_attempt_number,
    fencingTokenDigest: effect.fencing_token_digest,
    candidateId: effect.candidate_id,
    candidateDigest: effect.candidate_digest,
    projectTargetId: effect.project_target_id,
    targetBindingDigest: effect.target_binding_digest,
    targetBindingGeneration: effect.target_binding_generation,
    target,
    policySnapshotId: effect.policy_snapshot_id,
    policySnapshotDigest: effect.policy_snapshot_digest,
  };
}

function exactAuthority(
  rows: AuthorityRows,
  expected: EffectAuthorityExpectation,
): boolean {
  const documents = parseStoredAuthorityDocuments(rows);
  if (!documents) return false;
  const { run, attempt, runner, candidate, target } = rows;
  const { admission, workspace, policy } = documents;
  return run.organization_id === expected.organizationId
    && run.run_id === expected.runId
    && run.publication_mode === "pull_request"
    && run.completion_mode === "pull_request_ready"
    && run.terminal_kind === null
    && run.runner_id === expected.runnerId
    && run.current_attempt_number === expected.runAttemptNumber
    && attempt.organization_id === expected.organizationId
    && attempt.run_id === expected.runId
    && attempt.attempt_id === expected.runAttemptId
    && attempt.attempt_number === expected.runAttemptNumber
    && attempt.runner_id === expected.runnerId
    && attempt.state === "succeeded"
    && attempt.fencing_token_digest === expected.fencingTokenDigest
    && runner.organization_id === expected.organizationId
    && runner.runner_id === expected.runnerId
    && runner.credential_generation === expected.runnerGeneration
    && candidate.organization_id === expected.organizationId
    && candidate.run_id === expected.runId
    && candidate.attempt_id === expected.runAttemptId
    && candidate.attempt_number === expected.runAttemptNumber
    && candidate.candidate_id === expected.candidateId
    && digest(candidate.candidate) === expected.candidateDigest
    && candidate.project_target_id === expected.projectTargetId
    && candidate.frozen_base_revision === expected.target.frozenBaseRevision
    && candidate.workspace_tree_digest === expected.target.workspaceTreeDigest
    && candidate.publication_policy_digest === run.publication_policy_digest
    && target.organization_id === expected.organizationId
    && target.project_target_id === expected.projectTargetId
    && target.runner_id === expected.runnerId
    && target.binding_digest === expected.targetBindingDigest
    && target.binding_generation === expected.targetBindingGeneration
    && target.provider.toLowerCase() === expected.target.provider
    && target.owner.toLowerCase() === expected.target.owner.toLowerCase()
    && target.repo.toLowerCase() === expected.target.repo.toLowerCase()
    && target.default_branch === expected.target.baseBranch
    && workspace.attemptId === expected.runAttemptId
    && workspace.attemptNumber === expected.runAttemptNumber
    && workspace.fencingTokenDigest === expected.fencingTokenDigest
    && workspace.baseRevision === expected.target.frozenBaseRevision
    && workspace.currentTree === expected.target.workspaceTreeDigest
    && workspace.currentRevision === expected.target.expectedHeadSha
    && admission.organizationId === expected.organizationId
    && admission.runnerId === expected.runnerId
    && admission.projectTarget.projectTargetId === expected.projectTargetId
    && admission.projectTarget.digest === expected.targetBindingDigest
    && admission.publicationPolicy.mode === "pull_request"
    && admission.publicationPolicy.digest === run.publication_policy_digest
    && admission.completionContract.mode === "pull_request_ready"
    && admission.repository.provider === expected.target.provider
    && admission.repository.owner.toLowerCase() === expected.target.owner.toLowerCase()
    && admission.repository.repo.toLowerCase() === expected.target.repo.toLowerCase()
    && admission.admissionPolicySnapshot.snapshotId === expected.policySnapshotId
    && admission.admissionPolicySnapshot.digest === expected.policySnapshotDigest
    && policy.payload.snapshotId === expected.policySnapshotId
    && policy.receiptDigest === expected.policySnapshotDigest
    && policy.runId === expected.runId
    && policy.payload.tenant.organizationId === expected.organizationId
    && policy.payload.runner.runnerId === expected.runnerId
    && policy.payload.target.projectTargetId === expected.projectTargetId
    && policy.payload.target.repositoryProvider === expected.target.provider
    && policy.payload.target.defaultBranch === expected.target.baseBranch
    && policy.payload.target.authorizedPublicationModes.includes("pull_request");
}

function exactFrozenAuthority(rows: AuthorityRows, request: EffectRequestV1): boolean {
  return exactAuthority(rows, authorityExpectationFromRequest(request));
}

async function exactStoredAuthority(locked: LockedAuthority): Promise<boolean> {
  const target = parseStoredEffectTarget(locked.effect);
  if (locked.effect.target_digest !== await computeEffectTargetDigestV1(target)) {
    throw new EffectAuthorityStoredStateError("EFFECT_AUTHORITY_STORED_TARGET_DIGEST_INVALID");
  }
  return locked.effect.effect_kind === "github.create_draft_pull_request"
    && locked.effect.project_target_id === target.projectTargetId
    && locked.effect.target_binding_digest === target.targetBindingDigest
    && locked.effect.target_binding_generation === target.targetBindingGeneration
    && exactAuthority(locked, authorityExpectationFromEffect(locked.effect, target));
}

async function activeExecuteAuthority(locked: LockedAuthority, principal: RuntimePrincipal,
  now: Date): Promise<boolean> {
  return await exactStoredAuthority(locked)
    && locked.effect.organization_id === principal.organizationId
    && locked.effect.runner_id === principal.runnerId
    && locked.effect.runner_generation === principal.credentialGeneration
    && locked.runner.current_credential_id === principal.credentialId
    && locked.runner.registration_generation === principal.registrationGeneration
    && locked.runner.credential_generation === principal.credentialGeneration
    && locked.effect.approval_id !== null
    && locked.effect.approval_digest !== null
    && locked.effect.approval_expires_at.getTime() > now.getTime();
}

function exactAbsenceScope(effect: EffectRow, evidence: EffectEvidenceEnvelopeV1): boolean {
  if (evidence.evidence.kind !== "absent") return false;
  const target = parseStoredEffectTarget(effect);
  const scope = evidence.evidence.observationScope;
  return scope.provider === target.provider
    && scope.repository.owner.toLowerCase() === target.owner.toLowerCase()
    && scope.repository.repo.toLowerCase() === target.repo.toLowerCase()
    && scope.baseBranch === target.baseBranch
    && scope.headBranch === target.branch
    && scope.expectedHeadSha === target.expectedHeadSha
    && scope.bindingGeneration === target.targetBindingGeneration
    && scope.targetBindingDigest === target.targetBindingDigest
    && scope.observationPolicy === "github.exact_draft_pr.v1";
}

function exactPresentObservation(effect: EffectRow, evidence: EffectEvidenceEnvelopeV1): boolean {
  if (evidence.evidence.kind !== "present") return false;
  const target = parseStoredEffectTarget(effect);
  const observation = evidence.evidence.observation;
  return observation.provider === target.provider
    && observation.repository.owner.toLowerCase() === target.owner.toLowerCase()
    && observation.repository.repo.toLowerCase() === target.repo.toLowerCase()
    && observation.remote === target.remote
    && observation.baseBranch === target.baseBranch
    && observation.branch === target.branch
    && observation.headSha === target.expectedHeadSha
    && observation.headBranch === target.branch
    && observation.headRepository.owner.toLowerCase() === target.owner.toLowerCase()
    && observation.headRepository.repo.toLowerCase() === target.repo.toLowerCase();
}

async function latestEvidence(client: PostgresTransactionClient, effect: EffectRow) {
  return (await client.query<{ evidence_digest: string; evidence: unknown; sequence: number }>(
    `SELECT evidence_digest,evidence,sequence FROM cp_effect_evidence
     WHERE organization_id=$1 AND effect_id=$2 ORDER BY sequence DESC LIMIT 1 FOR UPDATE`,
    [effect.organization_id, effect.effect_id],
  )).rows[0] ?? null;
}

async function readAttemptByAcquire(client: PostgresTransactionClient, input: {
  principal: RuntimePrincipal;
  request: EffectAcquireRequestV1;
}) {
  return (await client.query<AttemptRow>(
    `SELECT * FROM cp_effect_attempt
     WHERE organization_id=$1 AND runner_id=$2 AND acquire_request_id=$3`,
    [input.principal.organizationId, input.principal.runnerId, input.request.requestId],
  )).rows[0] ?? null;
}

export function createEffectAuthority(input: {
  pool: Pool;
  clock: Clock;
  idFactory: IdFactory;
  permitTtlMs?: number;
  issueApprovalInTransaction?: (
    client: PostgresTransactionClient,
    issue: EffectApprovalIssue,
  ) => Promise<void>;
}) {
  const ttl = Math.min(input.permitTtlMs ?? 60_000, 5 * 60_000);

  return {
    async request(command: { principal: RuntimePrincipal; request: EffectRequestV1 }): Promise<
      { kind: "requested" | "replayed"; effect: EffectViewV1; approvalRequestDigest: string }
      | { kind: "conflict"; reason: string }
    > {
      const request = EffectRequestV1Schema.parse(command.request);
      if (!await verifyEffectRequestV1(request)) {
        return { kind: "conflict", reason: "request_digest_mismatch" };
      }
      const now = input.clock.now();
      if (request.organizationId !== command.principal.organizationId
        || request.runnerId !== command.principal.runnerId
        || request.runnerGeneration !== command.principal.credentialGeneration) {
        return { kind: "conflict", reason: "authority_mismatch" };
      }
      if (Date.parse(request.requestedAt) > now.getTime()
        || Date.parse(request.authority.approvalExpiresAt) <= now.getTime()) {
        return { kind: "conflict", reason: "approval_window_stale" };
      }
      const approvalRequest = approvalRequestDigest(request);
      const targetDigest = await computeEffectTargetDigestV1(request.target);
      return withPostgresTransaction(input.pool, async (client) => {
        const lockKeys = [request.effectId, `approval:${request.authority.approvalRequestId}`,
          `idempotency:${request.runnerId}:${request.idempotencyKey}`,
          `logical:${request.effectKind}:${request.candidate.candidateId}`].sort();
        for (const key of lockKeys) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`effect:${request.organizationId}:${key}`]);
        }
        const existing = await client.query<EffectRow>(
          `SELECT * FROM cp_effect WHERE organization_id=$1 AND
             (effect_id=$2 OR (runner_id=$3 AND idempotency_key=$4) OR approval_request_id=$5
               OR (effect_kind=$6 AND candidate_id=$7))
           ORDER BY effect_id FOR UPDATE`,
          [request.organizationId, request.effectId, request.runnerId,
            request.idempotencyKey, request.authority.approvalRequestId,
            request.effectKind, request.candidate.candidateId],
        );
        if (existing.rowCount !== 0) {
          const row = existing.rows[0]!;
          return existing.rowCount === 1 && row.effect_id === request.effectId
            && row.request_digest === request.requestDigest
            && row.approval_request_digest === approvalRequest
            ? { kind: "replayed" as const, effect: projectEffect(row),
                approvalRequestDigest: approvalRequest }
            : { kind: "conflict" as const, reason: "request_replay_conflict" };
        }
        const authorityRows = await lockAuthorityRows(client, {
          organizationId: request.organizationId,
          runId: request.work.runId,
          runAttemptId: request.work.attemptId,
          runAttemptNumber: request.work.attemptNumber,
          runnerId: request.runnerId,
          candidateId: request.candidate.candidateId,
          projectTargetId: request.target.projectTargetId,
        });
        if (!authorityRows) {
          return { kind: "conflict" as const, reason: "stale_effect_authority" };
        }
        if (authorityRows.runner.current_credential_id !== command.principal.credentialId
          || authorityRows.runner.registration_generation !== command.principal.registrationGeneration
          || !exactFrozenAuthority(authorityRows, request)) {
          return { kind: "conflict" as const, reason: "stale_effect_authority" };
        }
        await client.query(
          `INSERT INTO cp_effect(organization_id,effect_id,idempotency_key,effect_kind,
             request_id,request_digest,runner_id,runner_generation,run_id,
             run_attempt_id,run_attempt_number,fencing_token_digest,candidate_id,candidate_digest,
             project_target_id,target_binding_digest,target_binding_generation,target_digest,target,
             policy_snapshot_id,policy_snapshot_digest,approval_request_id,approval_request_digest,
             approval_expires_at,state,current_attempt_number,requested_at,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             $18,$19::jsonb,$20,$21,$22,$23,$24,'requested',0,$25,$26,$26)`,
          [request.organizationId, request.effectId, request.idempotencyKey, request.effectKind,
            request.requestId, request.requestDigest, request.runnerId, request.runnerGeneration,
            request.work.runId, request.work.attemptId, request.work.attemptNumber,
            request.work.fencingTokenDigest, request.candidate.candidateId,
            request.candidate.candidateDigest, request.target.projectTargetId,
            request.target.targetBindingDigest, request.target.targetBindingGeneration,
            targetDigest, JSON.stringify(request.target), request.authority.policySnapshotId,
            request.authority.policySnapshotDigest, request.authority.approvalRequestId,
            approvalRequest, request.authority.approvalExpiresAt, request.requestedAt, now],
        );
        await input.issueApprovalInTransaction?.(client, {
          organizationId: request.organizationId,
          effectId: request.effectId,
          effectKind: request.effectKind,
          requestId: request.requestId,
          requestDigest: request.requestDigest,
          runnerId: request.runnerId,
          runnerGeneration: request.runnerGeneration,
          work: {
            runId: request.work.runId,
            attemptId: request.work.attemptId,
            attemptNumber: request.work.attemptNumber,
            epoch: request.work.epoch,
            fencingTokenDigest: request.work.fencingTokenDigest,
          },
          candidate: request.candidate,
          target: request.target,
          policy: {
            snapshotId: request.authority.policySnapshotId,
            snapshotDigest: request.authority.policySnapshotDigest,
          },
          approvalRequest: {
            approvalRequestId: request.authority.approvalRequestId,
            approvalRequestDigest: approvalRequest,
            expiresAt: request.authority.approvalExpiresAt,
          },
          createdAt: now,
        });
        const row = (await client.query<EffectRow>(
          "SELECT * FROM cp_effect WHERE organization_id=$1 AND effect_id=$2",
          [request.organizationId, request.effectId],
        )).rows[0]!;
        return { kind: "requested" as const, effect: projectEffect(row),
          approvalRequestDigest: approvalRequest };
      });
    },

    async approve(command: EffectApproval): Promise<
      { kind: "approved" | "replayed"; effect: EffectViewV1; approvalDigest: string }
      | { kind: "rejected"; reason: string }
    > {
      const now = input.clock.now();
      const approvedAt = Date.parse(command.approvedAt);
      if (command.approvedBy === "" || !Number.isFinite(approvedAt)
        || new Date(approvedAt).toISOString() !== command.approvedAt
        || approvedAt > now.getTime()) {
        return { kind: "rejected", reason: "approval_invalid" };
      }
      return withPostgresTransaction(input.pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`effect-approval:${command.organizationId}:${command.approvalId}`]);
        const locked = await lockAuthority(client, command);
        if (!locked) return { kind: "rejected" as const, reason: "stale_effect_authority" };
        const effect = locked.effect;
        const computed = approvalDigest(command, effect);
        const approvalCollision = await client.query<{ effect_id: string }>(
          `SELECT effect_id FROM cp_effect WHERE organization_id=$1 AND approval_id=$2`,
          [command.organizationId, command.approvalId],
        );
        if (approvalCollision.rows[0]
          && approvalCollision.rows[0].effect_id !== command.effectId) {
          return { kind: "rejected" as const, reason: "approval_replay_conflict" };
        }
        if (effect.approval_id !== null) {
          return effect.approval_id === command.approvalId
            && effect.approval_digest === computed
            ? { kind: "replayed" as const, effect: projectEffect(effect), approvalDigest: computed }
            : { kind: "rejected" as const, reason: "approval_replay_conflict" };
        }
        if (command.approvalRequestId !== effect.approval_request_id
          || command.approvalRequestDigest !== effect.approval_request_digest
          || command.approvedBy === effect.runner_id
          || effect.state !== "requested"
          || effect.approval_expires_at.getTime() <= now.getTime()
          || approvedAt < effect.requested_at.getTime()
          || Date.parse(command.approvedAt) > effect.approval_expires_at.getTime()
          || !await exactStoredAuthority(locked)) {
          return { kind: "rejected" as const, reason: command.approvedBy === effect.runner_id
            ? "self_approval_prohibited" : "stale_effect_authority" };
        }
        const approval = { approvalRequestId: command.approvalRequestId,
          approvalRequestDigest: command.approvalRequestDigest, approvalId: command.approvalId,
          approvedBy: command.approvedBy, approvedAt: command.approvedAt };
        await client.query(
          `UPDATE cp_effect SET approval_id=$3,approval_digest=$4,approval=$5::jsonb,
             state='authorized',updated_at=$6
           WHERE organization_id=$1 AND effect_id=$2 AND approval_id IS NULL`,
          [command.organizationId, command.effectId, command.approvalId, computed,
            JSON.stringify(approval), now],
        );
        const updated = (await client.query<EffectRow>(
          "SELECT * FROM cp_effect WHERE organization_id=$1 AND effect_id=$2",
          [command.organizationId, command.effectId],
        )).rows[0]!;
        return { kind: "approved" as const, effect: projectEffect(updated),
          approvalDigest: computed };
      });
    },

    async acquire(command: { principal: RuntimePrincipal; request: EffectAcquireRequestV1 }): Promise<
      { kind: "issued" | "replayed"; permit: EffectPermitV1 }
      | { kind: "empty" }
      | { kind: "blocked"; reason: string }
      | { kind: "conflict"; reason: string }
    > {
      const request = EffectAcquireRequestV1Schema.parse(command.request);
      if (request.organizationId !== command.principal.organizationId
        || request.runnerId !== command.principal.runnerId
        || request.runnerGeneration !== command.principal.credentialGeneration) {
        return { kind: "conflict", reason: "authority_mismatch" };
      }
      return withPostgresTransaction(input.pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`effect-acquire:${request.organizationId}:${request.runnerId}:${request.requestId}`]);
        const replayCandidate = await readAttemptByAcquire(client, {
          principal: command.principal, request });
        if (replayCandidate) {
          const locked = await lockAuthority(client, {
            organizationId: request.organizationId,
            effectId: replayCandidate.effect_id,
          });
          const replay = locked ? (await client.query<AttemptRow>(
            `SELECT * FROM cp_effect_attempt WHERE organization_id=$1 AND effect_id=$2
               AND permit_id=$3 AND runner_id=$4 AND acquire_request_id=$5 FOR UPDATE`,
            [request.organizationId, replayCandidate.effect_id, replayCandidate.permit_id,
              request.runnerId, request.requestId],
          )).rows[0] : null;
          if (!locked || !replay) {
            return { kind: "conflict" as const, reason: "acquire_replay_conflict" };
          }
          const permit = EffectPermitV1Schema.parse(replay.permit);
          const currentRunner = locked.runner.current_credential_id === command.principal.credentialId
            && locked.runner.registration_generation === command.principal.registrationGeneration
            && locked.runner.credential_generation === command.principal.credentialGeneration;
          const executeSuperseded = permit.permitKind === "execute"
            ? (await client.query(
              `SELECT 1 WHERE EXISTS (SELECT 1 FROM cp_effect_evidence
                 WHERE organization_id=$1 AND permit_id=$2)
               OR EXISTS (SELECT 1 FROM cp_effect_attempt
                 WHERE organization_id=$1 AND original_execute_permit_id=$2)`,
              [request.organizationId, permit.permitId],
            )).rowCount !== 0
            : false;
          const executeAuthority = permit.permitKind !== "execute"
            || (!executeSuperseded && locked.effect.state === "permit_issued"
              && locked.effect.current_attempt_number === permit.effectAttemptNumber
              && await exactStoredAuthority(locked));
          return replay.acquire_journal_digest === request.acquireJournalDigest
            && replay.runner_generation === request.runnerGeneration
            && permit.acquireRequestId === request.requestId
            && permit.acquireJournalDigest === request.acquireJournalDigest
            && permit.runnerId === request.runnerId
            && permit.runnerGeneration === request.runnerGeneration
            && currentRunner && executeAuthority && await verifyEffectPermitV1(permit)
            ? { kind: "replayed" as const, permit }
            : { kind: "conflict" as const, reason: "acquire_replay_conflict" };
        }
        const candidates = await client.query<{ effect_id: string }>(
          `SELECT effect_id FROM cp_effect
           WHERE organization_id=$1 AND runner_id=$2
             AND state IN (
               'authorized','permit_issued','observing','outcome_unknown','retry_eligible','attention')
           ORDER BY requested_at,effect_id`,
          [request.organizationId, request.runnerId],
        );
        let blockedReason: string | null = null;
        for (const candidate of candidates.rows) {
          const locked = await lockAuthority(client, {
            organizationId: request.organizationId, effectId: candidate.effect_id });
          if (!locked || locked.effect.runner_id !== request.runnerId) continue;
          const effect = locked.effect;
          const existingExecute = (await client.query<AttemptRow>(
            `SELECT * FROM cp_effect_attempt WHERE organization_id=$1 AND effect_id=$2
               AND permit_kind='execute' ORDER BY effect_attempt_number DESC LIMIT 1 FOR UPDATE`,
            [effect.organization_id, effect.effect_id],
          )).rows[0] ?? null;
          const latest = await latestEvidence(client, effect);
          const latestEvidenceValue = latest
            ? EffectEvidenceEnvelopeV1Schema.parse(latest.evidence) : null;
          if (["observing", "outcome_unknown", "retry_eligible", "attention"].includes(effect.state)
            && effect.current_evidence_digest !== latest?.evidence_digest) {
            blockedReason ??= "effect_evidence_projection_mismatch";
            continue;
          }
          const executeAllowed = (effect.state === "authorized" && existingExecute === null)
            || (effect.state === "retry_eligible"
              && effect.reason_code === "local.provider_io_not_begun"
              && latestEvidenceValue?.evidence.kind === "not_started");
          let permitKind: "execute" | "reconcile";
          if (executeAllowed) {
            if (!await activeExecuteAuthority(locked, command.principal, input.clock.now())) {
              if (existingExecute === null && locked.run.terminal_kind !== null) {
                await client.query(
                  `UPDATE cp_effect SET state='cancelled_before_permit',
                     reason_code='work.cancelled_before_permit',updated_at=$3
                   WHERE organization_id=$1 AND effect_id=$2`,
                  [effect.organization_id, effect.effect_id, input.clock.now()],
                );
              } else if (existingExecute === null
                && effect.approval_expires_at.getTime() <= input.clock.now().getTime()) {
                await client.query(
                  `UPDATE cp_effect SET state='attention',
                     reason_code='approval_expired_before_permit',updated_at=$3
                   WHERE organization_id=$1 AND effect_id=$2`,
                  [effect.organization_id, effect.effect_id, input.clock.now()],
                );
                blockedReason ??= "approval_expired_before_permit";
              }
              continue;
            }
            permitKind = "execute";
          } else {
            if (!existingExecute) continue;
            if (effect.state === "attention" && effect.current_attempt_number === 0) continue;
            const currentRunner = locked.runner.runner_id === command.principal.runnerId
              && locked.runner.current_credential_id === command.principal.credentialId
              && locked.runner.registration_generation === command.principal.registrationGeneration
              && locked.runner.credential_generation === command.principal.credentialGeneration;
            if (!currentRunner) continue;
            const unresolvedReconcile = await client.query<AttemptRow>(
              `SELECT attempt.* FROM cp_effect_attempt attempt
               WHERE attempt.organization_id=$1 AND attempt.effect_id=$2
                 AND attempt.original_execute_permit_id=$3 AND attempt.permit_kind='reconcile'
                 AND attempt.expires_at > $4
                 AND NOT EXISTS (SELECT 1 FROM cp_effect_evidence evidence
                   WHERE evidence.organization_id=attempt.organization_id
                     AND evidence.permit_id=attempt.permit_id)
               ORDER BY attempt.created_at DESC LIMIT 1 FOR UPDATE`,
              [effect.organization_id, effect.effect_id, existingExecute.permit_id,
                input.clock.now()],
            );
            if (unresolvedReconcile.rowCount !== 0) {
              blockedReason ??= "reconciliation_permit_outstanding";
              continue;
            }
            permitKind = "reconcile";
          }
          const latestPermitNumber = (await client.query<{ value: number }>(
            `SELECT COALESCE(MAX(effect_attempt_number),0)::int AS value
             FROM cp_effect_attempt WHERE organization_id=$1 AND effect_id=$2`,
            [effect.organization_id, effect.effect_id],
          )).rows[0]!.value;
          const effectAttemptNumber = latestPermitNumber + 1;
          const now = input.clock.now();
          const permitCommon = {
            schemaVersion: 1 as const,
            protocolVersion: "1.0" as const,
            requiredCapabilities: ["relay.effect-authority.v1"] as ["relay.effect-authority.v1"],
            permitId: input.idFactory("permit"),
            effectId: effect.effect_id,
            effectAttemptNumber,
            organizationId: effect.organization_id,
            runnerId: request.runnerId,
            runnerGeneration: request.runnerGeneration,
            acquireRequestId: request.requestId,
            acquireJournalDigest: request.acquireJournalDigest,
            runId: effect.run_id,
            runAttemptId: effect.run_attempt_id,
            runAttemptNumber: effect.run_attempt_number,
            fencingTokenDigest: effect.fencing_token_digest,
            effectKind: effect.effect_kind,
            requestDigest: effect.request_digest,
            targetDigest: effect.target_digest,
            approvalDigest: effect.approval_digest!,
            candidate: { candidateId: effect.candidate_id, candidateDigest: effect.candidate_digest },
            target: parseStoredEffectTarget(effect),
            ...(latest ? { predecessorEvidenceDigest: latest.evidence_digest } : {}),
            issuedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + ttl).toISOString(),
          };
          const permitBase = permitKind === "reconcile" ? {
            ...permitCommon,
            permitKind: "reconcile" as const,
            originalExecutePermitId: existingExecute!.permit_id,
            observationPolicy: "github.exact_draft_pr.v1" as const,
          } : { ...permitCommon, permitKind: "execute" as const };
          const permit = EffectPermitV1Schema.parse({ ...permitBase,
            permitDigest: await computeEffectPermitDigestV1(permitBase) });
          await client.query(
            `INSERT INTO cp_effect_attempt(organization_id,permit_id,effect_id,effect_attempt_number,
               permit_kind,original_execute_permit_id,acquire_request_id,acquire_journal_digest,
               runner_id,runner_generation,request_digest,target_digest,approval_digest,permit_digest,
               permit,issued_at,expires_at,created_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$16)`,
            [effect.organization_id, permit.permitId, effect.effect_id, effectAttemptNumber,
              permitKind, permitKind === "reconcile" ? existingExecute!.permit_id : null,
              request.requestId, request.acquireJournalDigest, request.runnerId,
              request.runnerGeneration, effect.request_digest, effect.target_digest,
              effect.approval_digest, permit.permitDigest, JSON.stringify(permit),
              permit.issuedAt, permit.expiresAt],
          );
          if (permitKind === "execute") {
            await client.query(
              `UPDATE cp_effect SET state='permit_issued',current_attempt_number=$3,
                 current_evidence_digest=NULL,external_resource=NULL,reason_code=NULL,updated_at=$4
               WHERE organization_id=$1 AND effect_id=$2`,
              [effect.organization_id, effect.effect_id, effectAttemptNumber, now],
            );
          }
          return { kind: "issued" as const, permit };
        }
        return blockedReason
          ? { kind: "blocked" as const, reason: blockedReason }
          : { kind: "empty" as const };
      });
    },

    async record(command: { principal: RuntimePrincipal; evidence: EffectEvidenceEnvelopeV1 }): Promise<
      { kind: "recorded" | "replayed"; effect: EffectViewV1 }
      | { kind: "conflict"; reason: string }
    > {
      const evidence = EffectEvidenceEnvelopeV1Schema.parse(command.evidence);
      if (!await verifyEffectEvidenceEnvelopeV1(evidence)
        || evidence.organizationId !== command.principal.organizationId
        || evidence.producer.runnerId !== command.principal.runnerId
        || evidence.producer.runnerGeneration !== command.principal.credentialGeneration
        || Date.parse(evidence.observedAt) > input.clock.now().getTime()) {
        return { kind: "conflict", reason: "evidence_authority_mismatch" };
      }
      return withPostgresTransaction(input.pool, async (client) => {
        const locked = await lockAuthority(client, {
          organizationId: evidence.organizationId, effectId: evidence.effectId });
        if (!locked) return { kind: "conflict" as const, reason: "effect_missing" };
        const effect = locked.effect;
        if (locked.runner.current_credential_id !== command.principal.credentialId
          || locked.runner.registration_generation !== command.principal.registrationGeneration
          || locked.runner.credential_generation !== command.principal.credentialGeneration) {
          return { kind: "conflict" as const, reason: "stale_runner_authority" };
        }
        const existing = await client.query<{ evidence_id: string; evidence_digest: string;
          effect_id: string }>(
          `SELECT evidence_id,evidence_digest,effect_id FROM cp_effect_evidence
           WHERE organization_id=$1 AND (evidence_id=$2 OR evidence_digest=$3)
           ORDER BY evidence_id FOR UPDATE`,
          [evidence.organizationId, evidence.evidenceId, evidence.evidenceDigest],
        );
        if (existing.rowCount !== 0) {
          const row = existing.rows[0]!;
          return existing.rowCount === 1 && row.evidence_id === evidence.evidenceId
            && row.evidence_digest === evidence.evidenceDigest && row.effect_id === evidence.effectId
            ? { kind: "replayed" as const, effect: projectEffect(effect) }
            : { kind: "conflict" as const, reason: "evidence_replay_conflict" };
        }
        const attempt = (await client.query<AttemptRow>(
          `SELECT * FROM cp_effect_attempt WHERE organization_id=$1 AND effect_id=$2
             AND permit_id=$3 AND effect_attempt_number=$4 FOR UPDATE`,
          [evidence.organizationId, evidence.effectId, evidence.permitId,
            evidence.effectAttemptNumber],
        )).rows[0];
        if (!attempt || attempt.runner_id !== evidence.producer.runnerId
          || attempt.runner_generation !== evidence.producer.runnerGeneration
          || attempt.request_digest !== effect.request_digest
          || attempt.target_digest !== effect.target_digest
          || attempt.approval_digest !== effect.approval_digest) {
          return { kind: "conflict" as const, reason: "permit_mismatch" };
        }
        const permit = EffectPermitV1Schema.parse(attempt.permit);
        if (!await verifyEffectPermitV1(permit)
          || permit.permitDigest !== attempt.permit_digest
          || permit.permitId !== evidence.permitId
          || permit.effectAttemptNumber !== evidence.effectAttemptNumber) {
          return { kind: "conflict" as const, reason: "permit_digest_mismatch" };
        }
        const latest = await latestEvidence(client, effect);
        if (["observing", "outcome_unknown", "attention"].includes(effect.state)
          && effect.current_attempt_number > 0
          && effect.current_evidence_digest !== latest?.evidence_digest) {
          return { kind: "conflict" as const, reason: "effect_evidence_projection_mismatch" };
        }
        if (permit.predecessorEvidenceDigest !== evidence.predecessorEvidenceDigest) {
          return { kind: "conflict" as const, reason: "permit_predecessor_mismatch" };
        }
        if ((latest === null && evidence.predecessorEvidenceDigest !== undefined)
          || (latest !== null && evidence.predecessorEvidenceDigest !== latest.evidence_digest)) {
          return { kind: "conflict" as const, reason: "evidence_predecessor_mismatch" };
        }
        if (effect.state === "succeeded" || effect.state === "retry_eligible") {
          return { kind: "conflict" as const, reason: "effect_already_settled" };
        }
        const priorForPermit = await client.query(
          `SELECT 1 FROM cp_effect_evidence
           WHERE organization_id=$1 AND permit_id=$2 LIMIT 1 FOR UPDATE`,
          [evidence.organizationId, evidence.permitId],
        );
        const reconciliationForExecute = evidence.evidence.kind === "not_started"
          ? await client.query(
            `SELECT 1 FROM cp_effect_attempt WHERE organization_id=$1
               AND original_execute_permit_id=$2 LIMIT 1 FOR UPDATE`,
            [evidence.organizationId, evidence.permitId],
          ) : { rowCount: 0 };
        if (evidence.evidence.kind === "not_started"
          && (attempt.permit_kind !== "execute" || priorForPermit.rowCount !== 0
            || reconciliationForExecute.rowCount !== 0
            || evidence.evidence.acquireJournalDigest !== attempt.acquire_journal_digest)) {
          return { kind: "conflict" as const, reason: "not_started_not_admissible" };
        }
        if (evidence.evidence.kind === "absent"
          && (attempt.permit_kind !== "reconcile" || !exactAbsenceScope(effect, evidence))) {
          return { kind: "conflict" as const, reason: "absence_scope_mismatch" };
        }
        if (evidence.evidence.kind === "present" && !exactPresentObservation(effect, evidence)) {
          return { kind: "conflict" as const, reason: "presence_scope_mismatch" };
        }
        const sequence = (latest?.sequence ?? 0) + 1;
        await client.query(
          `INSERT INTO cp_effect_evidence(organization_id,evidence_id,effect_id,permit_id,
             effect_attempt_number,sequence,predecessor_evidence_digest,payload_digest,
             evidence_digest,evidence,observed_at,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
          [evidence.organizationId, evidence.evidenceId, evidence.effectId,
            evidence.permitId, evidence.effectAttemptNumber, sequence,
            evidence.predecessorEvidenceDigest ?? null, evidence.payloadDigest,
            evidence.evidenceDigest, JSON.stringify(evidence), evidence.observedAt,
            input.clock.now()],
        );
        let state: EffectRow["state"] = evidence.evidence.kind === "not_started"
          ? "retry_eligible" : "permit_issued";
        let resource = effect.external_resource as ReturnType<typeof externalResource> | null;
        let reason: string | null = null;
        if (evidence.evidence.kind === "not_started") {
          resource = null;
          reason = "local.provider_io_not_begun";
        } else if (evidence.evidence.kind === "ambiguous") {
          state = "outcome_unknown";
          reason = `github.${evidence.evidence.errorCode}`;
        } else if (evidence.evidence.kind === "absent") {
          state = "attention";
          reason = "github.provider_absence_requires_attention";
        } else if (evidence.evidence.kind === "attention") {
          state = "attention";
          reason = evidence.evidence.reasonCode;
        } else if (evidence.evidence.kind === "present") {
          const observation = evidence.evidence.observation;
          resource = externalResource(observation);
          const policy = parseStoredPolicy(locked.run);
          const effectTarget = parseStoredEffectTarget(effect);
          const readiness = assessExactPullRequestReadiness({
            snapshot: {
              provider: "github",
              deliveryId: `effect:${evidence.evidenceId}`,
              eventName: "pull_request",
              repository: observation.repository,
              pullRequest: {
                number: observation.pullRequestNumber,
                resourceRef: observation.pullRequestResourceRef,
                headSha: observation.headSha,
                baseSha: observation.baseSha,
                baseBranch: observation.baseBranch,
                state: observation.state,
              },
              checks: observation.checks,
              checksComplete: observation.checksComplete,
              observedAt: observation.observedAt,
              payloadDigest: await computeEffectEvidencePayloadDigestV1(evidence.evidence),
            },
            expectedRepository: {
              owner: effectTarget.owner,
              repo: effectTarget.repo,
            },
            expectedHeadSha: effectTarget.expectedHeadSha,
            expectedBaseBranch: effectTarget.baseBranch,
            requiredChecks: policy.payload.admissionRules.requiredCheckNames,
          });
          state = readiness.ready ? "succeeded" : "observing";
        }
        await client.query(
          `UPDATE cp_effect SET state=$3,current_attempt_number=$4,
             current_evidence_digest=$5,external_resource=$6::jsonb,reason_code=$7,updated_at=$8
           WHERE organization_id=$1 AND effect_id=$2`,
          [effect.organization_id, effect.effect_id, state,
            Math.max(effect.current_attempt_number, evidence.effectAttemptNumber),
            evidence.evidenceDigest, resource ? JSON.stringify(resource) : null, reason,
            input.clock.now()],
        );
        if (state === "succeeded" && locked.run.terminal_kind === null
          && locked.run.current_attempt_number === effect.run_attempt_number
          && locked.attempt.attempt_id === effect.run_attempt_id
          && locked.attempt.state === "succeeded") {
          await client.query(
            `UPDATE cp_hosted_run SET state='succeeded',terminal_kind='succeeded',
               terminal_receipt=$3::jsonb,updated_at=$4
             WHERE organization_id=$1 AND run_id=$2 AND terminal_kind IS NULL
               AND current_attempt_number=$5`,
            [effect.organization_id, effect.run_id, JSON.stringify({
              kind: "ready_for_review", effectId: effect.effect_id,
              candidateId: effect.candidate_id, evidenceDigest: evidence.evidenceDigest,
              externalResource: resource,
            }), input.clock.now(), effect.run_attempt_number],
          );
        }
        const updated = (await client.query<EffectRow>(
          "SELECT * FROM cp_effect WHERE organization_id=$1 AND effect_id=$2",
          [effect.organization_id, effect.effect_id],
        )).rows[0]!;
        return { kind: "recorded" as const, effect: projectEffect(updated) };
      });
    },
  };
}

export type EffectAuthority = ReturnType<typeof createEffectAuthority>;
