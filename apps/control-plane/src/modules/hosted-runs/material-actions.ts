import {
  computeMaterialActionFencingTokenDigestV1,
  computeMaterialActionPayloadDigestV1,
  computeMaterialActionReceiptDigestV1,
  MaterialActionReceiptEnvelopeV1Schema,
  RunnerMaterialActionReconcileRequestV1Schema,
  type MaterialActionReceiptEnvelopeV1,
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
  const attempt = await client.query<{ material_start_state: string;
    fencing_token_digest: string }>(
    `SELECT material_start_state, fencing_token_digest FROM cp_hosted_attempt
     WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3`,
    [input.organizationId, input.runId, input.attemptId],
  );
  const attemptRow = attempt.rows[0];
  if (!attemptRow || attemptRow.material_start_state === "open") {
    return { kind: "started_or_ambiguous",
      reconciliationIdentity: `${input.organizationId}:${input.runId}:${input.attemptId}:material_start_unknown` };
  }
  const result = await client.query<{ receipt_id: string }>(
    `SELECT receipt_id FROM cp_material_action_receipt
     WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3
     ORDER BY created_at, receipt_id LIMIT 1`,
    [input.organizationId, input.runId, input.attemptId],
  );
  if (attemptRow.material_start_state === "started_or_ambiguous" || result.rows[0]) {
    return { kind: "started_or_ambiguous",
      reconciliationIdentity: result.rows[0]
        ? `${input.organizationId}:${input.runId}:${result.rows[0].receipt_id}`
        : `${input.organizationId}:${input.runId}:${input.attemptId}:material_start_unknown` };
  }
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

export type MaterialActionCoordinator = {
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
    materialStartState?: "open" | "material_allowed";
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
       AND ($9::text IS NULL
         OR ($9 = 'open' AND attempt.material_start_state = 'open')
         OR ($9 = 'material_allowed'
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
    ],
  ) as { rows: unknown[] };
  return result.rows.length === 1;
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
      return withPostgresTransaction(input.pool, async (client) => {
        const existing = await client.query<{ fencing_token_digest: string;
          proof_id: string; proof_digest: string }>(
          `SELECT fencing_token_digest, proof_id, proof_digest
           FROM cp_material_action_non_start_proof
           WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3`,
          [command.principal.organizationId, command.runId, command.attemptId],
        );
        if (existing.rows[0]) return existing.rows[0].fencing_token_digest === fencingTokenDigest
          && existing.rows[0].proof_id === command.proofId
          && existing.rows[0].proof_digest === command.proofDigest
          ? { kind: "replayed" as const }
          : { kind: "conflict" as const };
        if (!(await currentAttemptMatches(client, {
          principal: command.principal, runId: command.runId,
          attemptId: command.attemptId, attemptNumber: command.attemptNumber,
          fencingTokenDigest, now: input.clock.now(),
          materialStartState: "open",
        }))) return { kind: "stale_fence" as const };
        await client.query(
          `UPDATE cp_hosted_attempt SET material_start_state = 'proven_not_started',
             updated_at = $4 WHERE organization_id = $1 AND run_id = $2
             AND attempt_number = $3 AND material_start_state = 'open'`,
          [command.principal.organizationId, command.runId,
            command.attemptNumber, input.clock.now()],
        );
        await client.query(
          `INSERT INTO cp_material_action_non_start_proof(
             organization_id, run_id, attempt_id, attempt_number,
             fencing_token_digest, proof_id, proof_digest, recorded_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [command.principal.organizationId, command.runId, command.attemptId,
            command.attemptNumber, fencingTokenDigest, command.proofId,
            command.proofDigest, input.clock.now()],
        );
        return { kind: "recorded" as const };
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
        if (!(await currentAttemptMatches(client, {
          principal: command.principal,
          runId: receipt.runId,
          attemptId: receipt.attempt.attemptId,
          attemptNumber: receipt.attempt.attemptNumber,
          fencingTokenDigest: receipt.attempt.fencingTokenDigest,
          now: input.clock.now(),
          materialStartState: "material_allowed",
        }))) return { kind: "stale_fence" as const };
        await client.query(
          `UPDATE cp_hosted_attempt SET material_start_state = 'started_or_ambiguous',
             updated_at = $4 WHERE organization_id = $1 AND run_id = $2
             AND attempt_number = $3 AND material_start_state = 'open'`,
          [command.principal.organizationId, receipt.runId,
            receipt.attempt.attemptNumber, input.clock.now()],
        );

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
