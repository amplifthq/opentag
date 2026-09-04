import { createHash } from "node:crypto";
import {
  AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
  RunnerBranchOwnershipAttestationV1Schema,
  PublicationOperationCapabilityV1Schema,
  RunnerPublicationCompletionV1Schema,
  PublicationOperationReceiptV1Schema,
  PublicationOperationObservationV1Schema,
  computeMaterialActionFencingTokenDigestV1,
  computeBranchOwnershipAttestationDigestV1,
  computePublicationCapabilityDigestV1,
  computePublicationOperationReceiptDigestV1,
  type PublicationOperationCapabilityV1,
  type PublicationOperationReceiptV1,
  type PublicationOperationStepV1,
  type RunnerBranchOwnershipAttestationV1,
} from "@opentag/control-protocol";
import { canonicalJsonStringify } from "@opentag/control-protocol/canonical-json";
import { assessExactPullRequestReadiness } from "@opentag/github";
import type { Pool } from "pg";
import { withPostgresTransaction, type PostgresTransactionClient } from "../../database/postgres.js";
import type { RuntimePrincipal } from "../runners/index.js";

type Clock = { now(): Date };
type IdFactory = (kind: "intent" | "ownership" | "capability" | "operation" | "completion") => string;
type PublicationLifecycleResource = "run" | "attempt" | "runner" | "intent";
type PublicationPublisherTestHooks = {
  onLifecycleLock?(event: {
    phase: "before" | "after";
    resource: PublicationLifecycleResource;
    organizationId: string;
    intentId: string;
    runId: string;
  }): void | Promise<void>;
};

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(value)).digest("hex")}`;
}

function exactReceiptObservation(capability: PublicationOperationCapabilityV1,
  observation: PublicationOperationReceiptV1["observation"]): boolean {
  if (observation.kind !== "present") return true;
  if (observation.headSha !== capability.expectedHeadSha) return false;
  if (capability.step === "push_owned_branch") return observation.externalId === undefined
    && observation.externalUri === undefined && observation.draft === undefined
    && observation.provider === undefined && observation.repository === undefined
    && observation.baseBranch === undefined && observation.state === undefined;
  const match = /^github_pr_([1-9][0-9]*)$/u.exec(observation.externalId ?? "");
  return Boolean(match
    && observation.externalUri === `https://github.com/${capability.repository.owner}/${capability.repository.repo}/pull/${match[1]}`
    && observation.draft === true && observation.provider === "github"
    && observation.repository?.owner === capability.repository.owner
    && observation.repository?.repo === capability.repository.repo
    && observation.baseBranch === capability.repository.baseBranch && observation.state === "open"
    && observation.headBranch === capability.branch
    && observation.headRepository?.owner.toLowerCase() === capability.repository.owner.toLowerCase()
    && observation.headRepository.repo.toLowerCase() === capability.repository.repo.toLowerCase());
}

type PublicationOperationRecord = {
  capability: PublicationOperationCapabilityV1;
  begunAt: Date | null;
  receipt: PublicationOperationReceiptV1 | null;
  reconciliation: { reconciliationId: string; observation: PublicationOperationReceiptV1["observation"]; observedAt: Date } | null;
};

type PublicationOperationState =
  | { kind: "settled"; record: PublicationOperationRecord }
  | { kind: "retryable"; record: PublicationOperationRecord }
  | { kind: "reconciliation_pending"; record: PublicationOperationRecord }
  | { kind: "issuable"; latest: PublicationOperationRecord | null };

/**
 * The only operation-state reducer.  It deliberately considers every durable
 * capability attempt for one immutable intent/step, rather than whichever
 * attempt happened to be queried last.  A success or exact provider presence
 * therefore remains authoritative even if a later observer reports absence.
 */
function reducePublicationOperation(records: PublicationOperationRecord[]): PublicationOperationState {
  const settled = records.find((record) => record.receipt?.outcome === "succeeded")
    ?? records.find((record) => record.reconciliation?.observation.kind === "present");
  if (settled) return { kind: "settled", record: settled };
  const latest = records[0] ?? null;
  if (!latest) return { kind: "issuable", latest: null };
  // An absence authorizes exactly one append-only successor.  Once that
  // successor exists, only its durable state decides whether anything else is
  // allowed; an older absence must never become a permanent issuance token.
  if (latest.reconciliation?.observation.kind === "absent") return { kind: "retryable", record: latest };
  if (latest.begunAt !== null || latest.receipt !== null || latest.reconciliation !== null) {
    return { kind: "reconciliation_pending", record: latest };
  }
  return { kind: "issuable", latest };
}

async function readPublicationOperationState(client: any, input: {
  organizationId: string; intentId: string; step: PublicationOperationStepV1; lock?: boolean;
}): Promise<{ records: PublicationOperationRecord[]; state: PublicationOperationState }> {
  const capabilities = await client.query(
    `SELECT * FROM cp_publication_capability WHERE organization_id=$1 AND intent_id=$2 AND step=$3
     ORDER BY attempt_number DESC${input.lock ? " FOR UPDATE" : ""}`,
    [input.organizationId, input.intentId, input.step],
  );
  const capabilityIds = capabilities.rows.map((row: { capability_id: string }) => row.capability_id);
  if (capabilityIds.length === 0) return { records: [], state: reducePublicationOperation([]) };
  if (input.lock) {
    await client.query(`SELECT 1 FROM cp_publication_begin WHERE organization_id=$1 AND capability_id=ANY($2::text[]) FOR UPDATE`, [input.organizationId, capabilityIds]);
    await client.query(`SELECT 1 FROM cp_publication_receipt WHERE organization_id=$1 AND capability_id=ANY($2::text[]) FOR UPDATE`, [input.organizationId, capabilityIds]);
    await client.query(`SELECT 1 FROM cp_publication_reconciliation WHERE organization_id=$1 AND capability_id=ANY($2::text[]) FOR UPDATE`, [input.organizationId, capabilityIds]);
  }
  const facts = await client.query(
    `SELECT capability.capability,begin.begun_at,receipt.receipt,
            reconciliation.reconciliation_id,reconciliation.observation,reconciliation.observed_at
     FROM cp_publication_capability capability
     LEFT JOIN cp_publication_begin begin ON begin.organization_id=capability.organization_id
       AND begin.capability_id=capability.capability_id
     LEFT JOIN cp_publication_receipt receipt ON receipt.organization_id=capability.organization_id
       AND receipt.capability_id=capability.capability_id
     LEFT JOIN LATERAL (
       SELECT candidate.reconciliation_id,candidate.observation,candidate.observed_at
       FROM cp_publication_reconciliation candidate
       WHERE candidate.organization_id=capability.organization_id
         AND candidate.capability_id=capability.capability_id
       ORDER BY candidate.sequence DESC LIMIT 1
     ) reconciliation ON true
     WHERE capability.organization_id=$1 AND capability.capability_id=ANY($2::text[])
     ORDER BY capability.attempt_number DESC`, [input.organizationId, capabilityIds],
  );
  const records = facts.rows.map((row: any): PublicationOperationRecord => ({
    capability: PublicationOperationCapabilityV1Schema.parse(row.capability),
    begunAt: row.begun_at ?? null,
    receipt: row.receipt ? PublicationOperationReceiptV1Schema.parse(row.receipt) : null,
    reconciliation: row.observation ? {
      reconciliationId: row.reconciliation_id,
      observation: PublicationOperationObservationV1Schema.parse(row.observation),
      observedAt: row.observed_at,
    } : null,
  }));
  return { records, state: reducePublicationOperation(records) };
}

type PublicationLifecycleIdentity = {
  run_id: string;
  attempt_id: string;
  attempt_number: number;
  runner_id: string;
};

type LockedPublicationLifecycle = {
  run: any;
  attempt: any;
  runner: any;
  intent: any;
};

type LockedPublicationRunAttemptRunner = Omit<LockedPublicationLifecycle, "intent">;

async function discoverPublicationLifecycle(client: any, input: {
  organizationId: string;
  intentId: string;
}): Promise<PublicationLifecycleIdentity | null> {
  const discovered = await client.query(
    `SELECT run_id,attempt_id,attempt_number,runner_id FROM cp_publication_intent
     WHERE organization_id=$1 AND intent_id=$2`, [input.organizationId, input.intentId],
  );
  return discovered.rows[0] ?? null;
}

async function lockPublicationRunAttemptRunner(client: any, input: {
  organizationId: string;
  intentId: string;
  identity: PublicationLifecycleIdentity;
  skipLockedRun?: boolean;
  testHooks?: PublicationPublisherTestHooks | undefined;
}): Promise<LockedPublicationRunAttemptRunner | null> {
  const identity = input.identity;
  const lockEvent = async (phase: "before" | "after", resource: PublicationLifecycleResource) => {
    await input.testHooks?.onLifecycleLock?.({ phase, resource,
      organizationId: input.organizationId, intentId: input.intentId, runId: identity.run_id });
  };
  await lockEvent("before", "run");
  const run = await client.query(
    `SELECT * FROM cp_hosted_run WHERE organization_id=$1 AND run_id=$2 FOR UPDATE${input.skipLockedRun ? " SKIP LOCKED" : ""}`,
    [input.organizationId, identity.run_id],
  );
  if (run.rowCount !== 1) return null;
  await lockEvent("after", "run");
  await lockEvent("before", "attempt");
  const attempt = await client.query(
    `SELECT * FROM cp_hosted_attempt
     WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3 AND attempt_number=$4 FOR UPDATE`,
    [input.organizationId, identity.run_id, identity.attempt_id, identity.attempt_number],
  );
  if (attempt.rowCount !== 1) return null;
  await lockEvent("after", "attempt");
  await lockEvent("before", "runner");
  const runner = await client.query(
    `SELECT * FROM cp_runner WHERE organization_id=$1 AND runner_id=$2 FOR UPDATE`,
    [input.organizationId, identity.runner_id],
  );
  if (runner.rowCount !== 1) return null;
  await lockEvent("after", "runner");
  return { run: run.rows[0], attempt: attempt.rows[0], runner: runner.rows[0] };
}

async function lockPublicationLifecycle(client: any, input: {
  organizationId: string;
  intentId: string;
  identity: PublicationLifecycleIdentity;
  skipLockedRun?: boolean;
  testHooks?: PublicationPublisherTestHooks | undefined;
}): Promise<LockedPublicationLifecycle | null> {
  const locked = await lockPublicationRunAttemptRunner(client, input);
  if (!locked) return null;
  const lockEvent = async (phase: "before" | "after", resource: PublicationLifecycleResource) => {
    await input.testHooks?.onLifecycleLock?.({ phase, resource,
      organizationId: input.organizationId, intentId: input.intentId, runId: input.identity.run_id });
  };
  await lockEvent("before", "intent");
  const intent = await client.query(
    `SELECT * FROM cp_publication_intent WHERE organization_id=$1 AND intent_id=$2 FOR UPDATE`,
    [input.organizationId, input.intentId],
  );
  if (intent.rowCount !== 1) return null;
  await lockEvent("after", "intent");
  const lockedIntent = intent.rows[0];
  if (lockedIntent.run_id !== input.identity.run_id || lockedIntent.attempt_id !== input.identity.attempt_id
    || lockedIntent.attempt_number !== input.identity.attempt_number
    || lockedIntent.runner_id !== input.identity.runner_id) {
    return null;
  }
  return { ...locked, intent: lockedIntent };
}

async function lockPublicationCandidateAndOwnership(client: any, input: {
  organizationId: string;
  lifecycle: LockedPublicationLifecycle;
}): Promise<{ candidate: any; ownership: any } | null> {
  const candidate = await client.query(
    `SELECT * FROM cp_publication_candidate
     WHERE organization_id=$1 AND candidate_id=$2 AND run_id=$3 AND attempt_id=$4 FOR UPDATE`,
    [input.organizationId, input.lifecycle.intent.candidate_id, input.lifecycle.intent.run_id,
      input.lifecycle.intent.attempt_id],
  );
  if (candidate.rowCount !== 1) return null;
  const ownership = await client.query(
    `SELECT * FROM cp_publication_branch_ownership
     WHERE organization_id=$1 AND ownership_id=$2 FOR UPDATE`,
    [input.organizationId, input.lifecycle.intent.ownership_id],
  );
  if (ownership.rowCount !== 1) return null;
  const candidateRow = candidate.rows[0];
  const ownershipRow = ownership.rows[0];
  if (candidateRow.attempt_number !== input.lifecycle.intent.attempt_number
    || digest(candidateRow.candidate) !== input.lifecycle.intent.candidate_digest
    || ownershipRow.run_id !== input.lifecycle.intent.run_id
    || ownershipRow.attempt_id !== input.lifecycle.intent.attempt_id
    || ownershipRow.attempt_number !== input.lifecycle.intent.attempt_number
    || ownershipRow.runner_id !== input.lifecycle.intent.runner_id
    || ownershipRow.runner_generation !== input.lifecycle.intent.runner_generation
    || ownershipRow.candidate_id !== input.lifecycle.intent.candidate_id
    || ownershipRow.candidate_digest !== input.lifecycle.intent.candidate_digest
    || ownershipRow.attestation_digest !== input.lifecycle.intent.ownership_digest) return null;
  return { candidate: candidateRow, ownership: ownershipRow };
}

async function readLockedPublicationOperationState(client: any, input: {
  organizationId: string; intentId: string; step: PublicationOperationStepV1;
  testHooks?: PublicationPublisherTestHooks | undefined;
}): Promise<{ records: PublicationOperationRecord[]; state: PublicationOperationState } | null> {
  // Identity discovery is non-locking. Every authority path then takes the
  // same Run -> exact Attempt -> Runner -> Intent -> Candidate -> Ownership
  // order before any operation capability or fact row.
  const identity = await discoverPublicationLifecycle(client, input);
  if (!identity) return null;
  const lifecycle = await lockPublicationLifecycle(client, { ...input, identity });
  if (!lifecycle) return null;
  if (!await lockPublicationCandidateAndOwnership(client, { organizationId: input.organizationId, lifecycle })) {
    return null;
  }
  return readPublicationOperationState(client, { ...input, lock: true });
}

async function canonicalSettledReceipt(record: PublicationOperationRecord): Promise<PublicationOperationReceiptV1> {
  if (record.receipt?.outcome === "succeeded") return record.receipt;
  if (!record.reconciliation || record.reconciliation.observation.kind !== "present") {
    throw new Error("publication_operation_not_settled");
  }
  const capability = record.capability;
  const seed = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
    receiptId: `reconciled_${capability.capabilityId}`, capabilityId: capability.capabilityId,
    operationId: capability.operationId, organizationId: capability.organizationId,
    runId: capability.runId, attemptId: capability.attemptId, candidateId: capability.candidateId,
    candidateDigest: capability.candidateDigest, step: capability.step, runnerId: capability.runnerId,
    runnerGeneration: capability.runnerGeneration, fencingTokenDigest: capability.fencingTokenDigest,
    observation: record.reconciliation.observation, outcome: "succeeded" as const,
    observedAt: new Date(record.reconciliation.observedAt).toISOString() };
  return PublicationOperationReceiptV1Schema.parse({ ...seed,
    receiptDigest: await computePublicationOperationReceiptDigestV1(seed) });
}

export type PublicationApprovalInput = {
  organizationId: string; runnerId: string; runId: string;
  ownershipId: string; ownershipDigest: string;
  candidateId: string; candidateDigest: string; approvalId: string; approverId: string;
  approvedAt: string; expiresAt: string;
};

export function createPublicationPublisher(input: { pool: Pool; clock: Clock;
  idFactory: IdFactory; capabilityTtlMs?: number;
  issuePublicationAuthorityInTransaction?: (client: PostgresTransactionClient, input: {
    principal: RuntimePrincipal;
    attestation: RunnerBranchOwnershipAttestationV1;
    ownershipId: string;
    ownershipDigest: string;
    createdAt: Date;
  }) => Promise<void>;
  testHooks?: PublicationPublisherTestHooks | undefined }) {
  const ttl = Math.min(input.capabilityTtlMs ?? 60_000, 5 * 60_000);
  return {
    async attestOwnership(command: { principal: RuntimePrincipal;
      attestation: RunnerBranchOwnershipAttestationV1 }): Promise<
        { kind: "recorded" | "replayed"; ownershipId: string; ownershipDigest: string }
        | { kind: "rejected"; reason: string }> {
      const attestation = RunnerBranchOwnershipAttestationV1Schema.parse(command.attestation);
      const now = input.clock.now();
      const ownershipDigest = await computeBranchOwnershipAttestationDigestV1(attestation);
      const fenceDigest = await computeMaterialActionFencingTokenDigestV1(attestation.fencingToken);
      if (Date.parse(attestation.attestedAt) > now.getTime()) {
        return { kind: "rejected", reason: "future_ownership_attestation" };
      }
      try {
        return await withPostgresTransaction(input.pool, async (client) => {
          const existing = await client.query<{ ownership_id: string; attestation_digest: string }>(
            `SELECT ownership_id,attestation_digest FROM cp_publication_branch_ownership
             WHERE organization_id=$1 AND candidate_id=$2 FOR UPDATE`,
            [command.principal.organizationId, attestation.candidateId]);
          if (existing.rows[0]) return existing.rows[0].attestation_digest === ownershipDigest
            ? { kind: "replayed" as const, ownershipId: existing.rows[0].ownership_id, ownershipDigest }
            : { kind: "rejected" as const, reason: "ownership_attestation_conflict" };
          const exact = await client.query<any>(
            `SELECT run.publication_mode,run.runner_id,run.current_attempt_number,run.terminal_kind,
               run.hosted_admission,run.admission_policy_snapshot,
               attempt.attempt_id,attempt.fencing_token_digest,attempt.state,
               attempt.workspace_attestation,runner.credential_generation,
               candidate.candidate,candidate.project_target_id,candidate.frozen_base_revision,
               candidate.workspace_tree_digest,target.binding_digest,target.provider,target.owner,
               target.repo,target.default_branch
             FROM cp_hosted_run run
             JOIN cp_hosted_attempt attempt ON attempt.organization_id=run.organization_id
               AND attempt.run_id=run.run_id AND attempt.attempt_number=run.current_attempt_number
             JOIN cp_runner runner ON runner.organization_id=run.organization_id AND runner.runner_id=run.runner_id
             JOIN cp_publication_candidate candidate ON candidate.organization_id=run.organization_id
               AND candidate.run_id=run.run_id AND candidate.attempt_id=attempt.attempt_id
             JOIN cp_project_target target ON target.organization_id=run.organization_id
               AND target.project_target_id=candidate.project_target_id
             WHERE run.organization_id=$1 AND run.run_id=$2 AND candidate.candidate_id=$3
             FOR UPDATE OF run,attempt,runner,candidate,target`,
            [command.principal.organizationId, attestation.runId, attestation.candidateId]);
          const row = exact.rows[0];
          const admission = row?.hosted_admission;
          const policy = row?.admission_policy_snapshot;
          const workspace = row?.workspace_attestation;
          const provider = String(row?.provider ?? "").toLowerCase();
          const owner = String(row?.owner ?? "").toLowerCase();
          const repo = String(row?.repo ?? "").toLowerCase();
          if (!row || row.publication_mode !== "pull_request" || row.terminal_kind !== null
            || row.runner_id !== command.principal.runnerId || attestation.runnerId !== command.principal.runnerId
            || row.current_attempt_number !== attestation.attemptNumber || row.attempt_id !== attestation.attemptId
            || row.fencing_token_digest !== fenceDigest || row.state !== "succeeded"
            || row.credential_generation !== attestation.runnerGeneration
            || command.principal.credentialGeneration !== attestation.runnerGeneration
            || digest(row.candidate) !== attestation.candidateDigest
            || row.project_target_id !== attestation.projectTargetId
            || row.binding_digest !== attestation.targetBindingDigest
            || row.frozen_base_revision !== attestation.frozenBaseRevision
            || row.workspace_tree_digest !== attestation.workspaceTreeDigest
            || workspace?.attemptId !== attestation.attemptId
            || workspace?.attemptNumber !== attestation.attemptNumber
            || workspace?.fencingTokenDigest !== fenceDigest
            || workspace?.baseRevision !== attestation.frozenBaseRevision
            || workspace?.currentTree !== attestation.workspaceTreeDigest
            || workspace?.currentRevision !== attestation.expectedHeadSha
            || admission?.projectTarget?.projectTargetId !== attestation.projectTargetId
            || admission?.projectTarget?.digest !== attestation.targetBindingDigest
            || String(admission?.repository?.provider ?? admission?.provider ?? "").toLowerCase() !== provider
            || String(admission?.repository?.owner ?? "").toLowerCase() !== owner
            || String(admission?.repository?.repo ?? "").toLowerCase() !== repo
            || policy?.payload?.target?.projectTargetId !== attestation.projectTargetId
            || policy?.payload?.target?.defaultBranch !== attestation.baseBranch
            || row.default_branch !== attestation.baseBranch
            || provider !== "github") {
            return { kind: "rejected" as const, reason: "exact_branch_ownership_authority_missing" };
          }
          if (attestation.branch.toLowerCase() === attestation.baseBranch.toLowerCase()) {
            return { kind: "rejected" as const, reason: "target_branch_write_prohibited" };
          }
          const ownershipId = input.idFactory("ownership");
          await client.query(
            `INSERT INTO cp_publication_branch_ownership(organization_id,ownership_id,run_id,
             attempt_id,attempt_number,fencing_token_digest,runner_id,runner_generation,candidate_id,
             candidate_digest,project_target_id,target_binding_digest,provider,owner,repo,remote,
             base_branch,frozen_base_revision,workspace_tree_digest,branch,expected_head_sha,
             attestation_digest,attested_at,created_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
            [command.principal.organizationId,ownershipId,attestation.runId,attestation.attemptId,
              attestation.attemptNumber,fenceDigest,command.principal.runnerId,attestation.runnerGeneration,
              attestation.candidateId,attestation.candidateDigest,attestation.projectTargetId,
              attestation.targetBindingDigest,provider,owner,repo,attestation.remote,attestation.baseBranch,
              attestation.frozenBaseRevision,attestation.workspaceTreeDigest,attestation.branch,
              attestation.expectedHeadSha,ownershipDigest,attestation.attestedAt,now]);
          await input.issuePublicationAuthorityInTransaction?.(client, {
            principal: command.principal, attestation, ownershipId, ownershipDigest,
            createdAt: now,
          });
          await client.query(
            `UPDATE cp_hosted_run SET projection_revision=projection_revision+1,updated_at=$3
             WHERE organization_id=$1 AND run_id=$2 AND terminal_kind IS NULL`,
            [command.principal.organizationId, attestation.runId, now],
          );
          return { kind: "recorded" as const, ownershipId, ownershipDigest };
        });
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          const existing = await input.pool.query<{ ownership_id: string; attestation_digest: string }>(
            `SELECT ownership_id,attestation_digest FROM cp_publication_branch_ownership
             WHERE organization_id=$1 AND candidate_id=$2`,
            [command.principal.organizationId,attestation.candidateId]);
          if (existing.rows[0]?.attestation_digest === ownershipDigest) {
            return { kind: "replayed", ownershipId: existing.rows[0].ownership_id, ownershipDigest };
          }
          return { kind: "rejected", reason: "branch_not_owned_by_run" };
        }
        throw error;
      }
    },

    async approve(command: PublicationApprovalInput): Promise<
      { kind: "approved"; intentId: string } | { kind: "replayed"; intentId: string }
      | { kind: "rejected"; reason: string }> {
      if (command.approverId === command.runnerId) {
        return { kind: "rejected", reason: "self_approval_prohibited" };
      }
      const now = input.clock.now();
      if (Date.parse(command.approvedAt) > now.getTime()
        || Date.parse(command.expiresAt) <= now.getTime()) {
        return { kind: "rejected", reason: "approval_expired" };
      }
      try {
        return await withPostgresTransaction(input.pool, async (client) => {
          const discovered = await client.query<any>(
            `SELECT ownership.run_id,ownership.attempt_id,ownership.attempt_number,
               ownership.runner_id,ownership.candidate_id,ownership.project_target_id
             FROM cp_publication_branch_ownership ownership
             WHERE ownership.organization_id=$1 AND ownership.ownership_id=$4
               AND ownership.run_id=$2 AND ownership.candidate_id=$3`,
            [command.organizationId, command.runId, command.candidateId, command.ownershipId]);
          const identity = discovered.rows[0] as PublicationLifecycleIdentity | undefined;
          if (!identity) return { kind: "rejected" as const, reason: "stale_publication_authority" };
          const locked = await lockPublicationRunAttemptRunner(client, {
            organizationId: command.organizationId, intentId: `pending:${command.candidateId}`,
            identity, testHooks: input.testHooks });
          if (!locked) return { kind: "rejected" as const, reason: "stale_publication_authority" };
          // Candidate/run first approvals are already serialized by the
          // canonical Run lock. `approval_id` is separately authoritative,
          // however: it can be presented for another candidate/run. Take one
          // transaction lock for that identity before looking for either
          // unique intent key, so a uniqueness violation is never used as a
          // control-flow or ownership decision.
          await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
            [`publication-approval:${command.organizationId}:${command.approvalId}`]);
          const existing = await client.query<any>(
            `SELECT * FROM cp_publication_intent
             WHERE organization_id=$1 AND (candidate_id=$2 OR approval_id=$3)
             ORDER BY intent_id FOR UPDATE`,
            [command.organizationId, command.candidateId, command.approvalId],
          );
          const candidateResult = await client.query(`SELECT * FROM cp_publication_candidate
            WHERE organization_id=$1 AND candidate_id=$2 AND run_id=$3 AND attempt_id=$4 FOR UPDATE`,
          [command.organizationId, command.candidateId, command.runId, identity.attempt_id]);
          const ownershipResult = await client.query(`SELECT * FROM cp_publication_branch_ownership
            WHERE organization_id=$1 AND ownership_id=$2 FOR UPDATE`,
          [command.organizationId, command.ownershipId]);
          const candidate = candidateResult.rows[0];
          const ownership = ownershipResult.rows[0];
          const targetResult = ownership ? await client.query(`SELECT * FROM cp_project_target
            WHERE organization_id=$1 AND project_target_id=$2 FOR UPDATE`,
          [command.organizationId, ownership.project_target_id]) : { rows: [] };
          const target = targetResult.rows[0];
          const row = candidate && ownership && target ? {
            publication_mode: locked.run.publication_mode, run_runner_id: locked.run.runner_id,
            current_attempt_number: locked.run.current_attempt_number, terminal_kind: locked.run.terminal_kind,
            current_attempt_id: locked.attempt.attempt_id,
            current_fencing_token_digest: locked.attempt.fencing_token_digest, state: locked.attempt.state,
            credential_generation: locked.runner.credential_generation, candidate: candidate.candidate,
            project_target_id: candidate.project_target_id, ownership_id: ownership.ownership_id,
            ownership_run_id: ownership.run_id, ownership_attempt_id: ownership.attempt_id,
            ownership_attempt_number: ownership.attempt_number,
            ownership_fencing_token_digest: ownership.fencing_token_digest,
            ownership_runner_id: ownership.runner_id, ownership_runner_generation: ownership.runner_generation,
            ownership_candidate_id: ownership.candidate_id, ownership_candidate_digest: ownership.candidate_digest,
            ownership_project_target_id: ownership.project_target_id,
            target_binding_digest: ownership.target_binding_digest, provider: ownership.provider,
            owner: ownership.owner, repo: ownership.repo, remote: ownership.remote,
            base_branch: ownership.base_branch, branch: ownership.branch,
            expected_head_sha: ownership.expected_head_sha, attestation_digest: ownership.attestation_digest,
            binding_digest: target.binding_digest, target_provider: target.provider,
            target_owner: target.owner, target_repo: target.repo, default_branch: target.default_branch,
          } : null;
          if (!row || row.publication_mode !== "pull_request") {
            return { kind: "rejected" as const, reason: "proposal_only_frozen" };
          }
          if (row.terminal_kind !== null || row.run_runner_id !== command.runnerId
            || row.current_attempt_number !== row.ownership_attempt_number
            || row.current_attempt_id !== row.ownership_attempt_id
            || row.state !== "succeeded" || row.credential_generation !== row.ownership_runner_generation
            || row.current_fencing_token_digest !== row.ownership_fencing_token_digest
            || row.attestation_digest !== command.ownershipDigest
            || row.ownership_id !== command.ownershipId || row.ownership_run_id !== command.runId
            || row.ownership_runner_id !== command.runnerId
            || row.ownership_candidate_id !== command.candidateId
            || row.ownership_candidate_digest !== command.candidateDigest
            || row.project_target_id !== row.ownership_project_target_id
            || row.binding_digest !== row.target_binding_digest
            || String(row.target_provider).toLowerCase() !== row.provider
            || String(row.target_owner).toLowerCase() !== row.owner
            || String(row.target_repo).toLowerCase() !== row.repo
            || row.default_branch !== row.base_branch) {
            return { kind: "rejected" as const, reason: "stale_publication_authority" };
          }
          if (digest(row.candidate) !== command.candidateDigest) {
            return { kind: "rejected" as const, reason: "candidate_digest_mismatch" };
          }
          const approvalDigest = digest({ organizationId: command.organizationId, runId: command.runId,
            candidateId: command.candidateId, candidateDigest: command.candidateDigest,
            ownershipId: command.ownershipId, ownershipDigest: command.ownershipDigest,
            approvalId: command.approvalId, approverId: command.approverId,
            approvedAt: command.approvedAt, expiresAt: command.expiresAt,
            attemptId: row.ownership_attempt_id, attemptNumber: row.ownership_attempt_number,
            fencingTokenDigest: row.ownership_fencing_token_digest, runnerId: row.ownership_runner_id,
            runnerGeneration: row.ownership_runner_generation });
          const intent = existing.rows[0];
          if (existing.rowCount !== 0) {
            const exactReplay = existing.rowCount === 1
              && intent.approval_digest === approvalDigest
              && intent.run_id === command.runId
              && intent.attempt_id === row.ownership_attempt_id
              && intent.attempt_number === row.ownership_attempt_number
              && intent.candidate_id === command.candidateId
              && intent.candidate_digest === command.candidateDigest
              && intent.ownership_id === command.ownershipId
              && intent.ownership_digest === command.ownershipDigest
              && intent.approval_id === command.approvalId
              && intent.approver_id === command.approverId
              && intent.runner_id === command.runnerId
              && intent.runner_generation === row.ownership_runner_generation;
            return exactReplay ? { kind: "replayed" as const, intentId: intent.intent_id }
              : { kind: "rejected" as const, reason: "approval_replay_conflict" };
          }
          const intentId = input.idFactory("intent");
          const repository = { provider: "github" as const, owner: row.owner, repo: row.repo,
            remote: row.remote, baseBranch: row.base_branch };
          await client.query(
            `INSERT INTO cp_publication_intent(organization_id,intent_id,run_id,
             attempt_id,attempt_number,candidate_id,candidate_digest,ownership_id,ownership_digest,
             approval_id,approver_id,approval_digest,repository,branch,expected_head_sha,runner_id,
             runner_generation,approved_at,expires_at,created_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
            [command.organizationId,intentId,command.runId,row.ownership_attempt_id,row.ownership_attempt_number,
              command.candidateId,command.candidateDigest,command.ownershipId,command.ownershipDigest,
              command.approvalId,command.approverId,approvalDigest,repository,row.branch,
              row.expected_head_sha,row.ownership_runner_id,row.ownership_runner_generation,command.approvedAt,
              command.expiresAt,now]);
          return { kind: "approved" as const, intentId };
        });
      } catch (error) {
        // The approval path does not write branch ownership. In particular,
        // the `approval_id` unique constraint is authority replay, never a
        // `branch_not_owned_by_run` result. With the advisory recheck above,
        // an unexpected uniqueness error is an infrastructure invariant
        // failure and must retain its actual database identity.
        throw error;
      }
    },

    // Runner polling is intentionally discovery-only: it never accepts a
    // caller-selected Candidate, operation, or branch.  The immutable intent
    // ledger is the sole dispatch queue and decides the one next operation.
    async claimNextForRunner(command: { principal: RuntimePrincipal }): Promise<
      { kind: "issued"; capability: PublicationOperationCapabilityV1 }
      | { kind: "completion_pending"; capability: PublicationOperationCapabilityV1;
          completionReceipt: PublicationOperationReceiptV1 }
      | { kind: "reconciliation_pending"; capability: PublicationOperationCapabilityV1 }
      | { kind: "empty" } | { kind: "blocked"; reason: string }
    > {
      return withPostgresTransaction(input.pool, async (client) => {
        const now = (await client.query<{ now: Date }>("SELECT CURRENT_TIMESTAMP AS now")).rows[0]!.now;
        // A persisted begin is an external-effect boundary.  Recovery below is
        // observation-only, so it deliberately does not reuse the issuance
        // gates (intent expiry, Run terminality, lease, or original generation).
        // The currently authenticated paired Runner must still be the same
        // Runner identity; a rotated credential generation is allowed solely
        // to observe this immutable original operation.
        const recovery = await client.query<{ intent_id: string; step: PublicationOperationStepV1 }>(
          `SELECT latest.intent_id,latest.step FROM (
             SELECT DISTINCT ON (capability.intent_id,capability.step)
               capability.organization_id,capability.intent_id,capability.step,
               begin.capability_id AS begun_capability_id,receipt.outcome,
               reconciliation.observation->>'kind' AS reconciliation_kind
             FROM cp_publication_capability capability
             LEFT JOIN cp_publication_begin begin ON begin.organization_id=capability.organization_id
               AND begin.capability_id=capability.capability_id
             LEFT JOIN cp_publication_receipt receipt ON receipt.organization_id=capability.organization_id
               AND receipt.capability_id=capability.capability_id
             LEFT JOIN LATERAL (
               SELECT candidate.observation,candidate.observed_at
               FROM cp_publication_reconciliation candidate
               WHERE candidate.organization_id=capability.organization_id
                 AND candidate.capability_id=capability.capability_id
               ORDER BY candidate.sequence DESC LIMIT 1
             ) reconciliation ON true
             WHERE capability.organization_id=$1
             ORDER BY capability.intent_id,capability.step,capability.attempt_number DESC
           ) latest
           JOIN cp_publication_intent intent ON intent.organization_id=latest.organization_id
             AND intent.intent_id=latest.intent_id
           JOIN cp_runner runner ON runner.organization_id=intent.organization_id
             AND runner.runner_id=intent.runner_id
           WHERE latest.begun_capability_id IS NOT NULL
             AND (latest.outcome IS NULL OR latest.outcome='outcome_unknown')
             AND (latest.reconciliation_kind IS NULL OR latest.reconciliation_kind='ambiguous')
             AND NOT EXISTS (
               SELECT 1 FROM cp_publication_capability settled_capability
               LEFT JOIN cp_publication_receipt settled_receipt
                 ON settled_receipt.organization_id=settled_capability.organization_id
                 AND settled_receipt.capability_id=settled_capability.capability_id
               LEFT JOIN cp_publication_reconciliation settled_reconciliation
                 ON settled_reconciliation.organization_id=settled_capability.organization_id
                 AND settled_reconciliation.capability_id=settled_capability.capability_id
               WHERE settled_capability.organization_id=latest.organization_id
                 AND settled_capability.intent_id=latest.intent_id
                 AND settled_capability.step=latest.step
                 AND (settled_receipt.outcome='succeeded'
                   OR settled_reconciliation.observation->>'kind'='present')
             )
             AND intent.runner_id=$2
             AND runner.credential_generation=$3
           ORDER BY intent.created_at,latest.intent_id,latest.step`,
          [command.principal.organizationId, command.principal.runnerId,
            command.principal.credentialGeneration],
        );
        for (const candidate of recovery.rows) {
          const identity = await discoverPublicationLifecycle(client, {
            organizationId: command.principal.organizationId, intentId: candidate.intent_id });
          const lifecycle = identity ? await lockPublicationLifecycle(client, {
            organizationId: command.principal.organizationId, intentId: candidate.intent_id,
            identity, skipLockedRun: true, testHooks: input.testHooks }) : null;
          if (!lifecycle || lifecycle.intent.runner_id !== command.principal.runnerId
            || lifecycle.runner.credential_generation !== command.principal.credentialGeneration) continue;
          if (!await lockPublicationCandidateAndOwnership(client, {
            organizationId: command.principal.organizationId, lifecycle })) continue;
          const operation = await readPublicationOperationState(client, {
            organizationId: command.principal.organizationId, intentId: candidate.intent_id,
            step: candidate.step, lock: true });
          if (operation.state.kind === "reconciliation_pending") return { kind: "reconciliation_pending" as const,
            capability: operation.state.record.capability };
        }
        const selected = await client.query<{ intent_id: string }>(
          `SELECT intent.intent_id
           FROM cp_publication_intent intent
           JOIN cp_hosted_run run ON run.organization_id = intent.organization_id AND run.run_id = intent.run_id
           JOIN cp_hosted_attempt attempt ON attempt.organization_id = intent.organization_id
             AND attempt.run_id = intent.run_id AND attempt.attempt_id = intent.attempt_id
             AND attempt.attempt_number = intent.attempt_number
           JOIN cp_runner runner ON runner.organization_id = intent.organization_id AND runner.runner_id = intent.runner_id
           WHERE intent.organization_id = $1 AND intent.runner_id = $2
             AND run.terminal_kind IS NULL AND run.publication_mode = 'pull_request'
             AND run.current_attempt_number = intent.attempt_number
             AND runner.credential_generation = intent.runner_generation
             AND runner.credential_generation = $3
             AND intent.expires_at > $4
             AND (attempt.state = 'succeeded' OR (attempt.state IN ('claimed','running') AND attempt.lease_expires_at > $4))
           ORDER BY intent.created_at ASC, intent.intent_id ASC
          `,
          [command.principal.organizationId, command.principal.runnerId,
            command.principal.credentialGeneration, now],
        );
        for (const selectedIntent of selected.rows) {
          const identity = await discoverPublicationLifecycle(client, {
            organizationId: command.principal.organizationId, intentId: selectedIntent.intent_id });
          const lifecycle = identity ? await lockPublicationLifecycle(client, {
            organizationId: command.principal.organizationId, intentId: selectedIntent.intent_id,
            identity, skipLockedRun: true, testHooks: input.testHooks }) : null;
          if (!lifecycle) continue;
          const evidence = await lockPublicationCandidateAndOwnership(client, {
            organizationId: command.principal.organizationId, lifecycle });
          if (!evidence || lifecycle.run.terminal_kind !== null
            || lifecycle.run.publication_mode !== "pull_request"
            || lifecycle.run.current_attempt_number !== lifecycle.intent.attempt_number
            || lifecycle.intent.runner_id !== command.principal.runnerId
            || lifecycle.runner.credential_generation !== lifecycle.intent.runner_generation
            || lifecycle.runner.credential_generation !== command.principal.credentialGeneration
            || lifecycle.intent.expires_at <= now
            || !(lifecycle.attempt.state === "succeeded"
              || (["claimed", "running"].includes(lifecycle.attempt.state)
                && lifecycle.attempt.lease_expires_at > now))) continue;
          const row = lifecycle.intent;
          const operation = (step: PublicationOperationStepV1) => readPublicationOperationState(client,
            { organizationId: command.principal.organizationId, intentId: row.intent_id, step, lock: true });
          const push = await operation("push_owned_branch");
        let step: PublicationOperationStepV1;
        if (push.state.kind === "issuable" && !push.state.latest) {
          step = "push_owned_branch";
        } else if (push.state.kind === "settled") {
          const pullRequest = await operation("create_draft_pull_request");
          if (!pullRequest) return { kind: "empty" as const };
          if (pullRequest.state.kind === "settled") {
            return { kind: "completion_pending" as const,
              capability: pullRequest.state.record.capability,
              completionReceipt: await canonicalSettledReceipt(pullRequest.state.record) };
          }
          if (pullRequest.state.kind === "reconciliation_pending") {
            return { kind: "reconciliation_pending" as const, capability: pullRequest.state.record.capability };
          }
          if (pullRequest.state.kind === "issuable" && pullRequest.state.latest) {
            if (pullRequest.state.latest.begunAt !== null
              || Date.parse(pullRequest.state.latest.capability.expiresAt) > now.getTime()) {
              return { kind: "blocked" as const, reason: "capability_nonrenewable" };
            }
          }
          step = "create_draft_pull_request";
        } else {
          if (push.state.kind === "reconciliation_pending") {
            return { kind: "reconciliation_pending" as const, capability: push.state.record.capability };
          }
          if (push.state.kind === "issuable" && push.state.latest) {
            if (push.state.latest.begunAt !== null
              || Date.parse(push.state.latest.capability.expiresAt) > now.getTime()) {
              return { kind: "blocked" as const, reason: "capability_nonrenewable" };
            }
          }
          step = "push_owned_branch";
        }
        const capability = PublicationOperationCapabilityV1Schema.parse({
          schemaVersion: 1, protocolVersion: "1.0", capabilityId: input.idFactory("capability"),
          organizationId: command.principal.organizationId, runId: row.run_id,
          attemptId: row.attempt_id, attemptNumber: row.attempt_number, epoch: row.attempt_number,
          fencingTokenDigest: lifecycle.attempt.fencing_token_digest, candidateId: row.candidate_id,
          candidateDigest: row.candidate_digest, approvalId: row.approval_id, approverId: row.approver_id,
          repository: row.repository, branch: row.branch, expectedHeadSha: row.expected_head_sha,
          step, operationId: `${row.intent_id}:${step}`, idempotencyKey: `${row.intent_id}:${step}`,
          runnerId: command.principal.runnerId, runnerGeneration: row.runner_generation,
          issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl).toISOString(),
        });
        const capabilityAttemptNumber = (await client.query<{ next_attempt_number: number }>(
          `SELECT COALESCE(MAX(attempt_number),0)+1 AS next_attempt_number
           FROM cp_publication_capability WHERE organization_id=$1 AND intent_id=$2 AND step=$3`,
          [command.principal.organizationId,row.intent_id,step])).rows[0]!.next_attempt_number;
        await client.query(
          `INSERT INTO cp_publication_capability(organization_id,capability_id,intent_id,operation_id,
             idempotency_key,step,attempt_number,capability_digest,capability,issued_at,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [command.principal.organizationId, capability.capabilityId, row.intent_id,
            capability.operationId, capability.idempotencyKey, capability.step, capabilityAttemptNumber,
            await computePublicationCapabilityDigestV1(capability), capability,
            capability.issuedAt, capability.expiresAt],
        );
        return { kind: "issued" as const, capability };
        }
        return { kind: "empty" as const };
      });
    },

    async begin(command: { principal: RuntimePrincipal; fencingToken: string;
      capability: PublicationOperationCapabilityV1; begunAt: string }) {
      const parsed = PublicationOperationCapabilityV1Schema.parse(command.capability);
      const fence = await computeMaterialActionFencingTokenDigestV1(command.fencingToken);
      if (fence !== parsed.fencingTokenDigest || parsed.runnerId !== command.principal.runnerId
        || parsed.organizationId !== command.principal.organizationId) return { kind: "stale_fence" as const };
      try {
        return await withPostgresTransaction(input.pool, async (client) => {
          const discovered = await client.query<{ intent_id: string }>(
            `SELECT intent_id FROM cp_publication_capability
             WHERE organization_id=$1 AND capability_id=$2 AND operation_id=$3`,
            [parsed.organizationId, parsed.capabilityId, parsed.operationId],
          );
          const operation = discovered.rows[0]
            ? await readLockedPublicationOperationState(client, { organizationId: parsed.organizationId,
              intentId: discovered.rows[0].intent_id, step: parsed.step, testHooks: input.testHooks })
            : null;
          const exact = operation?.records.find((record) => record.capability.capabilityId === parsed.capabilityId);
          if (!exact || canonicalJsonStringify(exact.capability) !== canonicalJsonStringify(parsed)) {
            return { kind: "stale_fence" as const };
          }
          const result = await client.query(
          `INSERT INTO cp_publication_begin(organization_id,capability_id,operation_id,begun_at)
           SELECT capability.organization_id, capability.capability_id, capability.operation_id, CURRENT_TIMESTAMP
           FROM cp_publication_capability capability
           JOIN cp_publication_intent intent
             ON intent.organization_id = capability.organization_id
            AND intent.intent_id = capability.intent_id
           JOIN cp_hosted_run run
             ON run.organization_id = intent.organization_id AND run.run_id = intent.run_id
           JOIN cp_hosted_attempt attempt
             ON attempt.organization_id = intent.organization_id
            AND attempt.run_id = intent.run_id AND attempt.attempt_id = intent.attempt_id
            AND attempt.attempt_number = intent.attempt_number
           JOIN cp_runner runner
             ON runner.organization_id = intent.organization_id AND runner.runner_id = intent.runner_id
           WHERE capability.organization_id=$1 AND capability.capability_id=$2
             AND capability.capability_digest=$3 AND capability.expires_at > CURRENT_TIMESTAMP
             AND run.terminal_kind IS NULL AND run.current_attempt_number = intent.attempt_number
             AND (attempt.state = 'succeeded' OR (
               attempt.state IN ('claimed','running')
               AND attempt.lease_expires_at > CURRENT_TIMESTAMP))
             AND runner.credential_generation = intent.runner_generation`,
          [parsed.organizationId, parsed.capabilityId, await computePublicationCapabilityDigestV1(parsed)]);
          if (result.rowCount !== 1) return { kind: "stale_fence" as const };
          return { kind: "begun" as const };
        });
      } catch (error) {
        if ((error as { code?: string }).code === "23505") return { kind: "replayed" as const };
        throw error;
      }
    },

    async record(command: { principal: RuntimePrincipal; receipt: PublicationOperationReceiptV1 }) {
      const receipt = PublicationOperationReceiptV1Schema.parse(command.receipt);
      if (receipt.organizationId !== command.principal.organizationId
        || receipt.runnerId !== command.principal.runnerId) return { kind: "conflict" as const };
      const { receiptDigest: _digest, ...digestInput } = receipt;
      if (await computePublicationOperationReceiptDigestV1(digestInput) !== receipt.receiptDigest) {
        return { kind: "conflict" as const };
      }
      return withPostgresTransaction(input.pool, async (client) => {
      const issued = await client.query<{ intent_id: string; capability: unknown }>(
        `SELECT intent_id,capability FROM cp_publication_capability
         WHERE organization_id = $1 AND capability_id = $2 AND operation_id = $3`,
        [receipt.organizationId, receipt.capabilityId, receipt.operationId],
      );
      const capability = issued.rows[0]
        ? PublicationOperationCapabilityV1Schema.parse(issued.rows[0].capability)
        : null;
      if (!capability
        || capability.runId !== receipt.runId || capability.attemptId !== receipt.attemptId
        || capability.candidateId !== receipt.candidateId
        || capability.candidateDigest !== receipt.candidateDigest
        || capability.step !== receipt.step || capability.runnerId !== receipt.runnerId
        || capability.runnerGeneration !== receipt.runnerGeneration
        || capability.fencingTokenDigest !== receipt.fencingTokenDigest) {
        return { kind: "conflict" as const };
      }
      if (!exactReceiptObservation(capability, receipt.observation)) return { kind: "conflict" as const };
      // Lock every capability/fact row for this immutable operation before
      // deciding the winner or appending a receipt.  `claim`, `record`, and
      // `reconcile` therefore serialize on the same capability ledger.
      const operation = await readLockedPublicationOperationState(client, { organizationId: receipt.organizationId,
        intentId: issued.rows[0]!.intent_id, step: capability.step, testHooks: input.testHooks });
      if (!operation) return { kind: "conflict" as const };
      const exactRecord = operation.records.find((record) => record.capability.capabilityId === capability.capabilityId);
      const existing = exactRecord?.receipt;
      if (existing) return existing.receiptDigest === receipt.receiptDigest
        ? { kind: "replayed" as const, receipt: existing } : { kind: "conflict" as const };
      // A reconciliation is one immutable provider observation for this
      // capability.  Once absence won the serialized operation, a late receipt
      // cannot append contradictory history; it must reconcile the successor.
      const reconciliation = await client.query(
        `SELECT 1 FROM cp_publication_reconciliation
         WHERE organization_id=$1 AND capability_id=$2 FOR UPDATE`,
        [receipt.organizationId, receipt.capabilityId],
      );
      if (exactRecord?.reconciliation || reconciliation.rowCount !== 0) return { kind: "conflict" as const };
      // Once a later attempt has durably observed absence, an older receipt
      // cannot be appended behind it.  It would create two incompatible facts
      // for one operation; only the authorized successor may settle next.
      if (operation.state.kind === "settled" || operation.state.kind === "retryable") {
        return { kind: "conflict" as const };
      }
      const result = await client.query(
          `INSERT INTO cp_publication_receipt(organization_id,receipt_id,capability_id,
           operation_id,outcome,receipt_digest,receipt,observed_at)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8 FROM cp_publication_begin begin
           WHERE begin.organization_id=$1 AND begin.capability_id=$3
             AND begin.operation_id=$4
           ON CONFLICT DO NOTHING RETURNING receipt_id`,
          [receipt.organizationId, receipt.receiptId, receipt.capabilityId,
            receipt.operationId, receipt.outcome, receipt.receiptDigest, receipt,
            receipt.observedAt]);
      if (result.rowCount === 1) return { kind: "recorded" as const, receipt };
      const storedReceipt = await client.query<{ receipt_digest: string; receipt: unknown }>(
        `SELECT receipt_digest,receipt FROM cp_publication_receipt
         WHERE organization_id=$1 AND capability_id=$2`,
        [receipt.organizationId, receipt.capabilityId]);
      return storedReceipt.rows[0]?.receipt_digest === receipt.receiptDigest
        ? { kind: "replayed" as const,
            receipt: PublicationOperationReceiptV1Schema.parse(storedReceipt.rows[0]!.receipt) }
        : { kind: "conflict" as const };
      });
    },

    async reconcile(command: { principal: RuntimePrincipal; capabilityId: string;
      operationId: string; reconciliationId: string; observation: unknown; observedAt: string }) {
      const observation = PublicationOperationObservationV1Schema.parse(command.observation);
      return withPostgresTransaction(input.pool, async (client) => {
        const capability = await client.query<{ intent_id: string; capability: unknown }>(
          `SELECT intent_id,capability FROM cp_publication_capability
           WHERE organization_id=$1 AND capability_id=$2 AND operation_id=$3`,
          [command.principal.organizationId, command.capabilityId, command.operationId]);
        const exact = capability.rows[0]
          ? PublicationOperationCapabilityV1Schema.parse(capability.rows[0].capability) : null;
        if (!exact || exact.runnerId !== command.principal.runnerId
          || !exactReceiptObservation(exact, observation)) return { kind: "conflict" as const };
        const operation = await readLockedPublicationOperationState(client, { organizationId: command.principal.organizationId,
          intentId: capability.rows[0]!.intent_id, step: exact.step, testHooks: input.testHooks });
        if (!operation) return { kind: "conflict" as const };
        const record = operation.records.find((candidate) => candidate.capability.capabilityId === exact.capabilityId);
        if (!record || record.begunAt === null) return { kind: "conflict" as const };
        const resultFor = (value: PublicationOperationReceiptV1["observation"]) => value.kind === "present"
          ? { kind: "settled" as const } : value.kind === "absent"
            ? { kind: "retry_authorized" as const } : { kind: "outcome_unknown" as const };
        if (record.reconciliation) {
          if (record.reconciliation.reconciliationId === command.reconciliationId
            && canonicalJsonStringify(record.reconciliation.observation)
              === canonicalJsonStringify(observation)) {
            return resultFor(record.reconciliation.observation);
          }
          if (record.reconciliation.observation.kind !== "ambiguous") {
            return resultFor(record.reconciliation.observation);
          }
        }
        // A settled receipt/presence is stronger than any later absence or
        // ambiguity.  Do not insert contradictory history, and do not rewrite
        // an original unknown receipt when exact presence settles it.
        if (operation.state.kind === "settled") return { kind: "conflict" as const };
        const sequence = (await client.query<{ next_sequence: number }>(
          `SELECT COALESCE(MAX(sequence),0)+1 AS next_sequence
           FROM cp_publication_reconciliation
           WHERE organization_id=$1 AND capability_id=$2`,
          [command.principal.organizationId, command.capabilityId])).rows[0]!.next_sequence;
        await client.query(
          `INSERT INTO cp_publication_reconciliation(organization_id,reconciliation_id,
           capability_id,operation_id,sequence,observation,observed_at)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [command.principal.organizationId, command.reconciliationId, command.capabilityId,
            command.operationId, sequence, observation, command.observedAt]);
        return resultFor(observation);
      });
    },

    /**
     * Settle the Run only after both separately journaled publication effects
     * and an exact-head, frozen-policy readiness observation agree.  This is
     * deliberately coordinator-owned: a Runner can report facts but cannot
     * turn its own proposal into terminal success.
     */
    async complete(command: { principal: RuntimePrincipal; completion: unknown }) {
      const completion = RunnerPublicationCompletionV1Schema.parse(command.completion);
      if (completion.organizationId !== command.principal.organizationId
        || completion.runnerId !== command.principal.runnerId) {
        return { kind: "stale_fence" as const };
      }
      const now = input.clock.now();
      const fenceDigest = await computeMaterialActionFencingTokenDigestV1(completion.fencingToken);
      return withPostgresTransaction(input.pool, async (client) => {
        const discovered = await client.query<{ intent_id: string }>(
          `SELECT intent_id FROM cp_publication_intent
           WHERE organization_id=$1 AND run_id=$2 AND candidate_id=$3`,
          [completion.organizationId, completion.runId, completion.candidateId]);
        const intentId = discovered.rows[0]?.intent_id;
        const identity = intentId ? await discoverPublicationLifecycle(client, {
          organizationId: completion.organizationId, intentId }) : null;
        const lifecycle = identity ? await lockPublicationLifecycle(client, {
          organizationId: completion.organizationId, intentId: intentId!, identity,
          testHooks: input.testHooks }) : null;
        const evidence = lifecycle ? await lockPublicationCandidateAndOwnership(client, {
          organizationId: completion.organizationId, lifecycle }) : null;
        if (!lifecycle || !evidence) return { kind: "stale_fence" as const };
        const row = {
          ...lifecycle.run,
          attempt_id: lifecycle.attempt.attempt_id,
          attempt_number: lifecycle.attempt.attempt_number,
          attempt_state: lifecycle.attempt.state,
          fencing_token_digest: lifecycle.attempt.fencing_token_digest,
          candidate_id: evidence.candidate.candidate_id,
          candidate: evidence.candidate.candidate,
          intent_id: lifecycle.intent.intent_id,
          intent_candidate_digest: lifecycle.intent.candidate_digest,
          intent_repository: lifecycle.intent.repository,
          intent_branch: lifecycle.intent.branch,
          expected_head_sha: lifecycle.intent.expected_head_sha,
          runner_generation: lifecycle.intent.runner_generation,
          ownership_id: evidence.ownership.ownership_id,
          ownership_provider: evidence.ownership.provider,
          ownership_owner: evidence.ownership.owner,
          ownership_repo: evidence.ownership.repo,
          ownership_remote: evidence.ownership.remote,
          ownership_base_branch: evidence.ownership.base_branch,
          ownership_branch: evidence.ownership.branch,
          ownership_head: evidence.ownership.expected_head_sha,
        };

        const already = await client.query<{ completion_decision: unknown }>(
          `SELECT completion_decision FROM cp_publication_completion
           WHERE organization_id = $1 AND run_id = $2`, [completion.organizationId, completion.runId]);
        if (already.rows[0]) {
          const decision = already.rows[0].completion_decision as { candidateDigest?: string; evidenceDigest?: string };
          const evidenceDigest = digest(completion.observation);
          return decision.candidateDigest === completion.candidateDigest
            && decision.evidenceDigest === evidenceDigest
            ? { kind: "replayed" as const }
            : { kind: "conflict" as const, reason: "completion_replay_mismatch" };
        }

        if (row.publication_mode !== "pull_request" || row.completion_mode !== "pull_request_ready"
          || row.terminal_kind !== null || row.current_attempt_number !== completion.attemptNumber
          || row.attempt_id !== completion.attemptId || row.attempt_state !== "succeeded"
          || row.fencing_token_digest !== fenceDigest || row.runner_id !== command.principal.runnerId
          || row.runner_generation !== completion.runnerGeneration
          || row.candidate_id !== completion.candidateId
          || digest(row.candidate) !== completion.candidateDigest
          || row.intent_candidate_digest !== completion.candidateDigest
          || canonicalJsonStringify(row.intent_repository) !== canonicalJsonStringify({
            provider: "github", ...completion.observation.repository, remote: completion.observation.remote,
            baseBranch: completion.observation.baseBranch,
          })
          || row.intent_branch !== completion.observation.branch
          || completion.observation.headBranch !== row.intent_branch
          || completion.observation.headRepository.owner.toLowerCase() !== row.intent_repository.owner.toLowerCase()
          || completion.observation.headRepository.repo.toLowerCase() !== row.intent_repository.repo.toLowerCase()
          || row.expected_head_sha !== completion.observation.headSha
          || canonicalJsonStringify({ provider: row.ownership_provider, owner: row.ownership_owner,
            repo: row.ownership_repo, remote: row.ownership_remote,
            baseBranch: row.ownership_base_branch }) !== canonicalJsonStringify(row.intent_repository)
          || row.ownership_branch !== row.intent_branch || row.ownership_head !== row.expected_head_sha) {
          return { kind: "stale_fence" as const };
        }

        const policy = AdmissionPolicySnapshotReceiptEnvelopeV1Schema.parse(row.admission_policy_snapshot);
        const requiredChecks = policy.payload.admissionRules.requiredCheckNames;
        const pushOperation = await readPublicationOperationState(client, { organizationId: completion.organizationId,
          intentId: row.intent_id, step: "push_owned_branch", lock: true });
        const pullRequestOperation = await readPublicationOperationState(client, { organizationId: completion.organizationId,
          intentId: row.intent_id, step: "create_draft_pull_request", lock: true });
        if (pushOperation.state.kind === "reconciliation_pending"
          || pullRequestOperation.state.kind === "reconciliation_pending") {
          return { kind: "outcome_unknown" as const, reason: "publication_outcome_unknown" };
        }
        if (pushOperation.state.kind !== "settled" || pullRequestOperation.state.kind !== "settled") {
          return { kind: "nonterminal" as const, reason: "publication_receipt_missing" };
        }
        const push = pushOperation.state.record;
        const pullRequest = pullRequestOperation.state.record;
        const pushReceipt = await canonicalSettledReceipt(push);
        const pullRequestReceipt = await canonicalSettledReceipt(pullRequest);
        if (!exactReceiptObservation(push.capability, pushReceipt.observation)
          || !exactReceiptObservation(pullRequest.capability, pullRequestReceipt.observation)) {
          return { kind: "nonterminal" as const, reason: "publication_receipt_mismatch" };
        }
        if (pullRequestReceipt.observation.kind !== "present"
          || !pullRequestReceipt.observation.externalId || !pullRequestReceipt.observation.externalUri
          || pullRequestReceipt.observation.draft !== true
          || pullRequestReceipt.observation.headSha !== completion.observation.headSha
          || pullRequestReceipt.observation.externalUri !== completion.observation.pullRequestUrl
          || pullRequestReceipt.observation.externalId !== `github_pr_${completion.observation.pullRequestNumber}`) {
          return { kind: "nonterminal" as const, reason: "pull_request_receipt_mismatch" };
        }
        const readiness = assessExactPullRequestReadiness({
          snapshot: {
            provider: "github", deliveryId: `runner:${completion.requestId}`,
            eventName: "pull_request", repository: completion.observation.repository,
            pullRequest: { number: completion.observation.pullRequestNumber,
              resourceRef: completion.observation.pullRequestResourceRef,
              headSha: completion.observation.headSha, baseSha: completion.observation.baseSha,
              baseBranch: completion.observation.baseBranch, state: completion.observation.state },
            checks: completion.observation.checks, checksComplete: completion.observation.checksComplete,
            observedAt: completion.observation.observedAt, payloadDigest: digest(completion.observation),
          },
          expectedRepository: { owner: row.intent_repository.owner, repo: row.intent_repository.repo },
          expectedHeadSha: row.expected_head_sha, expectedBaseBranch: row.intent_repository.baseBranch,
          requiredChecks,
        });
        if (!readiness.ready) return { kind: "nonterminal" as const, reason: readiness.reasonCodes.join(",") };
        const evidenceDigest = digest(completion.observation);
        const decision = { kind: "ready_for_review", candidateDigest: completion.candidateDigest,
          evidenceDigest, reasonCodes: readiness.reasonCodes, assessedAt: now.toISOString() };
        await client.query(
          `INSERT INTO cp_publication_completion(organization_id,completion_id,run_id,attempt_id,
             attempt_number,fencing_token_digest,candidate_id,candidate_digest,intent_id,ownership_id,
             push_operation_id,push_receipt_digest,pull_request_operation_id,pull_request_receipt_digest,
             pull_request_external_id,pull_request_external_digest,repository,remote,base_branch,branch,
             expected_head_sha,observed_head_sha,required_check_names,evidence_digest,completion_decision,
             observation,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26::jsonb,$27)`,
          [completion.organizationId, input.idFactory("completion"), completion.runId, completion.attemptId,
            completion.attemptNumber, fenceDigest, completion.candidateId, completion.candidateDigest,
            row.intent_id, row.ownership_id, push.capability.operationId, pushReceipt.receiptDigest,
            pullRequest.capability.operationId, pullRequestReceipt.receiptDigest, pullRequestReceipt.observation.externalId,
            digest({ externalId: pullRequestReceipt.observation.externalId, externalUri: pullRequestReceipt.observation.externalUri }),
            row.intent_repository, completion.observation.remote, completion.observation.baseBranch,
            completion.observation.branch, row.expected_head_sha, completion.observation.headSha,
            requiredChecks, evidenceDigest, JSON.stringify(decision), JSON.stringify(completion.observation), now],
        );
        await client.query(
          `UPDATE cp_hosted_run SET state = 'succeeded', terminal_kind = 'succeeded',
             terminal_receipt = $3::jsonb, updated_at = $4
           WHERE organization_id = $1 AND run_id = $2 AND terminal_kind IS NULL`,
          [completion.organizationId, completion.runId,
            JSON.stringify({ kind: "ready_for_review", completionId: completion.requestId,
              candidateId: completion.candidateId, decision }), now],
        );
        return { kind: "ready" as const, projection: "ready_for_review" as const };
      });
    },
  };
}

export type PublicationPublisher = ReturnType<typeof createPublicationPublisher>;
