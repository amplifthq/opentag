import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DeliveryIntentV2Schema, domainSeparatedCanonicalBytes, type DeliveryIntentV2 } from "@opentag/delivery-contract";
import type { DeliveryBegin, DeliveryClaim, DeliveryErrorCode,
  DeliveryKernelRepository, DeliverySettlement, DeliverySettlementInput,
  ExpectedDeliveryOwner, StoredDeliveryIntent } from "@opentag/delivery-runtime";
import type { Pool, PoolClient } from "pg";

type RelayOwner = Pick<ExpectedDeliveryOwner, "runtimeOwnerId" | "runtimeGeneration" | "schemaGeneration">;
type Row = { intent_id: string; journal_intent_digest: string; intent: unknown; payload: unknown;
  state: string; revision: number; sequence: number; provider_id: string; provider_instance_id: string;
  provider_binding_digest: string; provider_config_generation: number;
  provider_config_generation_digest: string; runtime_owner_id: string; runtime_generation: number;
  schema_generation: number; authority_snapshot_digest: string; lease_fence_digest: string | null;
  installation_begin_marker_id: string | null; installation_begin_marker_digest: string | null;
  scope_begin_marker_id: string | null; scope_begin_marker_digest: string | null;
  evidence_digest: string | null; error_code: string | null; external_resource_digest: string | null;
  external_resource_id: string | null };
const sha256 = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const journalDigest = (intent: DeliveryIntentV2) => sha256(domainSeparatedCanonicalBytes("opentag.delivery.journal-intent.v1", intent));
const terminal = new Set(["accepted", "rejected", "outcome_unknown", "attention", "superseded"]);
const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as unknown;
const payloadPhase = (payload: unknown) => payload && typeof payload === "object" && "phase" in payload
  ? (payload as { phase?: unknown }).phase : undefined;

function claim(row: Row, leaseFence: string): DeliveryClaim {
  return { attemptId: row.intent_id, intentId: row.intent_id, sequence: row.sequence,
    leaseFence, revision: row.revision, providerId: row.provider_id,
    providerInstanceId: row.provider_instance_id, providerBindingDigest: row.provider_binding_digest,
    providerConfigGeneration: row.provider_config_generation,
    providerConfigGenerationDigest: row.provider_config_generation_digest,
    runtimeOwnerId: row.runtime_owner_id, runtimeGeneration: row.runtime_generation,
    schemaGeneration: row.schema_generation, authoritySnapshotDigest: row.authority_snapshot_digest,
    journalIntentDigest: row.journal_intent_digest };
}
function begun(row: Row, leaseFence: string): DeliveryBegin {
  return { ...claim(row, leaseFence), installationBeginMarkerId: row.installation_begin_marker_id!,
    installationBeginMarkerDigest: row.installation_begin_marker_digest!,
    scopeBeginMarkerId: row.scope_begin_marker_id!, scopeBeginMarkerDigest: row.scope_begin_marker_digest! };
}
function settlement(row: Row, leaseFence: string): DeliverySettlement {
  return { ...begun(row, leaseFence), outcome: row.state as DeliverySettlement["outcome"],
    evidenceDigest: row.evidence_digest!, ...(row.error_code ? { errorCode: row.error_code as DeliveryErrorCode } : {}),
    ...(row.external_resource_digest ? { externalResourceDigest: row.external_resource_digest } : {}),
    ...(row.external_resource_id ? { externalResourceId: row.external_resource_id } : {}) };
}

export function createPostgresDeliveryRepository(options: { pool: Pool; owner: RelayOwner;
  leaseOwner: string; leaseSeconds: number; now?: () => Date }): DeliveryKernelRepository {
  if (!Number.isSafeInteger(options.leaseSeconds) || options.leaseSeconds < 1 || options.leaseSeconds > 86_400)
    throw new Error("leaseSeconds must be an integer from 1 to 86400");
  const now = () => options.now?.() ?? new Date();
  const withTx = async <T>(work: (client: PoolClient) => Promise<T>) => {
    const client = await options.pool.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  };
  return {
    async recordIntent(input, persistedPayload) {
      const intent = DeliveryIntentV2Schema.parse(input); const digest = journalDigest(intent);
      const binding = intent.providerBinding; const phase = payloadPhase(persistedPayload);
      const deadline = persistedPayload && typeof persistedPayload === "object" && "deliveryDeadline" in persistedPayload
        ? new Date(String((persistedPayload as { deliveryDeadline?: unknown }).deliveryDeadline)) : null;
      if (deadline && Number.isNaN(deadline.valueOf())) throw new Error("delivery deadline invalid");
      await withTx(async (client) => {
        const existing = await client.query<Row>("SELECT * FROM cp_provider_delivery_intent WHERE intent_id=$1 FOR UPDATE", [intent.sideEffectIntentId]);
        if (existing.rows[0]) {
          if (existing.rows[0].journal_intent_digest !== digest) throw new Error(`delivery intent ${intent.sideEffectIntentId} conflict`);
          return;
        }
        if (intent.provenance.kind === "business" && (phase === "final" || phase === "terminal")) {
          await client.query(`UPDATE cp_provider_delivery_intent SET state='superseded', revision=revision+1,
            superseded_by_intent_id=$1, evidence_digest=$2, error_code='delivery_superseded',
            outcome_recorded_at=$3, updated_at=$3
            WHERE run_id=$4 AND state IN ('pending','leased')
              AND payload->>'phase' IN ('received','running')`,
          [intent.sideEffectIntentId, sha256("opentag.delivery.superseded.v1"), now(), intent.provenance.runId]);
        }
        try {
          await client.query(`INSERT INTO cp_provider_delivery_intent(
            intent_id,journal_intent_digest,intent,payload,payload_custody_ref,state,revision,sequence,
            scope_kind,scope_id,idempotency_key,provider_id,provider_instance_id,provider_binding_digest,
            provider_config_generation,provider_config_generation_digest,runtime_owner_id,runtime_generation,
            schema_generation,authority_snapshot_digest,status_message_id,run_id,deadline_at,created_at,updated_at)
            VALUES($1,$2,$3::jsonb,$4::jsonb,$5,'pending',1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22)`,
          [intent.sideEffectIntentId, digest, JSON.stringify(intent), JSON.stringify(jsonValue(persistedPayload)),
            `postgres-jsonb:${intent.sideEffectIntentId}:${digest}`, intent.initialAttemptSequence,
            intent.scope.kind, intent.scope.id, intent.idempotencyKey, binding.providerId,
            binding.providerInstanceId, binding.bindingDigest, binding.providerConfigGeneration,
            binding.providerConfigGenerationDigest, options.owner.runtimeOwnerId,
            options.owner.runtimeGeneration, options.owner.schemaGeneration, intent.authoritySnapshotDigest,
            "statusMessageId" in intent ? intent.statusMessageId ?? null : null,
            intent.provenance.kind === "business" ? intent.provenance.runId : null,
            deadline, new Date(intent.createdAt)]);
        } catch (error) {
          if ((error as { code?: string }).code === "23505") throw new Error(`delivery idempotency or digest conflict for ${intent.sideEffectIntentId}`);
          throw error;
        }
      });
    },
    async claimNext() {
      return withTx(async (client) => {
        const at = now();
        await client.query(`UPDATE cp_provider_delivery_intent SET state='attention', revision=revision+1,
          evidence_digest=$1,error_code='delivery_deadline_exceeded',outcome_recorded_at=$2,updated_at=$2
          WHERE state IN ('pending','leased') AND deadline_at IS NOT NULL AND deadline_at <= $2`,
        [sha256("opentag.delivery.deadline-exceeded.v1"), at]);
        const fence = randomBytes(32).toString("base64url");
        const result = await client.query<Row>(`WITH candidate AS (
          SELECT intent_id FROM cp_provider_delivery_intent
          WHERE state='pending' OR (state='leased' AND lease_expires_at < $1)
          ORDER BY created_at,intent_id FOR UPDATE SKIP LOCKED LIMIT 1)
          UPDATE cp_provider_delivery_intent delivery SET state='leased',revision=delivery.revision+1,
          lease_owner=$2,lease_expires_at=$3,lease_fence_digest=$4,updated_at=$1
          FROM candidate WHERE delivery.intent_id=candidate.intent_id RETURNING delivery.*`,
        [at, options.leaseOwner, new Date(at.getTime() + options.leaseSeconds * 1000), sha256(fence)]);
        return result.rows[0] ? claim(result.rows[0], fence) : null;
      });
    },
    async renewLease(input) {
      const at = now(); const result = await options.pool.query<Row>(`UPDATE cp_provider_delivery_intent
        SET revision=revision+1,lease_expires_at=$1,updated_at=$2 WHERE intent_id=$3 AND state='leased'
        AND revision=$4 AND lease_owner=$5 AND lease_fence_digest=$6 RETURNING *`,
      [new Date(at.getTime() + options.leaseSeconds * 1000), at, input.intentId, input.revision,
        options.leaseOwner, sha256(input.leaseFence)]);
      return result.rows[0] ? claim(result.rows[0], input.leaseFence) : null;
    },
    async getIntent(input): Promise<StoredDeliveryIntent | null> {
      const result = await options.pool.query<Row>("SELECT * FROM cp_provider_delivery_intent WHERE intent_id=$1", [input.intentId]);
      const row = result.rows[0]; if (!row) return null;
      try { const intent = DeliveryIntentV2Schema.parse(row.intent);
        if (journalDigest(intent) !== row.journal_intent_digest) throw new Error("custody digest mismatch");
        return { outcome: "hydrated", intent, journalIntentDigest: row.journal_intent_digest,
          persistedPayload: row.payload };
      } catch { return { outcome: "custody_unavailable", journalIntentDigest: row.journal_intent_digest }; }
    },
    async releaseUnusedClaim(input) {
      const result = await options.pool.query(`UPDATE cp_provider_delivery_intent SET state='pending',revision=revision+1,
        lease_owner=NULL,lease_expires_at=NULL,lease_fence_digest=NULL,updated_at=$1
        WHERE intent_id=$2 AND state='leased' AND revision=$3 AND lease_owner=$4 AND lease_fence_digest=$5`,
      [now(), input.intentId, input.revision, options.leaseOwner, sha256(input.leaseFence)]);
      return result.rowCount === 1;
    },
    async markBegin(input) {
      const at = now(); const result = await options.pool.query<Row>(`UPDATE cp_provider_delivery_intent
        SET state='provider_io_begun',revision=revision+1,installation_begin_marker_id=$1,
        installation_begin_marker_digest=$2,scope_begin_marker_id=$3,scope_begin_marker_digest=$4,
        begun_at=$5,updated_at=$5 WHERE intent_id=$6 AND state='leased' AND revision=$7
        AND lease_owner=$8 AND lease_fence_digest=$9 RETURNING *`,
      [input.installationBeginMarkerId, input.installationBeginMarkerDigest,
        input.scopeBeginMarkerId, input.scopeBeginMarkerDigest, at, input.intentId,
        input.revision, options.leaseOwner, sha256(input.leaseFence)]);
      return result.rows[0] ? begun(result.rows[0], input.leaseFence) : null;
    },
    async settleOrReadTerminal(input: DeliverySettlementInput) {
      const recordedAt = input.outcomeRecordedAt ? new Date(input.outcomeRecordedAt) : now();
      const result = await options.pool.query<Row>(`UPDATE cp_provider_delivery_intent SET state=$1,
        revision=revision+1,evidence_digest=$2,error_code=$3,external_resource_digest=$4,
        external_resource_id=$5,outcome_recorded_at=$6,updated_at=$6
        WHERE intent_id=$7 AND state='provider_io_begun' AND revision=$8 AND lease_fence_digest=$9
        AND installation_begin_marker_id=$10 AND installation_begin_marker_digest=$11
        AND scope_begin_marker_id=$12 AND scope_begin_marker_digest=$13 RETURNING *`,
      [input.outcome, input.evidenceDigest, input.errorCode ?? null, input.externalResourceDigest ?? null,
        input.externalResourceId ?? null, recordedAt, input.intentId, input.revision,
        sha256(input.leaseFence), input.installationBeginMarkerId, input.installationBeginMarkerDigest,
        input.scopeBeginMarkerId, input.scopeBeginMarkerDigest]);
      if (result.rows[0]) return settlement(result.rows[0], input.leaseFence);
      const current = await options.pool.query<Row>("SELECT * FROM cp_provider_delivery_intent WHERE intent_id=$1", [input.intentId]);
      if (current.rows[0] && terminal.has(current.rows[0].state)) return settlement(current.rows[0], input.leaseFence);
      throw new Error(`delivery settlement tuple conflict for attempt ${input.attemptId}`);
    },
    async finalizeStrandedBegun(input) {
      const result = await options.pool.query(`UPDATE cp_provider_delivery_intent SET state='outcome_unknown',
        revision=revision+1,evidence_digest=$1,error_code='delivery_restart_after_begin',
        outcome_recorded_at=$2,updated_at=$2 WHERE state='provider_io_begun' AND begun_at < $3`,
      [input.evidenceDigest, input.outcomeRecordedAt ? new Date(input.outcomeRecordedAt) : now(), new Date(input.before)]);
      return result.rowCount ?? 0;
    },
    async findAcceptedExternalResource(input) {
      const result = await options.pool.query<{ external_resource_id: string; external_resource_digest: string }>(
        `SELECT DISTINCT external_resource_id,external_resource_digest FROM cp_provider_delivery_intent
         WHERE state='accepted' AND run_id=$1 AND status_message_id=$2 AND provider_id=$3
         AND provider_instance_id=$4 AND intent->>'targetDigest'=$5
         AND external_resource_id IS NOT NULL AND external_resource_digest IS NOT NULL LIMIT 2`,
      [input.intent.provenance.kind === "business" ? input.intent.provenance.runId : null,
        input.statusMessageId, input.intent.providerBinding.providerId,
        input.intent.providerBinding.providerInstanceId, input.intent.targetDigest]);
      return result.rows.length === 0 ? { outcome: "none" } : result.rows.length > 1
        ? { outcome: "ambiguous" }
        : { outcome: "exact", externalResourceId: result.rows[0]!.external_resource_id,
          externalResourceDigest: result.rows[0]!.external_resource_digest };
    },
  };
}
