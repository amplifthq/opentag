import {
  AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeMaterialActionFencingTokenDigestV1,
  computeMaterialActionPayloadDigestV1,
  computeMaterialActionReceiptDigestV1,
  computePermissionRequestDigestV1,
  HOSTED_PUBLICATION_ACTION_CAPABILITIES_V1,
  HostedAdmissionEnvelopeV1Schema,
  MaterialActionReceiptEnvelopeV1Schema,
  PermissionRequestDigestInputV1Schema,
  PermissionResolutionReceiptEnvelopeV1Schema,
  ReceiptDigestSchema,
  RunnerMaterialActionReconcileRequestV1Schema,
  type MaterialActionReceiptEnvelopeV1,
  type MaterialActionBeginAuthorityV1,
  type RunnerMaterialActionBeginV1,
  type RunnerMaterialActionReconcileRequestV1,
} from "@opentag/control-protocol";
import type { Pool } from "pg";
import { withPostgresTransaction } from "../../database/postgres.js";
import type { RuntimePrincipal } from "../runners/index.js";

type Clock = { now(): Date };
export type AttemptMaterialActionTruth =
  | { kind: "proven_not_started" }
  | { kind: "started_or_ambiguous"; reconciliationIdentity: string };

export async function classifyAttemptMaterialActionTruth(
  client: { query<Row extends Record<string, unknown>>(text: string,
    values?: readonly unknown[]): Promise<{ rows: Row[] }> },
  input: { organizationId: string; runId: string; attemptId: string },
): Promise<AttemptMaterialActionTruth> {
  const attempt = await client.query<{ material_start_state: string; state: string;
    fencing_token_digest: string }>(
    `SELECT material_start_state, state, fencing_token_digest FROM cp_hosted_attempt
     WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3`,
    [input.organizationId, input.runId, input.attemptId],
  );
  const attemptRow = attempt.rows[0];
  if (!attemptRow) {
    return { kind: "started_or_ambiguous",
      reconciliationIdentity: `${input.organizationId}:${input.runId}:${input.attemptId}:material_start_unknown` };
  }
  const result = await client.query<{ receipt_id: string | null; has_evidence: boolean }>(
    `SELECT (SELECT receipt_id FROM cp_material_action_receipt
       WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3
       ORDER BY created_at, receipt_id LIMIT 1) AS receipt_id,
      (EXISTS (SELECT 1 FROM cp_material_action_receipt
         WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3)
       OR EXISTS (SELECT 1 FROM cp_material_action_begin_intent
         WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3)) AS has_evidence`,
    [input.organizationId, input.runId, input.attemptId],
  );
  if (attemptRow.material_start_state === "started_or_ambiguous"
    || result.rows[0]?.has_evidence) {
    return { kind: "started_or_ambiguous",
      reconciliationIdentity: result.rows[0]?.receipt_id
        ? `${input.organizationId}:${input.runId}:${result.rows[0].receipt_id}`
        : `${input.organizationId}:${input.runId}:${input.attemptId}:material_start_unknown` };
  }
  if (attemptRow.material_start_state === "open" && attemptRow.state === "succeeded") {
    return { kind: "proven_not_started" };
  }
  if (attemptRow.material_start_state === "open") return {
    kind: "started_or_ambiguous",
    reconciliationIdentity: `${input.organizationId}:${input.runId}:${input.attemptId}:material_start_unknown`,
  };
  const proof = await client.query<{ proof_id: string }>(
    `SELECT proof_id FROM cp_material_action_non_start_proof
     WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3
       AND fencing_token_digest = $4`,
    [input.organizationId, input.runId, input.attemptId, attemptRow.fencing_token_digest],
  );
  return proof.rows[0]
    ? { kind: "proven_not_started" }
    : { kind: "started_or_ambiguous",
        reconciliationIdentity: `${input.organizationId}:${input.runId}:${input.attemptId}:material_start_unknown` };
}
type CurrentReceipt = {
  receipt_id: string;
  receipt_digest: string;
  outcome: "succeeded" | "failed" | "outcome_unknown";
  receipt: unknown;
};

const StoredPermissionRequestV1Schema = PermissionRequestDigestInputV1Schema.extend({
  permissionRequestDigest: ReceiptDigestSchema,
});

export type MaterialActionCoordinator = {
  begin(input: { principal: RuntimePrincipal; fencingToken: string;
    runId: string; attemptId: string; attemptNumber: number;
    actionId: string;
    actionDescriptor: RunnerMaterialActionBeginV1["actionDescriptor"];
    actionDescriptorDigest: string;
    targetFingerprint: string; policySnapshotRef: string; policySnapshotDigest: string;
    workspaceAttestationDigest?: string;
    authority: MaterialActionBeginAuthorityV1;
    idempotencyKey: string }): Promise<
      { kind: "begun" | "replayed" } | { kind: "stale_fence" | "conflict" }
    >;
  recordNotStarted(input: {
    principal: RuntimePrincipal;
    fencingToken: string;
    fencingTokenDigest?: string;
    runId: string;
    attemptId: string;
    attemptNumber: number;
    proofId: string;
    proofDigest: string;
  }): Promise<{ kind: "recorded" | "replayed" } | { kind: "stale_fence" | "conflict" }>;
  record(input: {
    principal: RuntimePrincipal;
    fencingToken: string;
    receipt: MaterialActionReceiptEnvelopeV1;
  }): Promise<
    | { kind: "recorded" | "replayed"; receipt: MaterialActionReceiptEnvelopeV1 }
    | { kind: "stale_fence" | "conflict" }
  >;
  reconcile(input: {
    principal: RuntimePrincipal;
    request: RunnerMaterialActionReconcileRequestV1;
  }): Promise<
    | {
        kind: "resolved" | "outcome_unknown";
        receipt: MaterialActionReceiptEnvelopeV1;
      }
    | { kind: "stale_fence" | "conflict" | "missing" }
  >;
};

async function currentAttemptMatches(
  client: { query(text: string, values?: readonly unknown[]): Promise<unknown> },
  input: {
    principal: RuntimePrincipal;
    runId: string;
    attemptId: string;
    attemptNumber: number;
    fencingTokenDigest: string;
    now: Date;
    materialStartState?: "open" | "material_allowed" | "begin_allowed";
    allowNeedsApproval?: boolean;
  },
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM cp_hosted_run run
     JOIN cp_hosted_attempt attempt
       ON attempt.organization_id = run.organization_id
      AND attempt.run_id = run.run_id
      AND attempt.attempt_number = run.current_attempt_number
     WHERE run.organization_id = $1 AND run.run_id = $2
       AND run.runner_id = $3 AND run.terminal_kind IS NULL
       AND attempt.attempt_id = $4 AND attempt.attempt_number = $5
       AND attempt.fencing_token_digest = $6
       AND attempt.credential_id = $7
       AND attempt.lease_expires_at > $8
       AND ((run.state IN ('assigned','running') AND attempt.state IN ('claimed','running'))
         OR ($10::boolean AND run.state = 'needs_approval'
           AND attempt.state = 'needs_approval'))
       AND ($9::text IS NULL
         OR ($9 = 'open' AND attempt.material_start_state = 'open')
         OR ($9 = 'material_allowed'
           AND attempt.material_start_state IN ('open','started_or_ambiguous'))
         OR ($9 = 'begin_allowed'
           AND attempt.material_start_state IN ('open','started_or_ambiguous')))
     FOR UPDATE OF run, attempt`,
    [
      input.principal.organizationId,
      input.runId,
      input.principal.runnerId,
      input.attemptId,
      input.attemptNumber,
      input.fencingTokenDigest,
      input.principal.credentialId,
      input.now,
      input.materialStartState ?? null,
      input.allowNeedsApproval ?? false,
    ],
  ) as { rows: unknown[] };
  return result.rows.length === 1;
}

const publicationCapabilities = new Set<string>(
  HOSTED_PUBLICATION_ACTION_CAPABILITIES_V1,
);

async function closeProvenNotStartedAuthority(
  client: { query(text: string, values?: readonly unknown[]): Promise<unknown> },
  command: { organizationId: string; runId: string; attemptId: string;
    attemptNumber: number; fencingTokenDigest: string },
  recordedAt: Date,
) {
  await client.query(
    `UPDATE cp_hosted_attempt SET material_start_state = 'proven_not_started',
       state = 'expired', lease_expires_at = LEAST(lease_expires_at, $6),
       blocked_permission_request_id = NULL, blocked_action_descriptor_digest = NULL,
       blocked_policy_snapshot_digest = NULL, updated_at = $6
     WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3
       AND attempt_number = $4 AND fencing_token_digest = $5
       AND material_start_state IN ('open','proven_not_started')`,
    [command.organizationId, command.runId, command.attemptId,
      command.attemptNumber, command.fencingTokenDigest, recordedAt],
  );
  await client.query(
    `UPDATE cp_hosted_run SET state = 'assigned', updated_at = $4
     WHERE organization_id = $1 AND run_id = $2 AND current_attempt_number = $3
       AND terminal_kind IS NULL
       AND EXISTS (SELECT 1 FROM cp_hosted_attempt attempt
         WHERE attempt.organization_id = cp_hosted_run.organization_id
           AND attempt.run_id = cp_hosted_run.run_id
           AND attempt.attempt_number = cp_hosted_run.current_attempt_number
           AND attempt.attempt_id = $5
           AND attempt.material_start_state = 'proven_not_started')`,
    [command.organizationId, command.runId, command.attemptNumber,
      recordedAt, command.attemptId],
  );
  await client.query(
    `UPDATE cp_source_content_read_grant SET revoked_at = COALESCE(revoked_at, $4)
     WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3
       AND consumed_at IS NULL`,
    [command.organizationId, command.runId, command.attemptId, recordedAt],
  );
  await client.query(
    `UPDATE cp_permission_request SET state = 'revoked', updated_at = $4
     WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3
       AND state = 'waiting'`,
    [command.organizationId, command.runId, command.attemptId, recordedAt],
  );
}

function exactPredecessor(
  receipt: MaterialActionReceiptEnvelopeV1,
  current: CurrentReceipt | undefined,
): boolean {
  const predecessors = receipt.predecessorReceiptDigests ?? [];
  return current
    ? predecessors.length === 1 && predecessors[0] === current.receipt_digest
    : predecessors.length === 0;
}

export function createMaterialActionCoordinator(input: {
  pool: Pool;
  clock: Clock;
}): MaterialActionCoordinator {
  return {
    async recordNotStarted(command) {
      if (!command.proofId || !/^sha256:[a-f0-9]{64}$/u.test(command.proofDigest)) {
        return { kind: "conflict" };
      }
      const fencingTokenDigest = await computeMaterialActionFencingTokenDigestV1(
        command.fencingToken,
      );
      if (command.fencingTokenDigest !== undefined
        && command.fencingTokenDigest !== fencingTokenDigest) return { kind: "conflict" };
      try {
        return await withPostgresTransaction(input.pool, async (client) => {
        const existing = await client.query<{ fencing_token_digest: string;
          proof_id: string; proof_digest: string; material_start_state: string;
          has_evidence: boolean }>(
          `SELECT proof.fencing_token_digest, proof.proof_id, proof.proof_digest,
                  attempt.material_start_state,
                  (EXISTS (SELECT 1 FROM cp_material_action_receipt receipt
                    WHERE receipt.organization_id = proof.organization_id
                      AND receipt.run_id = proof.run_id AND receipt.attempt_id = proof.attempt_id)
                   OR EXISTS (SELECT 1 FROM cp_material_action_begin_intent begin_intent
                    WHERE begin_intent.organization_id = proof.organization_id
                      AND begin_intent.run_id = proof.run_id
                      AND begin_intent.attempt_id = proof.attempt_id)) AS has_evidence
           FROM cp_material_action_non_start_proof proof
           JOIN cp_hosted_attempt attempt
             ON attempt.organization_id = proof.organization_id
            AND attempt.run_id = proof.run_id AND attempt.attempt_id = proof.attempt_id
           WHERE proof.organization_id = $1 AND proof.run_id = $2 AND proof.attempt_id = $3
           FOR UPDATE OF attempt`,
          [command.principal.organizationId, command.runId, command.attemptId],
        );
        if (existing.rows[0]) {
          const replay = existing.rows[0];
          if (replay.fencing_token_digest !== fencingTokenDigest
            || replay.proof_id !== command.proofId || replay.proof_digest !== command.proofDigest
            || replay.has_evidence || replay.material_start_state === "started_or_ambiguous") {
            return { kind: "conflict" as const };
          }
          await closeProvenNotStartedAuthority(client, {
            organizationId: command.principal.organizationId,
            runId: command.runId,
            attemptId: command.attemptId,
            attemptNumber: command.attemptNumber,
            fencingTokenDigest,
          }, input.clock.now());
          return { kind: "replayed" as const };
        }
        if (!(await currentAttemptMatches(client, {
          principal: command.principal, runId: command.runId,
          attemptId: command.attemptId, attemptNumber: command.attemptNumber,
          fencingTokenDigest, now: input.clock.now(),
          materialStartState: "open",
          allowNeedsApproval: true,
        }))) return { kind: "stale_fence" as const };
        await client.query(
          `INSERT INTO cp_material_action_non_start_proof(
             organization_id, run_id, attempt_id, attempt_number,
             fencing_token_digest, proof_id, proof_digest, recorded_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [command.principal.organizationId, command.runId, command.attemptId,
            command.attemptNumber, fencingTokenDigest, command.proofId,
            command.proofDigest, input.clock.now()],
        );
        await closeProvenNotStartedAuthority(client, {
          organizationId: command.principal.organizationId,
          runId: command.runId,
          attemptId: command.attemptId,
          attemptNumber: command.attemptNumber,
          fencingTokenDigest,
        }, input.clock.now());
          return { kind: "recorded" as const };
        });
      } catch (error) {
        if (error instanceof Error
          && error.message.includes("material_non_start_proof_conflict")) {
          return { kind: "stale_fence" as const };
        }
        throw error;
      }
    },

    async begin(command) {
      if (command.actionDescriptorDigest
        !== await computeControlPayloadDigestV1(command.actionDescriptor)
        || !command.actionId || !command.idempotencyKey) return { kind: "conflict" };
      const fencingTokenDigest = await computeMaterialActionFencingTokenDigestV1(
        command.fencingToken,
      );
      return withPostgresTransaction(input.pool, async (client) => {
        const authorityResult = await client.query<{
          hosted_admission: unknown; admission_policy_snapshot: unknown;
          publication_mode: string; run_state: string; terminal_kind: string | null;
          attempt_state: string; material_start_state: string; credential_id: string;
          fencing_token_digest: string; lease_expires_at: Date;
          workspace_attestation: unknown | null;
        }>(
          `SELECT run.hosted_admission, run.admission_policy_snapshot,
                  run.publication_mode, run.state AS run_state, run.terminal_kind,
                  attempt.state AS attempt_state, attempt.material_start_state,
                  attempt.credential_id, attempt.fencing_token_digest,
                  attempt.lease_expires_at, attempt.workspace_attestation
           FROM cp_hosted_run run JOIN cp_hosted_attempt attempt
             ON attempt.organization_id = run.organization_id
            AND attempt.run_id = run.run_id
            AND attempt.attempt_number = run.current_attempt_number
           WHERE run.organization_id = $1 AND run.run_id = $2
             AND run.runner_id = $3 AND attempt.attempt_id = $4
             AND attempt.attempt_number = $5
           FOR UPDATE OF run, attempt`,
          [command.principal.organizationId, command.runId,
            command.principal.runnerId, command.attemptId, command.attemptNumber],
        );
        const current = authorityResult.rows[0];
        if (!current || current.terminal_kind !== null
          || current.credential_id !== command.principal.credentialId
          || current.fencing_token_digest !== fencingTokenDigest
          || current.lease_expires_at.getTime() <= input.clock.now().getTime()
          || !["assigned", "running"].includes(current.run_state)
          || !["claimed", "running"].includes(current.attempt_state)
          || !["open", "started_or_ambiguous"].includes(current.material_start_state)) {
          return { kind: "stale_fence" as const };
        }
        const currentWorkspaceAttestationDigest = current.workspace_attestation
          ? await computeControlPayloadDigestV1(current.workspace_attestation)
          : undefined;
        if (!currentWorkspaceAttestationDigest || !command.workspaceAttestationDigest
          || !command.authority.workspaceAttestationDigest
          || command.workspaceAttestationDigest !== currentWorkspaceAttestationDigest
          || command.authority.workspaceAttestationDigest !== currentWorkspaceAttestationDigest) {
          return { kind: "conflict" as const };
        }
        const admission = HostedAdmissionEnvelopeV1Schema.parse(current.hosted_admission);
        const policy = AdmissionPolicySnapshotReceiptEnvelopeV1Schema.parse(
          current.admission_policy_snapshot,
        );
        const { receiptDigest: _policyReceiptDigest, ...policyReceiptDigestInput } = policy;
        if (policy.payloadDigest !== await computeControlPayloadDigestV1(policy.payload)
          || policy.receiptDigest !== await computeControlReceiptDigestV1(
            policyReceiptDigestInput,
          )
          || admission.permissionCeiling.digest !== await computeControlPayloadDigestV1(
            admission.permissionCeiling.allowedActionDescriptors,
          )
          || command.actionDescriptorDigest
            !== await computeControlPayloadDigestV1(command.actionDescriptor)
          || command.policySnapshotRef !== policy.payload.snapshotId
          || command.policySnapshotDigest !== policy.receiptDigest
          || !admission.permissionCeiling.allowedActionDescriptors.includes(
            command.actionDescriptor,
          )
          || (current.publication_mode === "proposal_only"
            && publicationCapabilities.has(command.actionDescriptor))) {
          return { kind: "conflict" as const };
        }
        const permission = await client.query<{ permission_request_digest: string;
          state: string; request: unknown; current_receipt: unknown }>(
            `SELECT permission_request_digest, state, current_receipt
                    , request
             FROM cp_permission_request
             WHERE organization_id = $1 AND permission_request_id = $2
               AND run_id = $3 AND attempt_id = $4 AND attempt_number = $5
               AND action_id = $6 FOR UPDATE`,
            [command.principal.organizationId, command.authority.permissionRequestId,
              command.runId, command.attemptId, command.attemptNumber, command.actionId],
          );
        const permissionRow = permission.rows[0];
        if (!permissionRow || permissionRow.state !== "authorized"
          || permissionRow.permission_request_digest
            !== command.authority.permissionRequestDigest) {
          return { kind: "conflict" as const };
        }
        const storedRequest = StoredPermissionRequestV1Schema.parse(permissionRow.request);
        const { permissionRequestDigest: _storedRequestDigest,
          ...storedRequestDigestInput } = storedRequest;
        if (storedRequest.permissionRequestDigest !== command.authority.permissionRequestDigest
          || storedRequest.permissionRequestDigest !== await computePermissionRequestDigestV1(
            storedRequestDigestInput,
          )
          || storedRequest.organizationId !== command.principal.organizationId
          || storedRequest.runnerId !== command.principal.runnerId
          || storedRequest.runId !== command.runId
          || storedRequest.attempt.attemptId !== command.attemptId
          || storedRequest.attempt.attemptNumber !== command.attemptNumber
          || storedRequest.attempt.fencingTokenDigest !== fencingTokenDigest
          || storedRequest.actionId !== command.actionId
          || storedRequest.actionDescriptor !== command.actionDescriptor
          || storedRequest.actionDescriptorDigest !== command.actionDescriptorDigest
          || storedRequest.targetFingerprint !== command.targetFingerprint
          || storedRequest.policySnapshotRef !== command.policySnapshotRef
          || storedRequest.policySnapshotDigest !== command.policySnapshotDigest) {
          return { kind: "conflict" as const };
        }
        if (storedRequest.workspaceAttestationDigest !== currentWorkspaceAttestationDigest) {
          return { kind: "conflict" as const };
        }
        const resolution = PermissionResolutionReceiptEnvelopeV1Schema.parse(
          permissionRow.current_receipt,
        );
        const { receiptDigest: _resolutionReceiptDigest,
          ...resolutionDigestInput } = resolution;
        if (resolution.payloadDigest !== await computeControlPayloadDigestV1(
          resolution.payload,
        )
          || resolution.receiptDigest !== await computeControlReceiptDigestV1(
            resolutionDigestInput,
          )
          || resolution.receiptId !== command.authority.resolutionReceiptId
          || resolution.receiptDigest !== command.authority.resolutionReceiptDigest
          || resolution.organizationId !== command.principal.organizationId
          || resolution.runId !== command.runId
          || resolution.payload.state !== "authorized"
          || resolution.payload.permissionRequestId
            !== command.authority.permissionRequestId
          || resolution.payload.permissionRequestDigest
            !== command.authority.permissionRequestDigest
          || resolution.payload.actionId !== command.actionId
          || resolution.payload.actionDescriptor !== command.actionDescriptor
          || resolution.payload.actionDescriptorDigest !== command.actionDescriptorDigest
          || resolution.payload.targetFingerprint !== command.targetFingerprint
          || resolution.payload.policySnapshotRef !== command.policySnapshotRef
          || resolution.payload.policySnapshotDigest !== command.policySnapshotDigest
          || resolution.payload.workspaceAttestationDigest !== currentWorkspaceAttestationDigest
          || resolution.attempt.attemptId !== command.attemptId
          || resolution.attempt.attemptNumber !== command.attemptNumber
          || resolution.attempt.fencingTokenDigest !== fencingTokenDigest) {
          return { kind: "conflict" as const };
        }
        const authorityReferenceId = resolution.receiptId;
        const authorityReferenceDigest = resolution.receiptDigest;

        const existing = await client.query<{ fencing_token_digest: string;
          action_id: string; action_descriptor: string; action_descriptor_digest: string;
          target_fingerprint: string; policy_snapshot_digest: string;
          authority_kind: string; authority_reference_id: string;
          authority_reference_digest: string; idempotency_key: string }>(
          `SELECT fencing_token_digest, action_id, action_descriptor,
                  action_descriptor_digest, target_fingerprint, policy_snapshot_digest,
                  authority_kind, authority_reference_id, authority_reference_digest,
                  idempotency_key FROM cp_material_action_begin_intent
           WHERE organization_id = $1 AND (
             idempotency_key = $2 OR (run_id = $3 AND attempt_id = $4 AND action_id = $5))
           FOR UPDATE`,
          [command.principal.organizationId, command.idempotencyKey, command.runId,
            command.attemptId, command.actionId],
        );
        if (existing.rows[0]) return existing.rows[0].fencing_token_digest === fencingTokenDigest
          && existing.rows[0].action_id === command.actionId
          && existing.rows[0].action_descriptor === command.actionDescriptor
          && existing.rows[0].action_descriptor_digest === command.actionDescriptorDigest
          && existing.rows[0].target_fingerprint === command.targetFingerprint
          && existing.rows[0].policy_snapshot_digest === command.policySnapshotDigest
          && existing.rows[0].authority_kind === command.authority.kind
          && existing.rows[0].authority_reference_id === authorityReferenceId
          && existing.rows[0].authority_reference_digest === authorityReferenceDigest
          && existing.rows[0].idempotency_key === command.idempotencyKey
          ? { kind: "replayed" as const } : { kind: "conflict" as const };
        const changed = current.material_start_state === "open" ? await client.query(
          `UPDATE cp_hosted_attempt SET material_start_state = 'started_or_ambiguous',
             updated_at = $4 WHERE organization_id = $1 AND run_id = $2
             AND attempt_number = $3 AND material_start_state = 'open'
           RETURNING attempt_id`,
          [command.principal.organizationId, command.runId,
            command.attemptNumber, input.clock.now()],
        ) : { rows: [{ attempt_id: command.attemptId }] };
        if (changed.rows.length !== 1) return { kind: "stale_fence" as const };
        await client.query(
          `INSERT INTO cp_material_action_begin_intent(organization_id, run_id,
             attempt_id, attempt_number, fencing_token_digest, action_id,
             action_descriptor, action_descriptor_digest, target_fingerprint,
             policy_snapshot_digest, authority_kind, authority_reference_id,
             authority_reference_digest, idempotency_key, begun_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [command.principal.organizationId, command.runId, command.attemptId,
            command.attemptNumber, fencingTokenDigest, command.actionId,
            command.actionDescriptor, command.actionDescriptorDigest,
            command.targetFingerprint, command.policySnapshotDigest,
            command.authority.kind, authorityReferenceId, authorityReferenceDigest,
            command.idempotencyKey, input.clock.now()],
        );
        return { kind: "begun" as const };
      });
    },

    async record(command) {
      const receipt = MaterialActionReceiptEnvelopeV1Schema.parse(
        command.receipt,
      );
      const expectedFenceDigest = await computeMaterialActionFencingTokenDigestV1(
        command.fencingToken,
      );
      const expectedPayloadDigest = await computeMaterialActionPayloadDigestV1(
        receipt.payload,
      );
      const { receiptDigest: _ignored, ...receiptDigestInput } = receipt;
      const expectedReceiptDigest = await computeMaterialActionReceiptDigestV1(
        receiptDigestInput,
      );
      if (
        receipt.organizationId !== command.principal.organizationId
        || receipt.producer.id !== command.principal.runnerId
        || receipt.attempt.fencingTokenDigest !== expectedFenceDigest
        || receipt.payload.actionDescriptorDigest
          !== await computeControlPayloadDigestV1(receipt.payload.actionDescriptor)
        || receipt.payloadDigest !== expectedPayloadDigest
        || receipt.receiptDigest !== expectedReceiptDigest
      ) return { kind: "conflict" };

      return withPostgresTransaction(input.pool, async (client) => {
        const operation = await client.query(
          `SELECT receipt_digest, receipt
           FROM cp_material_action_receipt
           WHERE organization_id = $1 AND operation_id = $2`,
          [command.principal.organizationId, receipt.operationId],
        ) as { rows: Array<{ receipt_digest: string; receipt: unknown }> };
        const replay = operation.rows[0];
        if (replay) {
          return replay.receipt_digest === receipt.receiptDigest
            ? {
                kind: "replayed" as const,
                receipt: MaterialActionReceiptEnvelopeV1Schema.parse(
                  replay.receipt,
                ),
              }
            : { kind: "conflict" as const };
        }
        const authority = await client.query<{ material_start_state: string;
          credential_id: string; fencing_token_digest: string }>(
          `SELECT attempt.material_start_state, attempt.credential_id,
                  attempt.fencing_token_digest
           FROM cp_hosted_run run JOIN cp_hosted_attempt attempt
             ON attempt.organization_id = run.organization_id
            AND attempt.run_id = run.run_id
           WHERE run.organization_id = $1 AND run.run_id = $2
             AND attempt.attempt_id = $3 AND attempt.attempt_number = $4
             AND run.runner_id = $5 FOR UPDATE OF run, attempt`,
          [command.principal.organizationId, receipt.runId,
            receipt.attempt.attemptId, receipt.attempt.attemptNumber,
            command.principal.runnerId],
        );
        const attemptAuthority = authority.rows[0];
        if (!attemptAuthority || attemptAuthority.credential_id !== command.principal.credentialId
          || attemptAuthority.fencing_token_digest !== receipt.attempt.fencingTokenDigest) {
          return { kind: "stale_fence" as const };
        }
        const lateAfterProof = attemptAuthority.material_start_state === "proven_not_started";
        if (!lateAfterProof) {
          const begin = await client.query<{ target_fingerprint: string }>(
            `SELECT target_fingerprint FROM cp_material_action_begin_intent
             WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3
               AND action_id = $4 AND fencing_token_digest = $5
               AND action_descriptor = $6
               AND action_descriptor_digest = $7 AND idempotency_key = $8`,
            [command.principal.organizationId, receipt.runId,
              receipt.attempt.attemptId, receipt.payload.actionId,
              receipt.attempt.fencingTokenDigest,
              receipt.payload.actionDescriptor, receipt.payload.actionDescriptorDigest,
              receipt.payload.idempotencyKey],
          );
          if (begin.rows.length !== 1 || !(await currentAttemptMatches(client, {
            principal: command.principal, runId: receipt.runId,
            attemptId: receipt.attempt.attemptId,
            attemptNumber: receipt.attempt.attemptNumber,
            fencingTokenDigest: receipt.attempt.fencingTokenDigest,
            now: input.clock.now(), materialStartState: "material_allowed",
          }))) return { kind: "stale_fence" as const };
          if (begin.rows[0]?.target_fingerprint !== receipt.payload.targetFingerprint) {
            return { kind: "conflict" as const };
          }
        }

        const currentResult = await client.query(
          `SELECT receipt_id, receipt_digest, outcome, receipt
           FROM cp_material_action_current
           WHERE organization_id = $1 AND run_id = $2
             AND attempt_id = $3 AND action_id = $4
           FOR UPDATE`,
          [
            command.principal.organizationId,
            receipt.runId,
            receipt.attempt.attemptId,
            receipt.payload.actionId,
          ],
        ) as { rows: CurrentReceipt[] };
        const current = currentResult.rows[0];
        if (
          (current && current.outcome !== "outcome_unknown")
          || !exactPredecessor(receipt, current)
        ) return { kind: "conflict" as const };

        const createdAt = input.clock.now();
        await client.query(
          `INSERT INTO cp_material_action_receipt(
             organization_id, receipt_id, operation_id, run_id, runner_id,
             attempt_id, attempt_number, action_id, receipt_digest, outcome,
             receipt, created_at
           ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
          [
            command.principal.organizationId,
            receipt.receiptId,
            receipt.operationId,
            receipt.runId,
            command.principal.runnerId,
            receipt.attempt.attemptId,
            receipt.attempt.attemptNumber,
            receipt.payload.actionId,
            receipt.receiptDigest,
            receipt.payload.outcome,
            JSON.stringify(receipt),
            createdAt,
          ],
        );
        if (lateAfterProof) {
          const reconciliationIdentity = `${command.principal.organizationId}:${receipt.runId}:${receipt.receiptId}:late_material_evidence`;
          await client.query(
            `UPDATE cp_hosted_attempt SET material_start_state = 'started_or_ambiguous',
               state = 'interrupted', updated_at = $4
             WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3`,
            [command.principal.organizationId, receipt.runId,
              receipt.attempt.attemptId, createdAt],
          );
          await client.query(
            `UPDATE cp_hosted_run SET state = 'interrupted', terminal_kind = 'interrupted',
               terminal_reason = 'late_material_evidence_after_non_start_proof',
               outcome_state = 'outcome_unknown', reconciliation_identity = $3,
               terminal_receipt = $4::jsonb, updated_at = $5
             WHERE organization_id = $1 AND run_id = $2 AND terminal_kind IS NULL`,
            [command.principal.organizationId, receipt.runId, reconciliationIdentity,
              JSON.stringify(receipt), createdAt],
          );
        }
        await client.query(
          `INSERT INTO cp_material_action_current(
             organization_id, run_id, attempt_id, attempt_number, action_id,
             receipt_id, receipt_digest, outcome, receipt, updated_at
           ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           ON CONFLICT (organization_id, run_id, attempt_id, action_id)
           DO UPDATE SET receipt_id = EXCLUDED.receipt_id,
             receipt_digest = EXCLUDED.receipt_digest,
             outcome = EXCLUDED.outcome, receipt = EXCLUDED.receipt,
             updated_at = EXCLUDED.updated_at`,
          [
            command.principal.organizationId,
            receipt.runId,
            receipt.attempt.attemptId,
            receipt.attempt.attemptNumber,
            receipt.payload.actionId,
            receipt.receiptId,
            receipt.receiptDigest,
            receipt.payload.outcome,
            JSON.stringify(receipt),
            createdAt,
          ],
        );
        await client.query(
          `INSERT INTO cp_hosted_audit_event(
             organization_id, run_id, event_kind, event, created_at
           ) VALUES($1, $2, 'material_action_observed', $3::jsonb, $4)`,
          [
            command.principal.organizationId,
            receipt.runId,
            JSON.stringify({
              actionId: receipt.payload.actionId,
              outcome: receipt.payload.outcome,
              receiptDigest: receipt.receiptDigest,
              receiptId: receipt.receiptId,
            }),
            createdAt,
          ],
        );
        return { kind: "recorded", receipt } as const;
      });
    },

    async reconcile(command) {
      const request = RunnerMaterialActionReconcileRequestV1Schema.parse(
        command.request,
      );
      if (
        request.organizationId !== command.principal.organizationId
        || request.runnerId !== command.principal.runnerId
        || request.attempt.fencingTokenDigest
          !== await computeMaterialActionFencingTokenDigestV1(
            request.attempt.fencingToken,
          )
      ) return { kind: "conflict" };
      return withPostgresTransaction(input.pool, async (client) => {
        if (!(await currentAttemptMatches(client, {
          principal: command.principal,
          runId: request.runId,
          attemptId: request.attempt.attemptId,
          attemptNumber: request.attempt.attemptNumber,
          fencingTokenDigest: request.attempt.fencingTokenDigest,
          now: input.clock.now(),
        }))) return { kind: "stale_fence" as const };
        const result = await client.query(
          `SELECT receipt_id, receipt_digest, outcome, receipt
           FROM cp_material_action_current
           WHERE organization_id = $1 AND run_id = $2
             AND attempt_id = $3 AND action_id = $4`,
          [
            command.principal.organizationId,
            request.runId,
            request.attempt.attemptId,
            request.actionId,
          ],
        ) as { rows: CurrentReceipt[] };
        const current = result.rows[0];
        if (!current) return { kind: "missing" as const };
        if (
          request.expectedCurrentReceiptId !== undefined
          && (
            request.expectedCurrentReceiptId !== current.receipt_id
            || request.expectedCurrentReceiptDigest !== current.receipt_digest
          )
        ) return { kind: "conflict" as const };
        return {
          kind: current.outcome === "outcome_unknown"
            ? "outcome_unknown" as const
            : "resolved" as const,
          receipt: MaterialActionReceiptEnvelopeV1Schema.parse(current.receipt),
        };
      });
    },
  };
}
