import { createHash } from "node:crypto";
import {
  AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
  PublicationOperationCapabilityV1Schema,
  RunnerPublicationCompletionV1Schema,
  PublicationOperationReceiptV1Schema,
  PublicationOperationObservationV1Schema,
  computeMaterialActionFencingTokenDigestV1,
  computePublicationCapabilityDigestV1,
  computePublicationOperationReceiptDigestV1,
  type PublicationOperationCapabilityV1,
  type PublicationOperationReceiptV1,
  type PublicationOperationStepV1,
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

export type PublicationApprovalInput = {
  organizationId: string; runnerId: string;
  runId: string; attemptId: string; attemptNumber: number; fencingToken: string;
  candidateId: string; candidateDigest: string; approvalId: string; approverId: string;
  repository: { provider: "github"; owner: string; repo: string; remote: string; baseBranch: string };
  branch: string; expectedHeadSha: string; runnerGeneration: number;
  approvedAt: string; expiresAt: string;
};

export function createPublicationPublisher(input: { pool: Pool; clock: Clock;
  idFactory: IdFactory; capabilityTtlMs?: number }) {
  const ttl = Math.min(input.capabilityTtlMs ?? 60_000, 5 * 60_000);
  return {
    async approve(command: PublicationApprovalInput): Promise<
      { kind: "approved"; intentId: string } | { kind: "replayed"; intentId: string }
      | { kind: "rejected"; reason: string }> {
      if (command.approverId === command.runnerId) {
        return { kind: "rejected", reason: "self_approval_prohibited" };
      }
      if (command.branch === command.repository.baseBranch) {
        return { kind: "rejected", reason: "target_branch_write_prohibited" };
      }
      const now = input.clock.now();
      if (Date.parse(command.approvedAt) > now.getTime()
        || Date.parse(command.expiresAt) <= now.getTime()) {
        return { kind: "rejected", reason: "approval_expired" };
      }
      const fenceDigest = await computeMaterialActionFencingTokenDigestV1(command.fencingToken);
      try {
        return await withPostgresTransaction(input.pool, async (client) => {
          const existing = await client.query<{ intent_id: string }>(
            `SELECT intent_id FROM cp_publication_intent
             WHERE organization_id = $1 AND candidate_id = $2`,
            [command.organizationId, command.candidateId]);
          if (existing.rows[0]) return { kind: "replayed" as const,
            intentId: existing.rows[0].intent_id };
          const exact = await client.query<{ publication_mode: string; runner_id: string;
            current_attempt_number: number; terminal_kind: string | null;
            attempt_id: string; fencing_token_digest: string; lease_expires_at: Date;
            state: string; credential_generation: number; candidate: unknown }>(
            `SELECT run.publication_mode, run.runner_id, run.current_attempt_number,
               run.terminal_kind, attempt.attempt_id, attempt.fencing_token_digest,
               attempt.lease_expires_at, attempt.state, runner.credential_generation,
               candidate.candidate
             FROM cp_hosted_run run
             JOIN cp_hosted_attempt attempt ON attempt.organization_id = run.organization_id
              AND attempt.run_id = run.run_id AND attempt.attempt_number = run.current_attempt_number
             JOIN cp_runner runner ON runner.organization_id = run.organization_id
              AND runner.runner_id = run.runner_id
             JOIN cp_publication_candidate candidate ON candidate.organization_id = run.organization_id
              AND candidate.run_id = run.run_id AND candidate.attempt_id = attempt.attempt_id
             WHERE run.organization_id = $1 AND run.run_id = $2 AND candidate.candidate_id = $3
             FOR UPDATE OF run, attempt, runner, candidate`,
            [command.organizationId, command.runId, command.candidateId]);
          const row = exact.rows[0];
          if (!row || row.publication_mode !== "pull_request") {
            return { kind: "rejected" as const, reason: "proposal_only_frozen" };
          }
          if (row.terminal_kind !== null || row.runner_id !== command.runnerId
            || row.current_attempt_number !== command.attemptNumber
            || row.attempt_id !== command.attemptId || row.fencing_token_digest !== fenceDigest
            || row.lease_expires_at <= now || !["claimed", "running"].includes(row.state)
            || row.credential_generation !== command.runnerGeneration) {
            return { kind: "rejected" as const, reason: "stale_publication_authority" };
          }
          if (digest(row.candidate) !== command.candidateDigest) {
            return { kind: "rejected" as const, reason: "candidate_digest_mismatch" };
          }
          const intentId = input.idFactory("intent");
          await client.query(
            `INSERT INTO cp_publication_intent(organization_id,intent_id,run_id,
             attempt_id,attempt_number,candidate_id,candidate_digest,approval_id,
             approver_id,repository,branch,expected_head_sha,runner_id,runner_generation,
             approved_at,expires_at,created_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [command.organizationId, intentId, command.runId, command.attemptId,
              command.attemptNumber, command.candidateId, command.candidateDigest,
              command.approvalId, command.approverId, command.repository, command.branch,
              command.expectedHeadSha, command.runnerId, command.runnerGeneration,
              command.approvedAt, command.expiresAt, now]);
          await client.query(
            `INSERT INTO cp_publication_branch_ownership(organization_id,ownership_id,
             intent_id,repository,branch,expected_head_sha,created_at)
             VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [command.organizationId, input.idFactory("ownership"), intentId,
              command.repository, command.branch, command.expectedHeadSha, now]);
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
      const now = input.clock.now();
      const fenceDigest = await computeMaterialActionFencingTokenDigestV1(command.fencingToken);
      return withPostgresTransaction(input.pool, async (client) => {
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
             AND capability.step = $3 ORDER BY capability.issued_at DESC LIMIT 1`,
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
        await client.query(
          `INSERT INTO cp_publication_capability(organization_id,capability_id,intent_id,
           operation_id,idempotency_key,step,capability_digest,capability,issued_at,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [command.principal.organizationId, capability.capabilityId, row.intent_id,
            capability.operationId, capability.idempotencyKey, capability.step,
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
      | { kind: "empty" } | { kind: "blocked"; reason: string }
    > {
      const now = input.clock.now();
      return withPostgresTransaction(input.pool, async (client) => {
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
            `SELECT capability.*, begin.begun_at, receipt.outcome, receipt.receipt, reconciliation.observation
             FROM cp_publication_capability capability
             LEFT JOIN cp_publication_begin begin ON begin.organization_id = capability.organization_id
               AND begin.capability_id = capability.capability_id
             LEFT JOIN cp_publication_receipt receipt ON receipt.organization_id = capability.organization_id
               AND receipt.capability_id = capability.capability_id
             LEFT JOIN cp_publication_reconciliation reconciliation ON reconciliation.organization_id = capability.organization_id
               AND reconciliation.capability_id = capability.capability_id
             WHERE capability.organization_id = $1 AND capability.intent_id = $2 AND capability.step = $3
             ORDER BY capability.issued_at DESC, capability.capability_id DESC LIMIT 1`,
            [command.principal.organizationId, row.intent_id, step],
          );
          return result.rows[0] ?? null;
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
        } else if (push.outcome === "succeeded") {
          const pullRequest = await latest("create_draft_pull_request");
          if (pullRequest?.outcome === "succeeded") {
            return { kind: "completion_pending" as const,
              capability: PublicationOperationCapabilityV1Schema.parse(pullRequest.capability),
              completionReceipt: PublicationOperationReceiptV1Schema.parse(pullRequest.receipt) };
          }
          const ready = await retryable("create_draft_pull_request");
          if (!ready.retry) return { kind: "blocked" as const, reason: ready.reason };
          step = "create_draft_pull_request";
        } else {
          const ready = await retryable("push_owned_branch");
          if (!ready.retry) return { kind: "blocked" as const, reason: ready.reason };
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
        await client.query(
          `INSERT INTO cp_publication_capability(organization_id,capability_id,intent_id,operation_id,
             idempotency_key,step,capability_digest,capability,issued_at,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [command.principal.organizationId, capability.capabilityId, row.intent_id,
            capability.operationId, capability.idempotencyKey, capability.step,
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
        || parsed.organizationId !== command.principal.organizationId
        || Date.parse(parsed.expiresAt) <= input.clock.now().getTime()) return { kind: "stale_fence" as const };
      try {
        const result = await input.pool.query(
          `INSERT INTO cp_publication_begin(organization_id,capability_id,operation_id,begun_at)
           SELECT capability.organization_id, capability.capability_id, capability.operation_id, $3
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
             AND capability.capability_digest=$4 AND capability.expires_at > $3
             AND run.terminal_kind IS NULL AND run.current_attempt_number = intent.attempt_number
             AND (attempt.state = 'succeeded'
               OR (attempt.state IN ('claimed','running') AND attempt.lease_expires_at > $3))
             AND runner.credential_generation = intent.runner_generation`,
          [parsed.organizationId, parsed.capabilityId, command.begunAt,
            await computePublicationCapabilityDigestV1(parsed)]);
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
        || exact.runnerId !== command.principal.runnerId) return { kind: "conflict" as const };
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
             ownership.ownership_id, ownership.repository AS ownership_repository,
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
             AND ownership.intent_id = intent.intent_id
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
          || canonicalJsonStringify(row.ownership_repository) !== canonicalJsonStringify(row.intent_repository)
          || row.ownership_branch !== row.intent_branch || row.ownership_head !== row.expected_head_sha) {
          return { kind: "stale_fence" as const };
        }

        const policy = AdmissionPolicySnapshotReceiptEnvelopeV1Schema.parse(row.admission_policy_snapshot);
        const requiredChecks = policy.payload.admissionRules.requiredCheckNames;
        const operations = await client.query<any>(
          `SELECT capability.step, capability.operation_id, receipt.outcome, receipt.receipt_digest, receipt.receipt
           FROM cp_publication_capability capability
           JOIN cp_publication_receipt receipt ON receipt.organization_id = capability.organization_id
             AND receipt.capability_id = capability.capability_id
           WHERE capability.organization_id = $1 AND capability.intent_id = $2
           ORDER BY capability.issued_at DESC, capability.capability_id DESC`,
          [completion.organizationId, row.intent_id],
        );
        const latestByStep = new Map<string, any>();
        for (const operation of operations.rows) {
          if (!latestByStep.has(operation.step)) latestByStep.set(operation.step, operation);
        }
        const push = latestByStep.get("push_owned_branch");
        const pullRequest = latestByStep.get("create_draft_pull_request");
        if ([push, pullRequest].some((operation) => operation?.outcome === "outcome_unknown")) {
          return { kind: "outcome_unknown" as const, reason: "publication_outcome_unknown" };
        }
        if (push?.outcome !== "succeeded" || pullRequest?.outcome !== "succeeded") {
          return { kind: "nonterminal" as const, reason: "publication_receipt_missing" };
        }
        const pullRequestReceipt = PublicationOperationReceiptV1Schema.parse(pullRequest.receipt);
        if (pullRequestReceipt.observation.kind !== "present"
          || !pullRequestReceipt.observation.externalId || !pullRequestReceipt.observation.externalUri
          || pullRequestReceipt.observation.draft !== true
          || pullRequestReceipt.observation.headSha !== completion.observation.headSha
          || pullRequestReceipt.observation.externalUri !== completion.observation.pullRequestUrl
          || !pullRequestReceipt.observation.externalId.endsWith(String(completion.observation.pullRequestNumber))) {
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
            row.intent_id, row.ownership_id, push.operation_id, push.receipt_digest,
            pullRequest.operation_id, pullRequest.receipt_digest, pullRequestReceipt.observation.externalId,
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
