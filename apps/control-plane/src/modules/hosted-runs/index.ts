import {
  AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeHostedClaimFencingTokenDigestV1,
  computeHostedLifecycleReceiptIdV1,
  computeHostedLifecycleRequestDigestV1,
  HostedAdmissionEnvelopeV1Schema,
  HostedClaimRequestV1Schema,
  HostedClaimV1Schema,
  HostedCancelRequestV1Schema,
  HostedCompleteRequestV1Schema,
  HostedHeartbeatRequestV1Schema,
  HostedLifecycleReceiptEnvelopeV1Schema,
  HostedProgressRequestV1Schema,
  HostedRejectStartRequestV1Schema,
  HostedRunningRequestV1Schema,
  verifyHostedAdmissionEnvelopeDigestV1,
  type AdmissionPolicySnapshotReceiptEnvelopeV1,
  type HostedAdmissionEnvelopeV1,
  type HostedClaimRequestV1,
  type HostedClaimV1,
  type HostedLifecycleActionV1,
  type HostedLifecycleReceiptEnvelopeV1,
  type HostedLifecycleRequestV1,
} from "@opentag/control-protocol";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { withPostgresTransaction } from "../../database/postgres.js";
import type { RuntimePrincipal } from "../runners/index.js";
import { classifyAttemptMaterialActionTruth } from "./material-actions.js";

type Clock = { now(): Date };
type IdFactory = (kind: "attempt") => string;
export type HostedFencingTokenContext = {
  organizationId: string;
  operationId: string;
  runId: string;
  attemptId: string;
  attemptNumber: number;
};
type TokenFactory = (context: HostedFencingTokenContext) => string;

const StoredHostedClaimAttemptV1Schema = z
  .object({
    id: HostedClaimV1Schema.shape.attempt.shape.id,
    number: HostedClaimV1Schema.shape.attempt.shape.number,
    epoch: HostedClaimV1Schema.shape.attempt.shape.epoch,
    fencingTokenDigest:
      HostedClaimV1Schema.shape.attempt.shape.fencingTokenDigest,
    leaseExpiresAt: HostedClaimV1Schema.shape.attempt.shape.leaseExpiresAt,
  })
  .strict();
const StoredHostedSourceContentGrantV1Schema = z.object({
  grantId: HostedClaimV1Schema.shape.sourceContentGrant.shape.grantId,
  keyVersion: HostedClaimV1Schema.shape.sourceContentGrant.shape.keyVersion,
  fenceDigest: HostedClaimV1Schema.shape.sourceContentGrant.shape.fenceDigest,
  contentIds: HostedClaimV1Schema.shape.sourceContentGrant.shape.contentIds,
  purpose: HostedClaimV1Schema.shape.sourceContentGrant.shape.purpose,
  expiresAt: HostedClaimV1Schema.shape.sourceContentGrant.shape.expiresAt,
}).strict();
const StoredHostedClaimV1Schema = z
  .object({
    ...HostedClaimV1Schema.shape,
    attempt: StoredHostedClaimAttemptV1Schema,
    sourceContentGrant: StoredHostedSourceContentGrantV1Schema,
  })
  .strict();

function claimForStorage(claim: HostedClaimV1) {
  const { fencingToken: _fencingToken, ...attempt } = claim.attempt;
  const { token: _grantToken, ...sourceContentGrant } = claim.sourceContentGrant;
  return StoredHostedClaimV1Schema.parse({ ...claim, attempt, sourceContentGrant });
}

export type CanonicalRunStatus =
  | "queued" | "assigned" | "running" | "needs_approval" | "succeeded"
  | "failed" | "cancelled" | "interrupted" | "timed_out";
type TerminalKind = Extract<CanonicalRunStatus,
  "succeeded" | "failed" | "cancelled" | "interrupted" | "timed_out">;
type HostedRunProjection = {
  canonicalStatus: CanonicalRunStatus;
  status: CanonicalRunStatus | "waiting_for_runner" | "waiting_for_approval"
    | "proposal_ready" | "ready_for_review" | "publication_pending";
  queueClaimDeadline: string;
  outcome: "outcome_unknown" | null;
};

type HostedRunRow = {
  organization_id: string;
  run_id: string;
  runner_id: string;
  executor_id: string;
  state: CanonicalRunStatus;
  current_attempt_number: number;
  terminal_kind: TerminalKind | null;
  hosted_admission: unknown;
  admission_policy_snapshot: unknown;
  source_version_ref: string;
  source_content_ids: string[];
  queue_claim_deadline: Date;
  outcome_state: "outcome_unknown" | null;
};

type HostedAttemptRow = {
  attempt_number: number;
  attempt_id: string;
  runner_id: string;
  credential_id: string;
  fencing_token_digest: string;
  lease_expires_at: Date;
  state: string;
};

export type HostedRunCoordinator = {
  admit(input: {
    runId: string;
    admission: HostedAdmissionEnvelopeV1;
    policy: AdmissionPolicySnapshotReceiptEnvelopeV1;
  }): Promise<
    | { kind: "created" | "replayed"; runId: string; view: HostedRunProjection }
    | { kind: "conflict"; reason: "identity_mismatch" | "admission_mismatch" | "deadline_invalid" }
  >;
  claim(input: {
    principal: RuntimePrincipal;
    request: HostedClaimRequestV1;
  }): Promise<
    | { kind: "claimed" | "replayed"; claim: HostedClaimV1 }
    | { kind: "empty" }
    | { kind: "conflict"; reason: "authority_mismatch" | "operation_mismatch" }
  >;
  lifecycle(input: {
    principal: RuntimePrincipal;
    runId: string;
    action: HostedLifecycleActionV1;
    request: HostedLifecycleRequestV1;
  }): Promise<
    | { kind: "accepted" | "replayed"; receipt: HostedLifecycleReceiptEnvelopeV1 }
    | { kind: "stale_fence" }
    | { kind: "terminal"; terminalKind: TerminalKind }
    | { kind: "conflict"; reason: "operation_mismatch" | "invalid_request" }
  >;
  reconcileExpiredAttempts(
    organizationId: string | null,
  ): Promise<{ expired: number }>;
  expireQueued(organizationId: string | null): Promise<{ expired: number }>;
  cancelRun(input: { organizationId: string; runId: string; reason: string }): Promise<
    { kind: "cancelled" | "terminal" | "missing" }
  >;
  invalidate(input: { organizationId: string; sourceVersionRef: string;
    contentIds: string[]; reason: "source_content_deleted"; commandId: string }): Promise<unknown>;
  invalidateInTransaction(client: PoolClient, input: { organizationId: string;
    sourceVersionRef: string; contentIds: string[]; reason: "source_content_deleted";
    commandId: string }): Promise<unknown>;
  inspect(input: {
    organizationId: string;
    runId: string;
  }): Promise<(HostedRunProjection & { state: CanonicalRunStatus;
    terminalKind: TerminalKind | null; terminalReason: string | null }) | null>;
};

async function verifyPolicyReceipt(
  policy: AdmissionPolicySnapshotReceiptEnvelopeV1,
): Promise<boolean> {
  const { receiptDigest: _receiptDigest, ...receiptDigestInput } = policy;
  return policy.payloadDigest === await computeControlPayloadDigestV1(policy.payload)
    && policy.receiptDigest
      === await computeControlReceiptDigestV1(receiptDigestInput);
}

function linkedAdmission(
  runId: string,
  admission: HostedAdmissionEnvelopeV1,
  policy: AdmissionPolicySnapshotReceiptEnvelopeV1,
): boolean {
  return policy.runId === runId
    && policy.organizationId === admission.organizationId
    && policy.operationId === admission.operationId
    && policy.payload.tenant.organizationId === admission.organizationId
    && policy.payload.runner.runnerId === admission.runnerId
    && policy.payload.target.bindingId === admission.bindingId
    && policy.payload.target.projectTargetId
      === admission.projectTarget.projectTargetId
    && policy.payload.target.providerRepositoryId
      === admission.repository.providerRepositoryId
    && policy.payload.snapshotId === admission.admissionPolicySnapshot.snapshotId
    && policy.receiptDigest === admission.admissionPolicySnapshot.digest
    && policy.payload.target.authorizedPublicationModes.includes(
      admission.publicationPolicy.mode,
    )
    && (
      (admission.publicationPolicy.mode === "proposal_only"
        && admission.completionContract.mode === "proposal_ready")
      || (admission.publicationPolicy.mode === "pull_request"
        && admission.completionContract.mode === "pull_request_ready")
    );
}

function lifecycleOperation(action: HostedLifecycleActionV1) {
  if (action === "reject-start") return "reject_start" as const;
  if (action === "complete") return "executor_result" as const;
  return action;
}

function terminalKind(state: HostedRunRow["state"]): TerminalKind | null {
  return state === "succeeded" || state === "failed" || state === "cancelled"
      || state === "interrupted" || state === "timed_out"
    ? state
    : null;
}

function projectRun(run: Pick<HostedRunRow, "state" | "queue_claim_deadline" | "outcome_state">
  & { publication_mode?: string }): HostedRunProjection {
  const status = run.state === "queued" ? "waiting_for_runner"
    : run.state === "needs_approval" ? "waiting_for_approval"
    : run.state === "succeeded" && run.publication_mode === "proposal_only"
      ? "proposal_ready"
      : run.state === "succeeded" && run.publication_mode === "pull_request"
        ? "ready_for_review"
        : run.state;
  return { canonicalStatus: run.state, status,
    queueClaimDeadline: run.queue_claim_deadline.toISOString(),
    outcome: run.outcome_state };
}

export function createHostedRunCoordinator(input: {
  pool: Pool;
  clock: Clock;
  leaseDurationMs: number;
  idFactory: IdFactory;
  tokenFactory: TokenFactory;
  issueSourceContentGrantInTransaction: (client: PoolClient, input: {
    organizationId: string; runId: string; attemptId: string; fenceDigest: string;
    contentIds: string[]; purpose: "source_context"; expiresAt: Date;
  }) => Promise<HostedClaimV1["sourceContentGrant"]>;
}): HostedRunCoordinator {
  async function hydrateStoredClaim(client: PoolClient, value: unknown): Promise<HostedClaimV1 | null> {
    const stored = StoredHostedClaimV1Schema.parse(value);
    const fencingToken = input.tokenFactory({
      organizationId: stored.organizationId,
      operationId: stored.operationId,
      runId: stored.runId,
      attemptId: stored.attempt.id,
      attemptNumber: stored.attempt.number,
    });
    if (
      await computeHostedClaimFencingTokenDigestV1(fencingToken)
        !== stored.attempt.fencingTokenDigest
    ) return null;
    const sourceContentGrant = await input.issueSourceContentGrantInTransaction(client, {
      organizationId: stored.organizationId, runId: stored.runId,
      attemptId: stored.attempt.id, fenceDigest: stored.attempt.fencingTokenDigest,
      contentIds: stored.sourceContentGrant.contentIds,
      purpose: stored.sourceContentGrant.purpose,
      expiresAt: new Date(stored.sourceContentGrant.expiresAt),
    });
    return HostedClaimV1Schema.parse({
      ...stored,
      attempt: { ...stored.attempt, fencingToken },
      sourceContentGrant,
    });
  }

  async function invalidateInTransaction(client: PoolClient, command: {
    organizationId: string; sourceVersionRef: string; contentIds: string[];
    reason: "source_content_deleted"; commandId: string;
  }) {
    const normalizedContentIds = [...new Set(command.contentIds)].sort();
    const requestDigest = await computeControlPayloadDigestV1({
      organizationId: command.organizationId, sourceVersionRef: command.sourceVersionRef,
      contentIds: normalizedContentIds, reason: command.reason, commandId: command.commandId,
    });
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      JSON.stringify(["opentag.control.source-invalidation/v1",
        command.organizationId, command.commandId]),
    ]);
    const prior = await client.query<{ request_digest: string; receipt: unknown }>(
      `SELECT request_digest, receipt FROM cp_source_content_invalidation_receipt
       WHERE organization_id = $1 AND command_id = $2 FOR UPDATE`,
      [command.organizationId, command.commandId],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].request_digest !== requestDigest) {
        throw new Error("source_invalidation_conflict");
      }
      return prior.rows[0].receipt;
    }
    const runs = await client.query<HostedRunRow>(
      `SELECT * FROM cp_hosted_run WHERE organization_id = $1 AND source_version_ref = $2
       ORDER BY run_id FOR UPDATE`,
      [command.organizationId, command.sourceVersionRef],
    );
    const now = input.clock.now().toISOString();
    for (const run of runs.rows) {
      if (run.terminal_kind) continue;
      const attemptIdentity = run.current_attempt_number > 0
        ? await client.query<{ attempt_id: string }>(
            `SELECT attempt_id FROM cp_hosted_attempt WHERE organization_id = $1
             AND run_id = $2 AND attempt_number = $3`,
            [run.organization_id, run.run_id, run.current_attempt_number],
          )
        : { rows: [] as Array<{ attempt_id: string }> };
      const material = attemptIdentity.rows[0]
        ? await classifyAttemptMaterialActionTruth(client, {
            organizationId: run.organization_id, runId: run.run_id,
            attemptId: attemptIdentity.rows[0].attempt_id,
          })
        : { kind: "proven_not_started" as const };
      const nextState: CanonicalRunStatus = run.current_attempt_number > 0
        ? "interrupted" : "cancelled";
      const outcome = material.kind === "started_or_ambiguous" ? "outcome_unknown" : null;
      const reconciliationIdentity = material.kind === "started_or_ambiguous"
        ? material.reconciliationIdentity : null;
      await client.query(
        `UPDATE cp_hosted_attempt SET state = 'expired', updated_at = $4
         WHERE organization_id = $1 AND run_id = $2 AND attempt_number = $3
           AND state IN ('claimed','running','needs_approval')`,
        [run.organization_id, run.run_id, run.current_attempt_number, now],
      );
      await client.query(
        `UPDATE cp_hosted_run SET state = $3, terminal_kind = $3,
           terminal_reason = 'source_content_deleted', outcome_state = $4,
           reconciliation_identity = $5, terminal_receipt = $6::jsonb,
           updated_at = $7 WHERE organization_id = $1 AND run_id = $2`,
        [run.organization_id, run.run_id, nextState, outcome, reconciliationIdentity,
          JSON.stringify({ kind: "source_invalidation", reason: "source_content_deleted",
            recordedAt: now }), now],
      );
    }
    if (normalizedContentIds.length > 0) await client.query(
      `UPDATE cp_source_content_read_grant SET revoked_at = COALESCE(revoked_at, $3)
       WHERE organization_id = $1 AND content_ids && $2::text[] AND consumed_at IS NULL`,
      [command.organizationId, normalizedContentIds, now],
    );
    const receiptSeed = { commandId: command.commandId,
      organizationId: command.organizationId, sourceVersionRef: command.sourceVersionRef,
      reason: "source_content_deleted" as const, recordedAt: now };
    const receipt = { ...receiptSeed,
      authorityReceiptDigest: await computeControlPayloadDigestV1(receiptSeed) };
    await client.query(
      `INSERT INTO cp_source_content_invalidation_receipt(organization_id, command_id,
         request_digest, source_version_ref, receipt, created_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [command.organizationId, command.commandId, requestDigest,
        command.sourceVersionRef, JSON.stringify(receipt), now],
    );
    return receipt;
  }

  return {
    async admit(command) {
      const admission = HostedAdmissionEnvelopeV1Schema.parse(command.admission);
      const policy = AdmissionPolicySnapshotReceiptEnvelopeV1Schema.parse(
        command.policy,
      );
      if (
        !(await verifyHostedAdmissionEnvelopeDigestV1(admission))
        || !(await verifyPolicyReceipt(policy))
        || !linkedAdmission(command.runId, admission, policy)
      ) {
        return { kind: "conflict", reason: "identity_mismatch" };
      }
      const deadline = new Date(admission.queueClaimDeadline);
      if (deadline.getTime() <= input.clock.now().getTime()) {
        return { kind: "conflict", reason: "deadline_invalid" };
      }
      return withPostgresTransaction(input.pool, async (client) => {
        await client.query(
          "SELECT organization_id FROM cp_organization WHERE organization_id = $1 FOR UPDATE",
          [admission.organizationId],
        );
        const existing = await client.query(
          `SELECT run_id, admission_digest, admission_policy_snapshot
           FROM cp_hosted_run
           WHERE organization_id = $1
             AND (admission_id = $2 OR source_identity_digest = $3)
           FOR UPDATE`,
          [
            admission.organizationId,
            admission.admissionId,
            admission.sourceIdentityDigest,
          ],
        ) as {
          rows: Array<{
            run_id: string;
            admission_digest: string;
            admission_policy_snapshot: unknown;
          }>;
        };
        const replay = existing.rows[0];
        if (replay) {
          const storedPolicy = AdmissionPolicySnapshotReceiptEnvelopeV1Schema.parse(
            replay.admission_policy_snapshot,
          );
          if (
            replay.run_id === command.runId
            && replay.admission_digest === admission.envelopeDigest
            && storedPolicy.receiptDigest === policy.receiptDigest
          ) {
            const stored = await client.query<HostedRunRow>(
              "SELECT * FROM cp_hosted_run WHERE organization_id = $1 AND run_id = $2",
              [admission.organizationId, replay.run_id],
            );
            return { kind: "replayed", runId: replay.run_id,
              view: projectRun(stored.rows[0]!) } as const;
          }
          return { kind: "conflict", reason: "admission_mismatch" } as const;
        }
        const now = input.clock.now().toISOString();
        await client.query(
          `INSERT INTO cp_hosted_run(
             organization_id, run_id, admission_id, admission_operation_id,
             admission_digest, source_identity_digest, runner_id, executor_id,
             source_version_ref, source_content_ids, source_context_digest,
             queue_claim_deadline, permission_ceiling_digest, publication_mode,
             publication_policy_digest, completion_mode, completion_contract_digest,
             state, hosted_admission, admission_policy_snapshot, created_at, updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                    'queued',$18::jsonb,$19::jsonb,$20,$20)`,
          [
            admission.organizationId,
            command.runId,
            admission.admissionId,
            admission.operationId,
            admission.envelopeDigest,
            admission.sourceIdentityDigest,
            admission.runnerId,
            policy.payload.executor.executorId,
            admission.sourceContextEnvelope.sourceVersionRef,
            [admission.sourceContextEnvelope.contentId],
            admission.sourceContextEnvelope.envelopeDigest,
            admission.queueClaimDeadline,
            admission.permissionCeiling.digest,
            admission.publicationPolicy.mode,
            admission.publicationPolicy.digest,
            admission.completionContract.mode,
            admission.completionContract.digest,
            JSON.stringify(admission),
            JSON.stringify(policy),
            now,
          ],
        );
        await client.query(
          `INSERT INTO cp_hosted_audit_event(
             organization_id, run_id, event_kind, event, created_at
           ) VALUES($1, $2, 'admitted', $3::jsonb, $4)`,
          [
            admission.organizationId,
            command.runId,
            JSON.stringify({
              runId: command.runId,
              admissionId: admission.admissionId,
              admissionDigest: admission.envelopeDigest,
            }),
            now,
          ],
        );
        return { kind: "created", runId: command.runId,
          view: { canonicalStatus: "queued", status: "waiting_for_runner",
            queueClaimDeadline: admission.queueClaimDeadline, outcome: null } } as const;
      });
    },

    async claim(command) {
      const request = HostedClaimRequestV1Schema.parse(command.request);
      const principal = command.principal;
      if (
        request.expectedAuthority.credentialId !== principal.credentialId
        || request.expectedAuthority.registrationGeneration
          !== principal.registrationGeneration
        || request.expectedAuthority.credentialGeneration
          !== principal.credentialGeneration
      ) {
        return { kind: "conflict", reason: "authority_mismatch" };
      }
      const requestDigest = await computeControlPayloadDigestV1(request);
      return withPostgresTransaction(input.pool, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [
            JSON.stringify([
              "opentag.control.hosted-claim-operation/v1",
              principal.organizationId,
              request.operationId,
            ]),
          ],
        );
        const existingClaim = await client.query(
          `SELECT request_digest, claim
           FROM cp_hosted_claim
           WHERE organization_id = $1 AND operation_id = $2`,
          [principal.organizationId, request.operationId],
        ) as { rows: Array<{ request_digest: string; claim: unknown }> };
        const replay = existingClaim.rows[0];
        if (replay) {
          if (replay.request_digest !== requestDigest) {
            return { kind: "conflict", reason: "operation_mismatch" } as const;
          }
          const claim = await hydrateStoredClaim(client as PoolClient, replay.claim);
          if (!claim) {
            return { kind: "conflict", reason: "authority_mismatch" } as const;
          }
          return {
            kind: "replayed",
            claim,
          } as const;
        }

        const now = input.clock.now();
        const readiness = await client.query(
          `SELECT 1
           FROM cp_runner_readiness
           WHERE organization_id = $1 AND runner_id = $2
             AND receipt_id = $3 AND receipt_digest = $4
             AND expires_at > $5`,
          [
            principal.organizationId,
            principal.runnerId,
            request.expectedAuthority.runnerReadinessReceiptId,
            request.expectedAuthority.runnerReadinessReceiptDigest,
            now.toISOString(),
          ],
        ) as { rows: unknown[] };
        if (readiness.rows.length !== 1) {
          const anyCurrentReadiness = await client.query(
            `SELECT 1 FROM cp_runner_readiness
             WHERE organization_id = $1 AND runner_id = $2 AND expires_at > $3
             LIMIT 1`,
            [principal.organizationId, principal.runnerId, now.toISOString()],
          );
          return anyCurrentReadiness.rows.length === 0
            ? { kind: "empty" } as const
            : { kind: "conflict", reason: "authority_mismatch" } as const;
        }
        const candidate = await client.query(
          `SELECT run.*
           FROM cp_hosted_run run
           WHERE run.organization_id = $1
             AND run.runner_id = $2
             AND run.terminal_kind IS NULL
             AND run.queue_claim_deadline > $3
             AND run.outcome_state IS NULL
             AND (
               run.state = 'queued'
               OR EXISTS (
                 SELECT 1 FROM cp_hosted_attempt attempt
                 WHERE attempt.organization_id = run.organization_id
                   AND attempt.run_id = run.run_id
                   AND attempt.attempt_number = run.current_attempt_number
                   AND attempt.lease_expires_at <= $3
                   AND NOT EXISTS (
                     SELECT 1 FROM cp_material_action_receipt material
                     WHERE material.organization_id = attempt.organization_id
                       AND material.run_id = attempt.run_id
                       AND material.attempt_id = attempt.attempt_id
                   )
               )
             )
           ORDER BY run.created_at, run.run_id
           FOR UPDATE OF run SKIP LOCKED
           LIMIT 1`,
          [principal.organizationId, principal.runnerId, now.toISOString()],
        ) as { rows: HostedRunRow[] };
        const run = candidate.rows[0];
        if (!run) return { kind: "empty" } as const;

        const admission = HostedAdmissionEnvelopeV1Schema.parse(
          run.hosted_admission,
        );
        const policy = AdmissionPolicySnapshotReceiptEnvelopeV1Schema.parse(
          run.admission_policy_snapshot,
        );
        if (run.current_attempt_number > 0) {
          await client.query(
            `UPDATE cp_hosted_attempt
             SET state = 'expired', updated_at = $4
             WHERE organization_id = $1 AND run_id = $2
               AND attempt_number = $3 AND state IN ('claimed', 'running')`,
            [
              principal.organizationId,
              run.run_id,
              run.current_attempt_number,
              now.toISOString(),
            ],
          );
        }

        const attemptNumber = run.current_attempt_number + 1;
        const attemptId = input.idFactory("attempt");
        const fencingToken = input.tokenFactory({
          organizationId: principal.organizationId,
          operationId: request.operationId,
          runId: run.run_id,
          attemptId,
          attemptNumber,
        });
        const fencingTokenDigest = await computeHostedClaimFencingTokenDigestV1(
          fencingToken,
        );
        const leaseExpiresAt = new Date(
          now.getTime() + input.leaseDurationMs,
        ).toISOString();
        const sourceContentGrant = await input.issueSourceContentGrantInTransaction(
          client as PoolClient, {
            organizationId: principal.organizationId, runId: run.run_id,
            attemptId, fenceDigest: fencingTokenDigest, contentIds: run.source_content_ids,
            purpose: "source_context", expiresAt: new Date(leaseExpiresAt),
          },
        );
        const claim = HostedClaimV1Schema.parse({
          kind: "hosted_claim",
          schemaVersion: 1,
          protocolVersion: "1.0",
          requiredCapabilities: request.requiredCapabilities,
          requestId: request.requestId,
          operationId: request.operationId,
          organizationId: principal.organizationId,
          runnerId: principal.runnerId,
          runId: run.run_id,
          executorId: run.executor_id,
          hostedAdmission: admission,
          admissionPolicySnapshot: policy,
          attempt: {
            id: attemptId,
            number: attemptNumber,
            epoch: attemptNumber,
            fencingToken,
            fencingTokenDigest,
            leaseExpiresAt,
          },
          sourceContentGrant,
          authority: {
            organizationId: principal.organizationId,
            runnerId: principal.runnerId,
            runId: run.run_id,
            credentialId: principal.credentialId,
            registrationGeneration: principal.registrationGeneration,
            credentialGeneration: principal.credentialGeneration,
            projectTargetId: admission.projectTarget.projectTargetId,
            bindingId: admission.bindingId,
            targetBindingDigest: admission.projectTarget.digest,
            admissionPolicyReceiptId: policy.receiptId,
            admissionPolicySnapshotId: policy.payload.snapshotId,
            admissionPolicySnapshotDigest: policy.receiptDigest,
            runnerReadinessReceiptId:
              request.expectedAuthority.runnerReadinessReceiptId,
            runnerReadinessReceiptDigest:
              request.expectedAuthority.runnerReadinessReceiptDigest,
            targetReadinessReceiptId:
              request.expectedAuthority.runnerReadinessReceiptId,
            targetReadinessReceiptDigest:
              request.expectedAuthority.runnerReadinessReceiptDigest,
            executorId: run.executor_id,
            executorCapabilityDigest: policy.payload.executor.capabilityDigest,
            attemptId,
            attemptNumber,
            epoch: attemptNumber,
            fencingTokenDigest,
          },
        });
        await client.query(
          `INSERT INTO cp_hosted_attempt(
             organization_id, run_id, attempt_number, attempt_id, runner_id,
             credential_id, fencing_token_digest, lease_expires_at, state,
             claimed_at, updated_at
           ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, 'claimed', $9, $9)`,
          [
            principal.organizationId,
            run.run_id,
            attemptNumber,
            attemptId,
            principal.runnerId,
            principal.credentialId,
            fencingTokenDigest,
            leaseExpiresAt,
            now.toISOString(),
          ],
        );
        await client.query(
          `UPDATE cp_hosted_run
           SET state = 'assigned', current_attempt_number = $3, updated_at = $4
           WHERE organization_id = $1 AND run_id = $2`,
          [principal.organizationId, run.run_id, attemptNumber, now.toISOString()],
        );
        await client.query(
          `INSERT INTO cp_hosted_claim(
             organization_id, operation_id, request_digest, run_id, claim,
             created_at
           ) VALUES($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            principal.organizationId,
            request.operationId,
            requestDigest,
            run.run_id,
            JSON.stringify(claimForStorage(claim)),
            now.toISOString(),
          ],
        );
        await client.query(
          `INSERT INTO cp_hosted_audit_event(
             organization_id, run_id, event_kind, event, created_at
           ) VALUES($1, $2, 'claimed', $3::jsonb, $4)`,
          [
            principal.organizationId,
            run.run_id,
            JSON.stringify({
              runId: run.run_id,
              attemptId,
              attemptNumber,
              fencingTokenDigest,
            }),
            now.toISOString(),
          ],
        );
        return { kind: "claimed", claim } as const;
      });
    },

    async lifecycle(command) {
      const request = command.request;
      const expectedDigest = await computeHostedLifecycleRequestDigestV1({
        organizationId: command.principal.organizationId,
        runnerId: command.principal.runnerId,
        runId: command.runId,
        action: command.action,
        request,
      });
      if (
        request.requestDigest !== expectedDigest
        || request.attempt.fencingTokenDigest
          !== await computeHostedClaimFencingTokenDigestV1(
            request.attempt.fencingToken,
          )
      ) {
        return { kind: "conflict", reason: "invalid_request" };
      }

      return withPostgresTransaction(input.pool, async (client) => {
        const existing = await client.query(
          `SELECT request_digest, action, receipt
           FROM cp_hosted_lifecycle_receipt
           WHERE organization_id = $1 AND operation_id = $2`,
          [command.principal.organizationId, request.operationId],
        ) as {
          rows: Array<{ request_digest: string; action: string; receipt: unknown }>;
        };
        const replay = existing.rows[0];
        if (replay) {
          if (
            replay.request_digest !== request.requestDigest
            || replay.action !== lifecycleOperation(command.action)
          ) {
            return { kind: "conflict", reason: "operation_mismatch" } as const;
          }
          return {
            kind: "replayed",
            receipt: HostedLifecycleReceiptEnvelopeV1Schema.parse(replay.receipt),
          } as const;
        }

        const runResult = await client.query(
          `SELECT * FROM cp_hosted_run
           WHERE organization_id = $1 AND run_id = $2
           FOR UPDATE`,
          [command.principal.organizationId, command.runId],
        ) as { rows: HostedRunRow[] };
        const run = runResult.rows[0];
        if (!run) return { kind: "stale_fence" } as const;

        const receiptAfterRunLock = await client.query(
          `SELECT request_digest, action, receipt
           FROM cp_hosted_lifecycle_receipt
           WHERE organization_id = $1 AND operation_id = $2`,
          [command.principal.organizationId, request.operationId],
        ) as {
          rows: Array<{
            request_digest: string;
            action: string;
            receipt: unknown;
          }>;
        };
        const replayAfterRunLock = receiptAfterRunLock.rows[0];
        if (replayAfterRunLock) {
          if (
            replayAfterRunLock.request_digest !== request.requestDigest
            || replayAfterRunLock.action !== lifecycleOperation(command.action)
          ) {
            return { kind: "conflict", reason: "operation_mismatch" } as const;
          }
          return {
            kind: "replayed",
            receipt: HostedLifecycleReceiptEnvelopeV1Schema.parse(
              replayAfterRunLock.receipt,
            ),
          } as const;
        }
        const settled = terminalKind(run.state);
        if (settled) return { kind: "terminal", terminalKind: settled } as const;

        const attemptResult = await client.query(
          `SELECT attempt_number, attempt_id, runner_id, credential_id,
                  fencing_token_digest, lease_expires_at, state
           FROM cp_hosted_attempt
           WHERE organization_id = $1 AND run_id = $2
             AND attempt_number = $3
           FOR UPDATE`,
          [
            command.principal.organizationId,
            command.runId,
            run.current_attempt_number,
          ],
        ) as { rows: HostedAttemptRow[] };
        const attempt = attemptResult.rows[0];
        const now = input.clock.now();
        if (
          !attempt
          || attempt.attempt_id !== request.attempt.attemptId
          || attempt.attempt_number !== request.attempt.attemptNumber
          || attempt.runner_id !== command.principal.runnerId
          || attempt.credential_id !== command.principal.credentialId
          || attempt.fencing_token_digest !== request.attempt.fencingTokenDigest
          || attempt.lease_expires_at.getTime() <= now.getTime()
        ) {
          return { kind: "stale_fence" } as const;
        }

        const operation = lifecycleOperation(command.action);
        let leaseExpiresAt: string | undefined;
        let payload: HostedLifecycleReceiptEnvelopeV1["payload"];
        if (command.action === "heartbeat") {
          const heartbeat = HostedHeartbeatRequestV1Schema.parse(request);
          if (
            heartbeat.expectedLeaseExpiresAt
              !== attempt.lease_expires_at.toISOString()
          ) {
            return { kind: "stale_fence" } as const;
          }
          leaseExpiresAt = new Date(
            now.getTime() + input.leaseDurationMs,
          ).toISOString();
          payload = {
            operation: "heartbeat",
            occurredAt: heartbeat.occurredAt,
            leaseExpiresAt,
          };
        } else if (command.action === "running") {
          const running = HostedRunningRequestV1Schema.parse(request);
          if (running.executorId !== run.executor_id) {
            return { kind: "conflict", reason: "invalid_request" } as const;
          }
          payload = {
            operation: "running",
            occurredAt: running.occurredAt,
            executorId: running.executorId,
            executorCapabilityDigest: running.executorCapabilityDigest,
            ...(running.runTimeoutMs
              ? { runTimeoutMs: running.runTimeoutMs }
              : {}),
          };
        } else if (command.action === "progress") {
          const progress = HostedProgressRequestV1Schema.parse(request);
          payload = {
            operation: "progress",
            occurredAt: progress.occurredAt,
            progressId: progress.progressId,
            progressDigest: progress.progressDigest,
          };
        } else if (command.action === "reject-start") {
          const rejected = HostedRejectStartRequestV1Schema.parse(request);
          payload = {
            operation: "reject_start",
            occurredAt: rejected.occurredAt,
            executorId: rejected.executorId,
            reasonCode: rejected.reasonCode,
          };
        } else if (command.action === "cancel") {
          const cancelled = HostedCancelRequestV1Schema.parse(request);
          payload = {
            operation: "cancel",
            occurredAt: cancelled.occurredAt,
            reasonCode: cancelled.reasonCode,
          };
        } else {
          const complete = HostedCompleteRequestV1Schema.parse(request);
          payload = {
            operation: "executor_result",
            occurredAt: complete.occurredAt,
            conclusion: complete.conclusion,
            reasonCode: complete.reasonCode,
            resultDigest: complete.resultDigest,
            artifactDigests: complete.artifactDigests,
            evidenceDigests: complete.evidenceDigests,
          };
        }

        const payloadDigest = await computeControlPayloadDigestV1(payload);
        const receiptSeed = {
          schemaVersion: 1 as const,
          protocolVersion: "1.0" as const,
          receiptKind: "attempt_lifecycle" as const,
          receiptId: await computeHostedLifecycleReceiptIdV1({
            organizationId: command.principal.organizationId,
            operationId: request.operationId,
          }),
          organizationId: command.principal.organizationId,
          requestId: request.requestId,
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          requiredCapabilities: request.requiredCapabilities,
          producer: {
            kind: "runner" as const,
            id: command.principal.runnerId,
            credentialId: command.principal.credentialId,
          },
          identity: {
            namespace: "opentag.control.receipt/attempt-lifecycle/v1" as const,
            parts: [
              command.principal.organizationId,
              command.runId,
              request.attempt.attemptId,
              operation,
              request.operationId,
            ],
          },
          observedAt: now.toISOString(),
          payloadDigest,
          receiptDigest: `sha256:${"0".repeat(64)}`,
          runId: command.runId,
          attempt: {
            attemptId: request.attempt.attemptId,
            attemptNumber: request.attempt.attemptNumber,
            epoch: request.attempt.epoch,
            fencingTokenDigest: request.attempt.fencingTokenDigest,
          },
          payload,
        };
        const { receiptDigest: _receiptDigest, ...receiptDigestInput } =
          receiptSeed;
        const receipt = HostedLifecycleReceiptEnvelopeV1Schema.parse({
          ...receiptSeed,
          receiptDigest: await computeControlReceiptDigestV1(
            receiptDigestInput,
          ),
        });

        let nextRunState: HostedRunRow["state"] = run.state;
        let nextAttemptState = attempt.state;
        let nextTerminal: TerminalKind | null = null;
        if (command.action === "running") {
          nextRunState = "running";
          nextAttemptState = "running";
        } else if (command.action === "reject-start") {
          nextRunState = "failed";
          nextAttemptState = "rejected";
          nextTerminal = "failed";
        } else if (command.action === "complete") {
          const conclusion = HostedCompleteRequestV1Schema.parse(request).conclusion;
          const completion = {
            success: ["succeeded", "completed", "succeeded"],
            failure: ["failed", "rejected", "failed"],
            cancelled: ["cancelled", "cancelled", "cancelled"],
            interrupted: ["interrupted", "interrupted", "interrupted"],
            timed_out: ["timed_out", "timed_out", "timed_out"],
            needs_human: ["needs_approval", "needs_approval", null],
          } as const satisfies Record<typeof conclusion,
            readonly [CanonicalRunStatus, string, TerminalKind | null]>;
          [nextRunState, nextAttemptState, nextTerminal] = completion[conclusion];
        } else if (command.action === "cancel") {
          nextRunState = "cancelled";
          nextAttemptState = "cancelled";
          nextTerminal = "cancelled";
        }
        await client.query(
          `INSERT INTO cp_hosted_lifecycle_receipt(
             organization_id, operation_id, request_id, request_digest,
             run_id, attempt_id, action, receipt, created_at
           ) VALUES($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
          [
            command.principal.organizationId,
            request.operationId,
            request.requestId,
            request.requestDigest,
            command.runId,
            request.attempt.attemptId,
            operation,
            JSON.stringify(receipt),
            now.toISOString(),
          ],
        );
        await client.query(
          `UPDATE cp_hosted_attempt
           SET state = $4,
               lease_expires_at = COALESCE($5, lease_expires_at),
               updated_at = $6
           WHERE organization_id = $1 AND run_id = $2
             AND attempt_number = $3`,
          [
            command.principal.organizationId,
            command.runId,
            attempt.attempt_number,
            nextAttemptState,
            leaseExpiresAt ?? null,
            now.toISOString(),
          ],
        );
        await client.query(
          `UPDATE cp_hosted_run
           SET state = $3,
               terminal_kind = $4,
               terminal_receipt = $5::jsonb,
               updated_at = $6
           WHERE organization_id = $1 AND run_id = $2`,
          [
            command.principal.organizationId,
            command.runId,
            nextRunState,
            nextTerminal,
            nextTerminal ? JSON.stringify(receipt) : null,
            now.toISOString(),
          ],
        );
        await client.query(
          `INSERT INTO cp_hosted_audit_event(
             organization_id, run_id, event_kind, event, created_at
           ) VALUES($1, $2, $3, $4::jsonb, $5)`,
          [
            command.principal.organizationId,
            command.runId,
            operation,
            JSON.stringify({
              runId: command.runId,
              attemptId: attempt.attempt_id,
              operationId: request.operationId,
              receiptDigest: receipt.receiptDigest,
            }),
            now.toISOString(),
          ],
        );
        return { kind: "accepted", receipt } as const;
      });
    },

    async expireQueued(organizationId: string | null) {
      const now = input.clock.now();
      const result = await input.pool.query(
        `UPDATE cp_hosted_run
         SET state = 'timed_out', terminal_kind = 'timed_out',
             terminal_reason = 'queue_claim_deadline_expired',
             terminal_receipt = jsonb_build_object(
               'kind', 'queue_claim_expired', 'reason', 'queue_claim_deadline_expired',
               'recordedAt', $1::text
             ), updated_at = $1
         WHERE state = 'queued' AND terminal_kind IS NULL
           AND queue_claim_deadline <= $1
           AND ($2::text IS NULL OR organization_id = $2)
         RETURNING run_id`,
        [now.toISOString(), organizationId],
      );
      return { expired: result.rowCount ?? 0 };
    },

    async cancelRun(command) {
      return withPostgresTransaction(input.pool, async (client) => {
        const selected = await client.query<HostedRunRow>(
          `SELECT * FROM cp_hosted_run WHERE organization_id = $1 AND run_id = $2
           FOR UPDATE`,
          [command.organizationId, command.runId],
        );
        const run = selected.rows[0];
        if (!run) return { kind: "missing" } as const;
        if (run.terminal_kind) return { kind: "terminal" } as const;
        const now = input.clock.now().toISOString();
        await client.query(
          `UPDATE cp_hosted_attempt SET state = 'cancelled', updated_at = $3
           WHERE organization_id = $1 AND run_id = $2
             AND attempt_number = (SELECT current_attempt_number FROM cp_hosted_run
               WHERE organization_id = $1 AND run_id = $2)
             AND state IN ('claimed','running')`,
          [command.organizationId, command.runId, now],
        );
        await client.query(
          `UPDATE cp_source_content_read_grant
           SET revoked_at = COALESCE(revoked_at, $3)
           WHERE organization_id = $1 AND run_id = $2 AND consumed_at IS NULL`,
          [command.organizationId, command.runId, now],
        );
        await client.query(
          `UPDATE cp_hosted_run SET state = 'cancelled', terminal_kind = 'cancelled',
             terminal_reason = $3, terminal_receipt = $4::jsonb, updated_at = $5
           WHERE organization_id = $1 AND run_id = $2`,
          [command.organizationId, command.runId, command.reason,
            JSON.stringify({ kind: "run_cancelled", reason: command.reason, recordedAt: now }), now],
        );
        return { kind: "cancelled" } as const;
      });
    },

    async invalidate(command) {
      return withPostgresTransaction(input.pool, (client) =>
        invalidateInTransaction(client as PoolClient, command));
    },

    invalidateInTransaction,

    async reconcileExpiredAttempts(organizationId: string | null) {
      const now = input.clock.now();
      return withPostgresTransaction(input.pool, async (client) => {
        const candidates = await client.query<{ organization_id: string; run_id: string;
          current_attempt_number: number }>(
          `SELECT run.organization_id, run.run_id, run.current_attempt_number
           FROM cp_hosted_run run
           JOIN cp_hosted_attempt attempt
             ON attempt.organization_id = run.organization_id
            AND attempt.run_id = run.run_id
            AND attempt.attempt_number = run.current_attempt_number
           WHERE attempt.state IN ('claimed','running')
             AND attempt.lease_expires_at <= $1 AND run.terminal_kind IS NULL
             AND ($2::text IS NULL OR run.organization_id = $2)
           ORDER BY run.organization_id, run.run_id
           FOR UPDATE OF run SKIP LOCKED LIMIT 100`,
          [now, organizationId],
        );
        let expired = 0;
        for (const run of candidates.rows) {
          const attemptResult = await client.query<{ attempt_id: string }>(
            `SELECT attempt_id FROM cp_hosted_attempt
             WHERE organization_id = $1 AND run_id = $2 AND attempt_number = $3
               AND state IN ('claimed','running') AND lease_expires_at <= $4
             FOR UPDATE`,
            [run.organization_id, run.run_id, run.current_attempt_number, now],
          );
          const attempt = attemptResult.rows[0];
          if (!attempt) continue;
          await client.query(
            `UPDATE cp_hosted_attempt SET state = 'expired', updated_at = $4
             WHERE organization_id = $1 AND run_id = $2 AND attempt_number = $3`,
            [run.organization_id, run.run_id, run.current_attempt_number, now],
          );
          expired += 1;
          const material = await classifyAttemptMaterialActionTruth(client, {
            organizationId: run.organization_id, runId: run.run_id,
            attemptId: attempt.attempt_id,
          });
          if (material.kind === "started_or_ambiguous") await client.query(
            `UPDATE cp_hosted_run SET state = 'interrupted', terminal_kind = 'interrupted',
               terminal_reason = 'attempt_lease_expired_after_material_start',
               outcome_state = 'outcome_unknown', reconciliation_identity = $3,
               terminal_receipt = $4::jsonb, updated_at = $5
             WHERE organization_id = $1 AND run_id = $2 AND terminal_kind IS NULL`,
            [run.organization_id, run.run_id,
              material.reconciliationIdentity,
              JSON.stringify({ kind: "attempt_interrupted", outcome: "outcome_unknown" }), now],
          );
          else await client.query(
            `UPDATE cp_hosted_run
             SET state = CASE WHEN state = 'running' THEN 'interrupted' ELSE 'timed_out' END,
                 terminal_kind = CASE WHEN state = 'running' THEN 'interrupted' ELSE 'timed_out' END,
                 terminal_reason = 'original_claim_deadline_expired',
                 terminal_receipt = jsonb_build_object(
                   'kind', 'attempt_deadline_expired',
                   'reason', 'original_claim_deadline_expired',
                   'recordedAt', $3::text
                 ), updated_at = $3
             WHERE organization_id = $1 AND run_id = $2 AND terminal_kind IS NULL
               AND queue_claim_deadline <= $3`,
            [run.organization_id, run.run_id, now.toISOString()],
          );
        }
        return { expired };
      });
    },

    async inspect(query) {
      const result = await input.pool.query<HostedRunRow & {
        terminal_reason: string | null;
        publication_mode: string;
      }>(
        `SELECT * FROM cp_hosted_run
         WHERE organization_id = $1 AND run_id = $2`,
        [query.organizationId, query.runId],
      );
      const row = result.rows[0];
      return row ? { state: row.state, terminalKind: row.terminal_kind,
        terminalReason: row.terminal_reason, ...projectRun(row) } : null;
    },
  };
}
