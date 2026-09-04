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

export type AttemptCancellationMaterialTruth =
  | { kind: "proven_not_started" }
  | { kind: "resolved"; receipts: Array<{ actionId: string; receiptId: string;
      receiptDigest: string; outcome: "succeeded" | "failed" }> }
  | { kind: "outcome_unknown"; reconciliationIdentity: string };

export function cancellationMaterialEvidence(
  truth: AttemptCancellationMaterialTruth,
): Record<string, unknown> {
  if (truth.kind === "proven_not_started") return { state: "proven_not_started" };
  if (truth.kind === "resolved") return { state: "resolved", receipts: truth.receipts };
  return { state: "outcome_unknown", reconciliationIdentity: truth.reconciliationIdentity };
}

export async function classifyAttemptMaterialActionCancellationTruth(
  client: { query<Row extends Record<string, unknown>>(text: string,
    values?: readonly unknown[]): Promise<{ rows: Row[] }> },
  input: { organizationId: string; runId: string; attemptId: string },
): Promise<AttemptCancellationMaterialTruth> {
  const attempt = await client.query<{ material_start_state: string }>(
    `SELECT material_start_state FROM cp_hosted_attempt
     WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3`,
    [input.organizationId, input.runId, input.attemptId],
  );
  const attemptRow = attempt.rows[0];
  const unknown = (suffix: string): AttemptCancellationMaterialTruth => ({
    kind: "outcome_unknown",
    reconciliationIdentity: `${input.organizationId}:${input.runId}:${suffix}`,
  });
  if (!attemptRow) return unknown(`${input.attemptId}:material_start_unknown`);
  const begins = await client.query<{ action_id: string }>(
    `SELECT action_id FROM cp_material_action_begin_intent
     WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3 ORDER BY action_id`,
    [input.organizationId, input.runId, input.attemptId],
  );
  const current = await client.query<{ action_id: string; receipt_id: string;
    receipt_digest: string; outcome: "succeeded" | "failed" | "outcome_unknown" }>(
    `SELECT action_id,receipt_id,receipt_digest,outcome FROM cp_material_action_current
     WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3 ORDER BY action_id`,
    [input.organizationId, input.runId, input.attemptId],
  );
  const orphanReceipt = await client.query<{ receipt_id: string }>(
    `SELECT receipt_id FROM cp_material_action_receipt receipt
     WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3
       AND NOT EXISTS (SELECT 1 FROM cp_material_action_current current
         WHERE current.organization_id=receipt.organization_id
           AND current.run_id=receipt.run_id AND current.attempt_id=receipt.attempt_id
           AND current.action_id=receipt.action_id)
     ORDER BY created_at,receipt_id LIMIT 1`,
    [input.organizationId, input.runId, input.attemptId],
  );
  if (orphanReceipt.rows[0]) return unknown(orphanReceipt.rows[0].receipt_id);
  if (begins.rows.length === 0 && current.rows.length === 0) {
    if (attemptRow.material_start_state === "open") return { kind: "proven_not_started" };
    return unknown(`${input.attemptId}:material_start_unknown`);
  }
  const begunActions = new Set(begins.rows.map((row) => row.action_id));
  const currentByAction = new Map(current.rows.map((row) => [row.action_id, row]));
  const unmatchedCurrent = current.rows.find((row) => !begunActions.has(row.action_id));
  if (unmatchedCurrent) return unknown(unmatchedCurrent.receipt_id);
  for (const begin of begins.rows) {
    const receipt = currentByAction.get(begin.action_id);
    if (!receipt) return unknown(`${input.attemptId}:${begin.action_id}:material_start_unknown`);
    if (receipt.outcome === "outcome_unknown") return unknown(receipt.receipt_id);
  }
  return { kind: "resolved", receipts: current.rows.map((row) => ({
    actionId: row.action_id,
    receiptId: row.receipt_id,
    receiptDigest: row.receipt_digest,
    outcome: row.outcome as "succeeded" | "failed",
  })) };
}

export async function classifyAttemptMaterialActionTruth(
  client: { query<Row extends Record<string, unknown>>(text: string,
    values?: readonly unknown[]): Promise<{ rows: Row[] }> },
  input: { organizationId: string; runId: string; attemptId: string },
): Promise<AttemptMaterialActionTruth> {
  const attempt = await client.query<{ material_start_state: string; state: string }>(
    `SELECT material_start_state, state FROM cp_hosted_attempt
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
  return { kind: "started_or_ambiguous",
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
        const authority = await client.query<{ credential_id: string; fencing_token_digest: string;
          current_attempt_number: number; terminal_kind: string | null;
          outcome_state: string | null; reconciliation_identity: string | null }>(
          `SELECT attempt.credential_id, attempt.fencing_token_digest,run.current_attempt_number,
                  run.terminal_kind,run.outcome_state,run.reconciliation_identity
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
        const cancellationTruth = attemptAuthority.terminal_kind === "cancelled"
          && attemptAuthority.outcome_state === "outcome_unknown"
          && attemptAuthority.current_attempt_number === receipt.attempt.attemptNumber
          ? await classifyAttemptMaterialActionCancellationTruth(client, {
              organizationId: command.principal.organizationId,
              runId: receipt.runId,
              attemptId: receipt.attempt.attemptId,
            })
          : null;
        const lateAfterCancellation = cancellationTruth?.kind === "outcome_unknown"
          && cancellationTruth.reconciliationIdentity
            === attemptAuthority.reconciliation_identity;
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
        if (begin.rows.length !== 1) return { kind: "stale_fence" as const };
        if (!lateAfterCancellation && !(await currentAttemptMatches(client, {
              principal: command.principal, runId: receipt.runId,
              attemptId: receipt.attempt.attemptId,
              attemptNumber: receipt.attempt.attemptNumber,
              fencingTokenDigest: receipt.attempt.fencingTokenDigest,
              now: input.clock.now(), materialStartState: "material_allowed",
          }))) return { kind: "stale_fence" as const };
        if (begin.rows[0]?.target_fingerprint !== receipt.payload.targetFingerprint) {
          return { kind: "conflict" as const };
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
        if (lateAfterCancellation) {
          const material = await classifyAttemptMaterialActionCancellationTruth(client, {
            organizationId: command.principal.organizationId,
            runId: receipt.runId,
            attemptId: receipt.attempt.attemptId,
          });
          const stillUnknown = material.kind === "outcome_unknown";
          const changed = await client.query(
            `UPDATE cp_hosted_run
             SET outcome_state=$3,reconciliation_identity=$4,
                 terminal_receipt=jsonb_set(terminal_receipt,'{materialAction}',$5::jsonb,true),
                 updated_at=$6
             WHERE organization_id=$1 AND run_id=$2 AND terminal_kind='cancelled'
               AND outcome_state='outcome_unknown' AND reconciliation_identity=$7`,
            [command.principal.organizationId, receipt.runId,
              stillUnknown ? "outcome_unknown" : null,
              stillUnknown ? material.reconciliationIdentity : null,
              JSON.stringify(cancellationMaterialEvidence(material)), createdAt,
              attemptAuthority.reconciliation_identity],
          );
          if (changed.rowCount !== 1) {
            throw new Error("cancelled_material_reconciliation_conflict");
          }
        }
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
