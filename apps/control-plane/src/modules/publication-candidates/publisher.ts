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
import { withPostgresTransaction } from "../../database/postgres.js";
import type { RuntimePrincipal } from "../runners/index.js";

type Clock = { now(): Date };
type IdFactory = (kind: "intent" | "ownership" | "capability" | "operation" | "completion") => string;

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
    && observation.baseBranch === capability.repository.baseBranch && observation.state === "open");
}

export type PublicationApprovalInput = {
  organizationId: string; runnerId: string; runId: string;
  ownershipId: string; ownershipDigest: string;
  candidateId: string; candidateDigest: string; approvalId: string; approverId: string;
  approvedAt: string; expiresAt: string;
};

export function createPublicationPublisher(input: { pool: Pool; clock: Clock;
  idFactory: IdFactory; capabilityTtlMs?: number }) {
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
            || String(admission?.provider ?? "").toLowerCase() !== provider
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
          const exact = await client.query<any>(
            `SELECT run.publication_mode,run.runner_id AS run_runner_id,
               run.current_attempt_number,run.terminal_kind,
               attempt.attempt_id AS current_attempt_id,
               attempt.fencing_token_digest AS current_fencing_token_digest,attempt.state,
               runner.credential_generation,candidate.candidate,candidate.project_target_id,
               ownership.ownership_id,ownership.run_id AS ownership_run_id,
               ownership.attempt_id AS ownership_attempt_id,
               ownership.attempt_number AS ownership_attempt_number,
               ownership.fencing_token_digest AS ownership_fencing_token_digest,
               ownership.runner_id AS ownership_runner_id,
               ownership.runner_generation AS ownership_runner_generation,
               ownership.candidate_id AS ownership_candidate_id,
               ownership.candidate_digest AS ownership_candidate_digest,
               ownership.project_target_id AS ownership_project_target_id,
               ownership.target_binding_digest,ownership.provider,ownership.owner,ownership.repo,
               ownership.remote,ownership.base_branch,ownership.branch,ownership.expected_head_sha,
               ownership.attestation_digest,target.binding_digest,target.provider AS target_provider,
               target.owner AS target_owner,target.repo AS target_repo,target.default_branch
             FROM cp_hosted_run run
             JOIN cp_hosted_attempt attempt ON attempt.organization_id = run.organization_id
              AND attempt.run_id = run.run_id AND attempt.attempt_number = run.current_attempt_number
             JOIN cp_runner runner ON runner.organization_id = run.organization_id
              AND runner.runner_id = run.runner_id
             JOIN cp_publication_candidate candidate ON candidate.organization_id = run.organization_id
              AND candidate.run_id = run.run_id AND candidate.attempt_id = attempt.attempt_id
             JOIN cp_publication_branch_ownership ownership ON ownership.organization_id=run.organization_id
               AND ownership.ownership_id=$4 AND ownership.candidate_id=candidate.candidate_id
             JOIN cp_project_target target ON target.organization_id=run.organization_id
               AND target.project_target_id=ownership.project_target_id
             WHERE run.organization_id=$1 AND run.run_id=$2 AND candidate.candidate_id=$3
             FOR UPDATE OF run,attempt,runner,candidate,ownership,target`,
            [command.organizationId, command.runId, command.candidateId, command.ownershipId]);
          const row = exact.rows[0];
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
          const existing = await client.query<{ intent_id: string; approval_digest: string }>(
            `SELECT intent_id,approval_digest FROM cp_publication_intent
             WHERE organization_id=$1 AND (candidate_id=$2 OR approval_id=$3) FOR UPDATE`,
            [command.organizationId,command.candidateId,command.approvalId]);
          if (existing.rows[0]) return existing.rows[0].approval_digest === approvalDigest
            ? { kind: "replayed" as const, intentId: existing.rows[0].intent_id }
            : { kind: "rejected" as const, reason: "approval_replay_conflict" };
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
        if ((error as { code?: string }).code === "23505") {
          return { kind: "rejected", reason: "branch_not_owned_by_run" };
        }
        throw error;
      }
    },

    async claim(command: { principal: RuntimePrincipal; runId: string; attemptId: string;
      attemptNumber: number; fencingToken: string; candidateId: string;
      candidateDigest: string; runnerGeneration: number; step: PublicationOperationStepV1 }):
      Promise<{ kind: "issued"; capability: PublicationOperationCapabilityV1 }
        | { kind: "unavailable"; reason: string }> {
      const fenceDigest = await computeMaterialActionFencingTokenDigestV1(command.fencingToken);
      return withPostgresTransaction(input.pool, async (client) => {
        const now = (await client.query<{ now: Date }>("SELECT CURRENT_TIMESTAMP AS now")).rows[0]!.now;
        const result = await client.query<any>(
          `SELECT intent.*, run.publication_mode, run.terminal_kind,
             run.current_attempt_number, attempt.fencing_token_digest,
             attempt.lease_expires_at, attempt.state,
             runner.credential_generation
           FROM cp_publication_intent intent
           JOIN cp_hosted_run run ON run.organization_id = intent.organization_id
             AND run.run_id = intent.run_id
           JOIN cp_hosted_attempt attempt ON attempt.organization_id = intent.organization_id
             AND attempt.run_id = intent.run_id AND attempt.attempt_id = intent.attempt_id
           JOIN cp_runner runner ON runner.organization_id = intent.organization_id
             AND runner.runner_id = intent.runner_id
           WHERE intent.organization_id = $1 AND intent.run_id = $2
             AND intent.candidate_id = $3 FOR UPDATE OF intent, run, attempt, runner`,
          [command.principal.organizationId, command.runId, command.candidateId]);
        const row = result.rows[0];
        if (!row || row.publication_mode !== "pull_request" || row.terminal_kind !== null
          || row.attempt_id !== command.attemptId || row.attempt_number !== command.attemptNumber
          || row.current_attempt_number !== command.attemptNumber
          || row.candidate_digest !== command.candidateDigest
          || row.fencing_token_digest !== fenceDigest || row.lease_expires_at <= now
          || row.expires_at <= now || row.runner_id !== command.principal.runnerId
          || row.runner_generation !== command.runnerGeneration
          || row.credential_generation !== command.runnerGeneration) {
          return { kind: "unavailable" as const, reason: "exact_publication_authority_missing" };
        }
        if (command.step === "create_draft_pull_request") {
          const pushed = await client.query(
            `SELECT 1 FROM cp_publication_receipt receipt
             JOIN cp_publication_capability capability
               ON capability.organization_id = receipt.organization_id
              AND capability.capability_id = receipt.capability_id
             WHERE capability.organization_id = $1 AND capability.intent_id = $2
               AND capability.step = 'push_owned_branch' AND receipt.outcome = 'succeeded'`,
            [command.principal.organizationId, row.intent_id]);
          if (pushed.rows.length === 0) return { kind: "unavailable" as const,
            reason: "owned_branch_not_pushed" };
        }
        const prior = await client.query<{ begun_at: Date | null; outcome: string | null; observation: unknown }>(
          `SELECT begin.begun_at, receipt.outcome, reconciliation.observation FROM cp_publication_capability capability
           LEFT JOIN cp_publication_begin begin ON begin.organization_id = capability.organization_id
             AND begin.capability_id = capability.capability_id
           LEFT JOIN cp_publication_receipt receipt ON receipt.organization_id = capability.organization_id
             AND receipt.capability_id = capability.capability_id
           LEFT JOIN cp_publication_reconciliation reconciliation
             ON reconciliation.organization_id = capability.organization_id
            AND reconciliation.capability_id = capability.capability_id
           WHERE capability.organization_id = $1 AND capability.intent_id = $2
             AND capability.step = $3 ORDER BY capability.attempt_number DESC LIMIT 1`,
          [command.principal.organizationId, row.intent_id, command.step]);
        const priorObservation = prior.rows[0]?.observation
          ? PublicationOperationObservationV1Schema.parse(prior.rows[0].observation) : null;
        // A provider response of `absent` is not, by itself, proof that the
        // write did not happen.  The only retry gate is a separately persisted
        // authoritative reconciliation observation.  This also makes the
        // begin-without-receipt crash boundary fail closed.
        if (prior.rows[0] && priorObservation?.kind !== "absent") {
          return { kind: "unavailable" as const, reason: prior.rows[0].begun_at
            ? "reconciliation_required" : "capability_nonrenewable" };
        }
        const capability = PublicationOperationCapabilityV1Schema.parse({
          schemaVersion: 1, protocolVersion: "1.0",
          capabilityId: input.idFactory("capability"),
          organizationId: command.principal.organizationId, runId: command.runId,
          attemptId: command.attemptId, attemptNumber: command.attemptNumber,
          epoch: command.attemptNumber, fencingTokenDigest: fenceDigest,
          candidateId: command.candidateId, candidateDigest: command.candidateDigest,
          approvalId: row.approval_id, approverId: row.approver_id,
          repository: row.repository, branch: row.branch, expectedHeadSha: row.expected_head_sha,
          step: command.step, operationId: `${row.intent_id}:${command.step}`,
          idempotencyKey: `${row.intent_id}:${command.step}`,
          runnerId: command.principal.runnerId, runnerGeneration: command.runnerGeneration,
          issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl).toISOString(),
        });
        const capabilityAttemptNumber = (await client.query<{ next_attempt_number: number }>(
          `SELECT COALESCE(MAX(attempt_number),0)+1 AS next_attempt_number
           FROM cp_publication_capability WHERE organization_id=$1 AND intent_id=$2 AND step=$3`,
          [command.principal.organizationId,row.intent_id,command.step])).rows[0]!.next_attempt_number;
        await client.query(
          `INSERT INTO cp_publication_capability(organization_id,capability_id,intent_id,
           operation_id,idempotency_key,step,attempt_number,capability_digest,capability,issued_at,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [command.principal.organizationId, capability.capabilityId, row.intent_id,
            capability.operationId, capability.idempotencyKey, capability.step, capabilityAttemptNumber,
            await computePublicationCapabilityDigestV1(capability), capability,
            capability.issuedAt, capability.expiresAt]);
        return { kind: "issued" as const, capability };
      });
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
        const selected = await client.query<any>(
          `SELECT intent.*, attempt.fencing_token_digest, attempt.state AS attempt_state,
             attempt.lease_expires_at, run.current_attempt_number, run.terminal_kind,
             run.publication_mode, runner.credential_generation
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
           FOR UPDATE OF intent, run, attempt, runner SKIP LOCKED LIMIT 1`,
          [command.principal.organizationId, command.principal.runnerId,
            command.principal.credentialGeneration, now],
        );
        const row = selected.rows[0];
        if (!row) return { kind: "empty" as const };
        const latest = async (step: PublicationOperationStepV1) => {
          const result = await client.query<any>(
            `SELECT capability.*, begin.begun_at, receipt.outcome, receipt.receipt,
                    reconciliation.observation, reconciliation.observed_at AS reconciliation_observed_at
             FROM cp_publication_capability capability
             LEFT JOIN cp_publication_begin begin ON begin.organization_id = capability.organization_id
               AND begin.capability_id = capability.capability_id
             LEFT JOIN cp_publication_receipt receipt ON receipt.organization_id = capability.organization_id
               AND receipt.capability_id = capability.capability_id
             LEFT JOIN cp_publication_reconciliation reconciliation ON reconciliation.organization_id = capability.organization_id
               AND reconciliation.capability_id = capability.capability_id
             WHERE capability.organization_id = $1 AND capability.intent_id = $2 AND capability.step = $3
             ORDER BY capability.attempt_number DESC LIMIT 1`,
            [command.principal.organizationId, row.intent_id, step],
          );
          return result.rows[0] ?? null;
        };
        const isSettled = (prior: any) => prior?.outcome === "succeeded" || (prior?.observation
          && PublicationOperationObservationV1Schema.parse(prior.observation).kind === "present");
        const settledReceipt = async (prior: any): Promise<PublicationOperationReceiptV1> => {
          if (prior.receipt && prior.outcome === "succeeded") return PublicationOperationReceiptV1Schema.parse(prior.receipt);
          const capability = PublicationOperationCapabilityV1Schema.parse(prior.capability);
          const observation = PublicationOperationObservationV1Schema.parse(prior.observation);
          const seed = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
            receiptId: `reconciled_${capability.capabilityId}`, capabilityId: capability.capabilityId,
            operationId: capability.operationId, organizationId: capability.organizationId,
            runId: capability.runId, attemptId: capability.attemptId, candidateId: capability.candidateId,
            candidateDigest: capability.candidateDigest, step: capability.step, runnerId: capability.runnerId,
            runnerGeneration: capability.runnerGeneration, fencingTokenDigest: capability.fencingTokenDigest,
            observation, outcome: "succeeded" as const,
            observedAt: new Date(prior.reconciliation_observed_at).toISOString() };
          return PublicationOperationReceiptV1Schema.parse({ ...seed,
            receiptDigest: await computePublicationOperationReceiptDigestV1(seed) });
        };
        const retryable = async (step: PublicationOperationStepV1) => {
          const prior = await latest(step);
          if (!prior) return { retry: true as const };
          const reconciliation = prior.observation
            ? PublicationOperationObservationV1Schema.parse(prior.observation) : null;
          // A receipt or a begin without a later authoritative absence is an
          // ambiguous external-write boundary, never a blind reissue.
          if (reconciliation?.kind === "absent") return { retry: true as const };
          return { retry: false as const, reason: prior.begun_at
            ? "reconciliation_required" : "capability_nonrenewable" };
        };
        const push = await latest("push_owned_branch");
        let step: PublicationOperationStepV1;
        if (!push) {
          step = "push_owned_branch";
        } else if (isSettled(push)) {
          const pullRequest = await latest("create_draft_pull_request");
          if (isSettled(pullRequest)) {
            return { kind: "completion_pending" as const,
              capability: PublicationOperationCapabilityV1Schema.parse(pullRequest.capability),
              completionReceipt: await settledReceipt(pullRequest) };
          }
          const ready = await retryable("create_draft_pull_request");
          if (!ready.retry) {
            const original = await latest("create_draft_pull_request");
            if (original?.begun_at) return { kind: "reconciliation_pending" as const,
              capability: PublicationOperationCapabilityV1Schema.parse(original.capability) };
            return { kind: "blocked" as const, reason: ready.reason };
          }
          step = "create_draft_pull_request";
        } else {
          const ready = await retryable("push_owned_branch");
          if (!ready.retry) {
            const original = await latest("push_owned_branch");
            if (original?.begun_at) return { kind: "reconciliation_pending" as const,
              capability: PublicationOperationCapabilityV1Schema.parse(original.capability) };
            return { kind: "blocked" as const, reason: ready.reason };
          }
          step = "push_owned_branch";
        }
        const capability = PublicationOperationCapabilityV1Schema.parse({
          schemaVersion: 1, protocolVersion: "1.0", capabilityId: input.idFactory("capability"),
          organizationId: command.principal.organizationId, runId: row.run_id,
          attemptId: row.attempt_id, attemptNumber: row.attempt_number, epoch: row.attempt_number,
          fencingTokenDigest: row.fencing_token_digest, candidateId: row.candidate_id,
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
      });
    },

    async begin(command: { principal: RuntimePrincipal; fencingToken: string;
      capability: PublicationOperationCapabilityV1; begunAt: string }) {
      const parsed = PublicationOperationCapabilityV1Schema.parse(command.capability);
      const fence = await computeMaterialActionFencingTokenDigestV1(command.fencingToken);
      if (fence !== parsed.fencingTokenDigest || parsed.runnerId !== command.principal.runnerId
        || parsed.organizationId !== command.principal.organizationId) return { kind: "stale_fence" as const };
      try {
        const result = await input.pool.query(
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
             AND attempt.state IN ('succeeded','claimed','running')
             AND attempt.lease_expires_at > CURRENT_TIMESTAMP
             AND runner.credential_generation = intent.runner_generation`,
          [parsed.organizationId, parsed.capabilityId, await computePublicationCapabilityDigestV1(parsed)]);
        if (result.rowCount !== 1) return { kind: "stale_fence" as const };
        return { kind: "begun" as const };
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
      const issued = await input.pool.query<{ capability: unknown }>(
        `SELECT capability FROM cp_publication_capability
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
      try {
        const result = await input.pool.query(
          `INSERT INTO cp_publication_receipt(organization_id,receipt_id,capability_id,
           operation_id,outcome,receipt_digest,receipt,observed_at)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8 FROM cp_publication_begin begin
           WHERE begin.organization_id=$1 AND begin.capability_id=$3
             AND begin.operation_id=$4`,
          [receipt.organizationId, receipt.receiptId, receipt.capabilityId,
            receipt.operationId, receipt.outcome, receipt.receiptDigest, receipt,
            receipt.observedAt]);
        return result.rowCount === 1 ? { kind: "recorded" as const, receipt }
          : { kind: "conflict" as const };
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          const existing = await input.pool.query<{ receipt_digest: string; receipt: unknown }>(
            `SELECT receipt_digest,receipt FROM cp_publication_receipt
             WHERE organization_id=$1 AND capability_id=$2`,
            [receipt.organizationId, receipt.capabilityId]);
          return existing.rows[0]?.receipt_digest === receipt.receiptDigest
            ? { kind: "replayed" as const, receipt: PublicationOperationReceiptV1Schema.parse(existing.rows[0].receipt) }
            : { kind: "conflict" as const };
        }
        throw error;
      }
    },

    async reconcile(command: { principal: RuntimePrincipal; capabilityId: string;
      operationId: string; reconciliationId: string; observation: unknown; observedAt: string }) {
      const observation = PublicationOperationObservationV1Schema.parse(command.observation);
      const capability = await input.pool.query<{ capability: unknown; begun: boolean }>(
        `SELECT capability.capability,
           EXISTS(SELECT 1 FROM cp_publication_begin begin
             WHERE begin.organization_id = capability.organization_id
               AND begin.capability_id = capability.capability_id
               AND begin.operation_id = capability.operation_id) AS begun
         FROM cp_publication_capability capability
         WHERE capability.organization_id = $1 AND capability.capability_id = $2
           AND capability.operation_id = $3`,
        [command.principal.organizationId, command.capabilityId, command.operationId]);
      const exact = capability.rows[0]
        ? PublicationOperationCapabilityV1Schema.parse(capability.rows[0].capability) : null;
      if (!exact || !capability.rows[0]?.begun
        || exact.runnerId !== command.principal.runnerId
        || !exactReceiptObservation(exact, observation)) return { kind: "conflict" as const };
      try {
        await input.pool.query(
          `INSERT INTO cp_publication_reconciliation(organization_id,reconciliation_id,
           capability_id,operation_id,observation,observed_at)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [command.principal.organizationId, command.reconciliationId, command.capabilityId,
            command.operationId, observation, command.observedAt]);
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
      }
      return observation.kind === "present" ? { kind: "settled" as const }
        : observation.kind === "absent" ? { kind: "retry_authorized" as const }
          : { kind: "outcome_unknown" as const };
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
        const current = await client.query<any>(
          `SELECT run.*, attempt.attempt_id, attempt.attempt_number, attempt.state AS attempt_state,
             attempt.fencing_token_digest, candidate.candidate_id, candidate.candidate, intent.intent_id,
             intent.candidate_digest AS intent_candidate_digest, intent.repository AS intent_repository,
             intent.branch AS intent_branch, intent.expected_head_sha, intent.runner_generation,
             ownership.ownership_id, ownership.provider AS ownership_provider,
             ownership.owner AS ownership_owner, ownership.repo AS ownership_repo,
             ownership.remote AS ownership_remote, ownership.base_branch AS ownership_base_branch,
             ownership.branch AS ownership_branch, ownership.expected_head_sha AS ownership_head
           FROM cp_hosted_run run
           JOIN cp_hosted_attempt attempt ON attempt.organization_id = run.organization_id
             AND attempt.run_id = run.run_id AND attempt.attempt_number = run.current_attempt_number
           JOIN cp_publication_candidate candidate ON candidate.organization_id = run.organization_id
             AND candidate.run_id = run.run_id AND candidate.attempt_id = attempt.attempt_id
           JOIN cp_publication_intent intent ON intent.organization_id = run.organization_id
             AND intent.run_id = run.run_id AND intent.attempt_id = attempt.attempt_id
             AND intent.candidate_id = candidate.candidate_id
           JOIN cp_publication_branch_ownership ownership ON ownership.organization_id = intent.organization_id
             AND ownership.ownership_id = intent.ownership_id
           WHERE run.organization_id = $1 AND run.run_id = $2
           FOR UPDATE OF run, attempt, candidate, intent, ownership`,
          [completion.organizationId, completion.runId],
        );
        const row = current.rows[0];
        if (!row) return { kind: "stale_fence" as const };

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
          || row.expected_head_sha !== completion.observation.headSha
          || canonicalJsonStringify({ provider: row.ownership_provider, owner: row.ownership_owner,
            repo: row.ownership_repo, remote: row.ownership_remote,
            baseBranch: row.ownership_base_branch }) !== canonicalJsonStringify(row.intent_repository)
          || row.ownership_branch !== row.intent_branch || row.ownership_head !== row.expected_head_sha) {
          return { kind: "stale_fence" as const };
        }

        const policy = AdmissionPolicySnapshotReceiptEnvelopeV1Schema.parse(row.admission_policy_snapshot);
        const requiredChecks = policy.payload.admissionRules.requiredCheckNames;
        const operations = await client.query<any>(
          `SELECT capability.step, capability.operation_id, capability.capability, receipt.outcome,
                  receipt.receipt_digest, receipt.receipt, reconciliation.observation,
                  reconciliation.observed_at AS reconciliation_observed_at
           FROM cp_publication_capability capability
           LEFT JOIN cp_publication_receipt receipt ON receipt.organization_id = capability.organization_id
             AND receipt.capability_id = capability.capability_id
           LEFT JOIN cp_publication_reconciliation reconciliation
             ON reconciliation.organization_id = capability.organization_id
            AND reconciliation.capability_id = capability.capability_id
           WHERE capability.organization_id = $1 AND capability.intent_id = $2
           ORDER BY capability.attempt_number DESC`,
          [completion.organizationId, row.intent_id],
        );
        const latestByStep = new Map<string, any>();
        for (const operation of operations.rows) {
          if (!latestByStep.has(operation.step)) latestByStep.set(operation.step, operation);
        }
        const push = latestByStep.get("push_owned_branch");
        const pullRequest = latestByStep.get("create_draft_pull_request");
        const observation = (operation: any) => operation?.observation
          ? PublicationOperationObservationV1Schema.parse(operation.observation) : null;
        const succeeded = (operation: any) => operation?.outcome === "succeeded"
          || observation(operation)?.kind === "present";
        if ([push, pullRequest].some((operation) => operation?.outcome === "outcome_unknown"
          && observation(operation)?.kind !== "present")) {
          return { kind: "outcome_unknown" as const, reason: "publication_outcome_unknown" };
        }
        if (!succeeded(push) || !succeeded(pullRequest)) {
          return { kind: "nonterminal" as const, reason: "publication_receipt_missing" };
        }
        const receipt = async (operation: any): Promise<PublicationOperationReceiptV1> => {
          if (operation.receipt && operation.outcome === "succeeded") return PublicationOperationReceiptV1Schema.parse(operation.receipt);
          const capability = PublicationOperationCapabilityV1Schema.parse(operation.capability);
          const observed = PublicationOperationObservationV1Schema.parse(operation.observation);
          const seed = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
            receiptId: `reconciled_${capability.capabilityId}`, capabilityId: capability.capabilityId,
            operationId: capability.operationId, organizationId: capability.organizationId,
            runId: capability.runId, attemptId: capability.attemptId, candidateId: capability.candidateId,
            candidateDigest: capability.candidateDigest, step: capability.step, runnerId: capability.runnerId,
            runnerGeneration: capability.runnerGeneration, fencingTokenDigest: capability.fencingTokenDigest,
            observation: observed, outcome: "succeeded" as const,
            observedAt: new Date(operation.reconciliation_observed_at).toISOString() };
          return PublicationOperationReceiptV1Schema.parse({ ...seed,
            receiptDigest: await computePublicationOperationReceiptDigestV1(seed) });
        };
        const pushReceipt = await receipt(push);
        const pullRequestReceipt = await receipt(pullRequest);
        if (!exactReceiptObservation(PublicationOperationCapabilityV1Schema.parse(push.capability), pushReceipt.observation)
          || !exactReceiptObservation(PublicationOperationCapabilityV1Schema.parse(pullRequest.capability), pullRequestReceipt.observation)) {
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
            row.intent_id, row.ownership_id, push.operation_id, pushReceipt.receiptDigest,
            pullRequest.operation_id, pullRequestReceipt.receiptDigest, pullRequestReceipt.observation.externalId,
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
