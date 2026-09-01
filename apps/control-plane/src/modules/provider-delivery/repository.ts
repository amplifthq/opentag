import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DELIVERY_ERROR_CODES, DeliveryIntentV2Schema, deliveryCurrentTruthDescriptor,
  domainSeparatedCanonicalBytes, type DeliveryBegin,
  type DeliveryClaim, type DeliveryErrorCode, type DeliveryIntentV2,
  type DeliveryExternalResourceLookupDescriptor,
  type DeliveryPayloadEnvelope, type DeliverySettlement, type DeliverySettlementInput,
  type ExpectedDeliveryOwner, type StoredDeliveryIntent } from "@opentag/delivery-contract";
import type { DeliveryKernelRepository } from "@opentag/delivery-runtime";
import type { Pool, PoolClient } from "pg";

type RelayOwner = Pick<ExpectedDeliveryOwner, "runtimeOwnerId" | "runtimeGeneration" | "schemaGeneration">;
type Row = { intent_id: string; journal_intent_digest: string; intent: unknown; payload: unknown;
  organization_id: string;
  payload_digest: string; presentation_phase: string; current_truth_key: string;
  projection_revision: number | null;
  projection_purpose: string;
  projection_event_sequence:number;
  state: string; revision: number; sequence: number; provider_id: string; provider_instance_id: string;
  provider_binding_digest: string; provider_config_generation: number;
  provider_config_generation_digest: string; runtime_owner_id: string; runtime_generation: number;
  schema_generation: number; authority_snapshot_digest: string; lease_fence: string | null;
  lease_fence_digest: string | null;
  installation_begin_marker_id: string | null; installation_begin_marker_digest: string | null;
  scope_begin_marker_id: string | null; scope_begin_marker_digest: string | null;
  evidence_digest: string | null; error_code: string | null; external_resource_digest: string | null;
  external_resource_id: string | null };
const sha256 = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const journalDigest = (intent: DeliveryIntentV2) => sha256(domainSeparatedCanonicalBytes("opentag.delivery.journal-intent.v1", intent));
const terminal = new Set(["accepted", "rejected", "outcome_unknown", "attention", "superseded"]);
const errorCodes = new Set<string>(DELIVERY_ERROR_CODES);
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as unknown;

export async function readExactDeliveryAnchor(pool: Pick<Pool,"query">,
  input: DeliveryExternalResourceLookupDescriptor,
  options: { projectionPurpose?: "anchor_create" } = {}) {
  const result=await pool.query<{ state:string;intent_id:string;external_resource_id:string|null;
    external_resource_digest:string|null }>(`SELECT state,intent_id,external_resource_id,external_resource_digest
    FROM cp_provider_delivery_intent WHERE intent->'provenance'->>'kind'='business'
      AND ($22::text IS NULL OR projection_purpose=$22)
      AND organization_id=$1 AND intent->>'operation'='create' AND run_id=$2 AND status_message_id=$3
      AND scope_kind=$4 AND scope_id=$5 AND intent->>'targetDigest'=$6 AND provider_id=$7
      AND provider_instance_id=$8 AND provider_binding_digest=$9
      AND intent->'providerBinding'->>'providerPrincipalDigest'=$10
      AND intent->'providerBinding'->>'principalAssurance'=$11
      AND provider_config_generation=$12 AND provider_config_generation_digest=$13
      AND runtime_owner_id=$14 AND runtime_generation=$15 AND schema_generation=$16
      AND authority_snapshot_digest=$17
      AND intent->'provenance'->>'repositoryIdentityDigest'=$18
      AND intent->'provenance'->>'authorityLineageDigest'=$19
      AND COALESCE(intent->'providerBinding'->>'connectionId','')=COALESCE($20,'')
      AND COALESCE(intent->'providerBinding'->>'connectionIdDigest','')=COALESCE($21,'')
      AND state IN ('pending','leased','provider_io_begun','outcome_unknown','attention','accepted')
      ORDER BY created_at,intent_id`,[input.organizationId,input.runId,input.statusMessageId,
    input.scopeKind,input.scopeId,input.targetDigest,input.providerId,input.providerInstanceId,
    input.providerBindingDigest,input.providerPrincipalDigest,input.principalAssurance,
    input.providerConfigGeneration,input.providerConfigGenerationDigest,input.runtimeOwnerId,
    input.runtimeGeneration,input.schemaGeneration,input.authoritySnapshotDigest,
    input.repositoryIdentityDigest,input.authorityLineageDigest,input.connectionId,input.connectionIdDigest,
    options.projectionPurpose??null]);
  const active=result.rows.find((row)=>row.state!=="accepted");
  if(active)return {outcome:"pending" as const,anchorIntentId:active.intent_id,state:active.state};
  const accepted=result.rows.filter((row)=>row.state==="accepted");
  if(accepted.length===0)return {outcome:"none" as const};
  if(accepted.some((row)=>!row.external_resource_id||!row.external_resource_digest))
    return {outcome:"ambiguous" as const};
  const tuples=new Map(accepted.map((row)=>[`${row.external_resource_id}\u0000${row.external_resource_digest}`,row]));
  if(tuples.size!==1)return {outcome:"ambiguous" as const};
  const exact=[...tuples.values()][0]!;
  return {outcome:"exact" as const,anchorIntentId:exact.intent_id,
    externalResourceId:exact.external_resource_id!,externalResourceDigest:exact.external_resource_digest!};
}
function payloadEnvelope(value: unknown, intent: DeliveryIntentV2, owner: RelayOwner): DeliveryPayloadEnvelope {
  if (!value || typeof value !== "object") throw new Error("delivery payload envelope invalid");
  const envelope = value as DeliveryPayloadEnvelope;
  const truth = envelope.currentTruth; const binding = intent.providerBinding;
  const expectedTruth = deliveryCurrentTruthDescriptor({ intent, owner: {
    organizationId: intent.organizationId, providerId: binding.providerId,
    providerInstanceId: binding.providerInstanceId, providerBindingDigest: binding.bindingDigest,
    providerConfigGeneration: binding.providerConfigGeneration,
    providerConfigGenerationDigest: binding.providerConfigGenerationDigest, ...owner } });
  if (envelope.envelopeVersion !== 1 || !["received", "running", "terminal"].includes(envelope.phase)
    || !truth || Number.isNaN(new Date(envelope.frozenDeadline).valueOf())
    || Buffer.compare(Buffer.from(domainSeparatedCanonicalBytes("opentag.delivery.current-truth.v1", truth)),
      Buffer.from(domainSeparatedCanonicalBytes("opentag.delivery.current-truth.v1", expectedTruth))) !== 0) {
    throw new Error("delivery payload envelope identity conflict");
  }
  return jsonValue(envelope) as DeliveryPayloadEnvelope;
}
const payloadDigest = (payload: DeliveryPayloadEnvelope) => sha256(domainSeparatedCanonicalBytes(
  "opentag.delivery.provider-payload.v1", payload));
const currentTruthKey = (payload: DeliveryPayloadEnvelope) => {
  const { projectionRevision: _revision,projectionEventSequence:_eventSequence, ...identity } = payload.currentTruth;
  return sha256(domainSeparatedCanonicalBytes("opentag.delivery.current-truth.v1", identity));
};

function claim(row: Row, leaseFence: string): DeliveryClaim {
  return { organizationId: row.organization_id, attemptId: row.intent_id, intentId: row.intent_id, sequence: row.sequence,
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
function claimTupleMatches(row: Row, input: DeliveryClaim, revision: number): boolean {
  return row.intent_id === input.intentId && row.intent_id === input.attemptId
    && row.organization_id === input.organizationId
    && row.sequence === input.sequence && row.revision === revision
    && row.provider_id === input.providerId && row.provider_instance_id === input.providerInstanceId
    && row.provider_binding_digest === input.providerBindingDigest
    && row.provider_config_generation === input.providerConfigGeneration
    && row.provider_config_generation_digest === input.providerConfigGenerationDigest
    && row.runtime_owner_id === input.runtimeOwnerId && row.runtime_generation === input.runtimeGeneration
    && row.schema_generation === input.schemaGeneration
    && row.authority_snapshot_digest === input.authoritySnapshotDigest
    && row.journal_intent_digest === input.journalIntentDigest
    && row.lease_fence_digest === sha256(input.leaseFence);
}
function beginTupleMatches(row: Row, input: DeliveryBegin): boolean {
  return row.installation_begin_marker_id === input.installationBeginMarkerId
    && row.installation_begin_marker_digest === input.installationBeginMarkerDigest
    && row.scope_begin_marker_id === input.scopeBeginMarkerId
    && row.scope_begin_marker_digest === input.scopeBeginMarkerDigest;
}
function settlement(row: Row, leaseFence: string): DeliverySettlement {
  return { ...begun(row, row.lease_fence ?? leaseFence), outcome: row.state as DeliverySettlement["outcome"],
    evidenceDigest: row.evidence_digest!, ...(row.error_code ? { errorCode: row.error_code as DeliveryErrorCode } : {}),
    ...(row.external_resource_digest ? { externalResourceDigest: row.external_resource_digest } : {}),
    ...(row.external_resource_id ? { externalResourceId: row.external_resource_id } : {}) };
}

export function createPostgresDeliveryRepository(options: { pool: Pool; owner: RelayOwner;
  leaseOwner: string; leaseSeconds: number; now?: () => Date;
  testHooks?: { beforeCanonicalLock?(): Promise<void> } }): DeliveryKernelRepository {
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
      const binding = intent.providerBinding; const payload = payloadEnvelope(persistedPayload, intent, options.owner);
      const providerPayloadDigest = payloadDigest(payload); const truthKey = currentTruthKey(payload);
      const deadline = new Date(payload.frozenDeadline);
      await withTx(async (client) => {
        const explicitProjectionRevision = "projectionRevision" in intent
          && intent.projectionRevision !== undefined;
        const projectionRevision = explicitProjectionRevision ? intent.projectionRevision! : 1;
        const projectionPurpose="projectionPurpose" in intent?intent.projectionPurpose??"external":"external";
        const projectionEventSequence="projectionEventSequence" in intent?intent.projectionEventSequence??0:0;
        if (intent.provenance.kind === "business" && "projectionRevision" in intent
          && intent.projectionRevision !== undefined) {
          await options.testHooks?.beforeCanonicalLock?.();
          const canonical = await client.query<{ projection_revision: number; terminal_kind: string | null }>(
            `SELECT projection_revision,terminal_kind FROM cp_hosted_run
             WHERE organization_id=$1 AND run_id=$2 FOR UPDATE`,
            [intent.organizationId,intent.provenance.runId]);
          const run = canonical.rows[0];
          const terminalPhase = payload.phase === "terminal";
          if (!run || run.projection_revision !== intent.projectionRevision
            || terminalPhase !== (run.terminal_kind !== null)) {
            throw new Error("delivery_projection_revision_stale");
          }
        }
        if (explicitProjectionRevision) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [truthKey]);
          const same = await client.query("SELECT 1 FROM cp_provider_delivery_intent WHERE intent_id=$1",
            [intent.sideEffectIntentId]);
          if (!same.rows[0]) {
            if (intent.operation === "create") {
              const activeAnchor = await client.query(`SELECT 1 FROM cp_provider_delivery_intent
                WHERE current_truth_key=$1 AND intent->>'operation'='create'
                  AND state IN ('pending','leased','provider_io_begun','outcome_unknown') LIMIT 1`,
              [truthKey]);
              if (activeAnchor.rows[0]) throw new Error("delivery_anchor_pending");
            }
            const latest = await client.query<{ projection_revision:number;projection_event_sequence:number }>(
              `SELECT projection_revision,projection_event_sequence FROM cp_provider_delivery_intent
               WHERE current_truth_key=$1 ORDER BY projection_revision DESC,projection_event_sequence DESC LIMIT 1`,
            [truthKey]);
            const prior=latest.rows[0];
            if(prior&&(prior.projection_revision>projectionRevision
              ||(prior.projection_revision===projectionRevision
                &&prior.projection_event_sequence>=projectionEventSequence)))
              throw new Error("delivery_projection_revision_stale");
          }
        }
        const inserted = await client.query(`INSERT INTO cp_provider_delivery_intent(
            intent_id,organization_id,journal_intent_digest,intent,payload,payload_digest,payload_custody_ref,
            presentation_phase,current_truth_key,state,revision,sequence,
            scope_kind,scope_id,idempotency_key,provider_id,provider_instance_id,provider_binding_digest,
            provider_config_generation,provider_config_generation_digest,runtime_owner_id,runtime_generation,
            schema_generation,authority_snapshot_digest,status_message_id,run_id,projection_revision,
            projection_event_sequence,projection_purpose,
            deadline_at,created_at,updated_at)
            VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,'pending',1,$10,$11,$12,$13,$14,$15,
              $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$29)
            ON CONFLICT DO NOTHING RETURNING intent_id`,
          [intent.sideEffectIntentId, intent.organizationId, digest, JSON.stringify(intent), JSON.stringify(payload),
            providerPayloadDigest, `postgres-jsonb:${intent.sideEffectIntentId}:${providerPayloadDigest}`,
            payload.phase, truthKey, intent.initialAttemptSequence,
            intent.scope.kind, intent.scope.id, intent.idempotencyKey, binding.providerId,
            binding.providerInstanceId, binding.bindingDigest, binding.providerConfigGeneration,
            binding.providerConfigGenerationDigest, options.owner.runtimeOwnerId,
            options.owner.runtimeGeneration, options.owner.schemaGeneration, intent.authoritySnapshotDigest,
            "statusMessageId" in intent ? intent.statusMessageId ?? null : null,
            intent.provenance.kind === "business" ? intent.provenance.runId : null,
            projectionRevision,projectionEventSequence,projectionPurpose,deadline, new Date(intent.createdAt)]);
        await client.query(`INSERT INTO cp_provider_delivery_truth_lock(current_truth_key)
          VALUES($1) ON CONFLICT(current_truth_key) DO NOTHING`,[truthKey]);
        const existing = await client.query<Row>(
          "SELECT * FROM cp_provider_delivery_intent WHERE intent_id=$1 FOR UPDATE",
          [intent.sideEffectIntentId]);
        const row = existing.rows[0];
        if (!row || row.organization_id !== intent.organizationId
          || row.journal_intent_digest !== digest || row.payload_digest !== providerPayloadDigest
          || row.provider_id !== binding.providerId || row.provider_instance_id !== binding.providerInstanceId
          || row.provider_binding_digest !== binding.bindingDigest
          || row.provider_config_generation !== binding.providerConfigGeneration
          || row.provider_config_generation_digest !== binding.providerConfigGenerationDigest
          || row.runtime_owner_id !== options.owner.runtimeOwnerId
          || row.runtime_generation !== options.owner.runtimeGeneration
          || row.schema_generation !== options.owner.schemaGeneration
          || row.authority_snapshot_digest !== intent.authoritySnapshotDigest) {
          throw new Error(`delivery intent ${intent.sideEffectIntentId} conflict`);
        }
        if (inserted.rowCount === 1 && payload.phase === "terminal") {
          const at = now();
          await client.query(`UPDATE cp_provider_delivery_intent SET state='superseded', revision=revision+1,
            lease_owner=NULL,lease_expires_at=NULL,lease_fence=NULL,lease_fence_digest=NULL,
            superseded_by_intent_id=$1,evidence_digest=$2,error_code='delivery_superseded',
            outcome_recorded_at=$3,updated_at=$3 WHERE current_truth_key=$4
            AND intent_id<>$1 AND state IN ('pending','leased')
            AND presentation_phase IN ('received','running')`,
          [intent.sideEffectIntentId, sha256("opentag.delivery.superseded.v1"), at, truthKey]);
        } else if (inserted.rowCount === 1) {
          const at = now();
          await client.query(`UPDATE cp_provider_delivery_intent SET state='superseded', revision=revision+1,
            lease_owner=NULL,lease_expires_at=NULL,lease_fence=NULL,lease_fence_digest=NULL,
            superseded_by_intent_id=$1,evidence_digest=$2,error_code='delivery_superseded',
            outcome_recorded_at=$3,updated_at=$3 WHERE current_truth_key=$4
            AND intent_id<>$1 AND state IN ('pending','leased')
            AND presentation_phase IN ('received','running')`,
          [intent.sideEffectIntentId, sha256("opentag.delivery.superseded.v1"), at, truthKey]);
        }
      });
    },
    async claimNext(input = {}) {
      return withTx(async (client) => {
        const at = now();
        await client.query(`UPDATE cp_provider_delivery_intent SET state='attention', revision=revision+1,
          lease_owner=NULL,lease_expires_at=NULL,lease_fence=NULL,lease_fence_digest=NULL,
          evidence_digest=$1,error_code='delivery_deadline_exceeded',outcome_recorded_at=$2,updated_at=$2
          WHERE state IN ('pending','leased') AND deadline_at IS NOT NULL AND deadline_at <= $2`,
        [sha256("opentag.delivery.deadline-exceeded.v1"), at]);
        await client.query(`UPDATE cp_provider_delivery_intent SET state='pending',revision=revision+1,
          lease_owner=NULL,lease_expires_at=NULL,lease_fence=NULL,lease_fence_digest=NULL,updated_at=$1
          WHERE state='leased' AND lease_expires_at < $1`, [at]);
        const authorities = input.authorities;
        if (authorities?.length === 0) return null;
        const authorityParams: unknown[] = [];
        const authoritySql = authorities ? ` AND (${authorities.map((authority) => {
          const offset = 6 + authorityParams.length;
          authorityParams.push(authority.organizationId, authority.appId, authority.appInstanceId,
            authority.bindingDigest, authority.credentialGeneration, authority.credentialGenerationDigest);
          return `(organization_id=$${offset} AND provider_id=$${offset + 1}
            AND provider_instance_id=$${offset + 2} AND provider_binding_digest=$${offset + 3}
            AND provider_config_generation=$${offset + 4}
            AND provider_config_generation_digest=$${offset + 5})`;
        }).join(" OR ")})` : "";
        const fence = randomBytes(32).toString("base64url");
        const result = await client.query<Row>(`WITH truth AS (
          SELECT truth_lock.current_truth_key FROM cp_provider_delivery_truth_lock truth_lock
          WHERE EXISTS(SELECT 1 FROM cp_provider_delivery_intent pending
            WHERE pending.current_truth_key=truth_lock.current_truth_key
              AND pending.state='pending'${authoritySql})
            AND NOT EXISTS(SELECT 1 FROM cp_provider_delivery_intent blocker
              WHERE blocker.current_truth_key=truth_lock.current_truth_key
                AND blocker.state IN ('leased','provider_io_begun','outcome_unknown','attention'))
          ORDER BY (SELECT min(pending.created_at) FROM cp_provider_delivery_intent pending
            WHERE pending.current_truth_key=truth_lock.current_truth_key AND pending.state='pending'),
            truth_lock.current_truth_key
          FOR UPDATE SKIP LOCKED LIMIT 1), candidate AS (
          SELECT delivery.intent_id FROM cp_provider_delivery_intent delivery JOIN truth USING(current_truth_key)
          WHERE delivery.state='pending'${authoritySql}
          ORDER BY delivery.created_at,delivery.intent_id FOR UPDATE OF delivery SKIP LOCKED LIMIT 1)
          UPDATE cp_provider_delivery_intent delivery SET state='leased',revision=delivery.revision+1,
          lease_owner=$2,lease_expires_at=$3,lease_fence=$4,lease_fence_digest=$5,updated_at=$1
          FROM candidate WHERE delivery.intent_id=candidate.intent_id RETURNING delivery.*`,
        [at, options.leaseOwner, new Date(at.getTime() + options.leaseSeconds * 1000), fence, sha256(fence),
          ...authorityParams]);
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
        lease_owner=NULL,lease_expires_at=NULL,lease_fence=NULL,lease_fence_digest=NULL,updated_at=$1
        WHERE intent_id=$2 AND state='leased' AND revision=$3 AND lease_owner=$4 AND lease_fence_digest=$5`,
      [now(), input.intentId, input.revision, options.leaseOwner, sha256(input.leaseFence)]);
      return result.rowCount === 1;
    },
    async markBegin(input) {
      const at = now(); return withTx(async (client) => {
        const selected = await client.query<Row & { deadline_at: Date }>(
          "SELECT * FROM cp_provider_delivery_intent WHERE intent_id=$1 FOR UPDATE", [input.intentId]);
        const row = selected.rows[0];
        if (!row || row.state !== "leased" || !claimTupleMatches(row, input, input.revision)) return null;
        if (new Date(row.deadline_at).getTime() <= at.getTime()) {
          await client.query(`UPDATE cp_provider_delivery_intent SET state='attention',revision=revision+1,
            lease_owner=NULL,lease_expires_at=NULL,lease_fence=NULL,lease_fence_digest=NULL,
            evidence_digest=$1,error_code='delivery_deadline_exceeded',outcome_recorded_at=$2,updated_at=$2
            WHERE intent_id=$3 AND revision=$4`,
          [sha256("opentag.delivery.deadline-exceeded.v1"), at, input.intentId, input.revision]);
          return null;
        }
        const result = await client.query<Row>(`UPDATE cp_provider_delivery_intent
          SET state='provider_io_begun',revision=revision+1,installation_begin_marker_id=$1,
          installation_begin_marker_digest=$2,scope_begin_marker_id=$3,scope_begin_marker_digest=$4,
          begun_at=$5,updated_at=$5 WHERE intent_id=$6 AND revision=$7 RETURNING *`,
        [input.installationBeginMarkerId, input.installationBeginMarkerDigest,
          input.scopeBeginMarkerId, input.scopeBeginMarkerDigest, at, input.intentId, input.revision]);
        return result.rows[0] ? begun(result.rows[0], input.leaseFence) : null;
      });
    },
    async settleOrReadTerminal(input: DeliverySettlementInput) {
      if (!SHA256.test(input.evidenceDigest)) throw new Error("evidenceDigest must be a sha256 digest");
      if (input.errorCode && !errorCodes.has(input.errorCode))
        throw new Error(`unsupported delivery error code: ${input.errorCode}`);
      if (input.outcome === "accepted" ? input.errorCode !== undefined : input.errorCode === undefined)
        throw new Error("delivery outcome/error contract invalid");
      if ((input.externalResourceId === undefined) !== (input.externalResourceDigest === undefined)
        || (input.externalResourceId !== undefined && (input.outcome !== "accepted"
          || input.externalResourceId.length > 512 || !SHA256.test(input.externalResourceDigest!))))
        throw new Error("external resource identity contract invalid");
      const recordedAt = input.outcomeRecordedAt ? new Date(input.outcomeRecordedAt) : now();
      return withTx(async (client) => {
        const selected = await client.query<Row>(
          "SELECT * FROM cp_provider_delivery_intent WHERE intent_id=$1 FOR UPDATE", [input.intentId]);
        const row = selected.rows[0];
        if (!row || !beginTupleMatches(row, input))
          throw new Error(`delivery settlement tuple conflict for attempt ${input.attemptId}`);
        if (terminal.has(row.state)) {
          if (!claimTupleMatches(row, input, input.revision + 1))
            throw new Error(`delivery settlement tuple conflict for attempt ${input.attemptId}`);
          if (row.state !== input.outcome || row.evidence_digest !== input.evidenceDigest
            || (row.error_code ?? undefined) !== input.errorCode
            || (row.external_resource_digest ?? undefined) !== input.externalResourceDigest
            || (row.external_resource_id ?? undefined) !== input.externalResourceId)
            throw new Error(`delivery terminal replay conflict for attempt ${input.attemptId}`);
          return settlement(row, input.leaseFence);
        }
        if (row.state !== "provider_io_begun" || !claimTupleMatches(row, input, input.revision))
          throw new Error(`delivery settlement tuple conflict for attempt ${input.attemptId}`);
        const result = await client.query<Row>(`UPDATE cp_provider_delivery_intent SET state=$1,
          revision=revision+1,evidence_digest=$2,error_code=$3,external_resource_digest=$4,
          external_resource_id=$5,outcome_recorded_at=$6,updated_at=$6
          WHERE intent_id=$7 AND revision=$8 RETURNING *`,
        [input.outcome, input.evidenceDigest, input.errorCode ?? null,
          input.externalResourceDigest ?? null, input.externalResourceId ?? null,
          recordedAt, input.intentId, input.revision]);
        if (!result.rows[0]) throw new Error(`delivery settlement tuple conflict for attempt ${input.attemptId}`);
        return settlement(result.rows[0], input.leaseFence);
      });
    },
    async finalizeStrandedBegun(input) {
      const result = await options.pool.query(`UPDATE cp_provider_delivery_intent SET state='outcome_unknown',
        revision=revision+1,evidence_digest=$1,error_code='delivery_restart_after_begin',
        outcome_recorded_at=$2,updated_at=$2 WHERE state='provider_io_begun' AND begun_at < $3`,
      [input.evidenceDigest, input.outcomeRecordedAt ? new Date(input.outcomeRecordedAt) : now(), new Date(input.before)]);
      return result.rowCount ?? 0;
    },
    async findAcceptedExternalResource(input) {
      const result=await readExactDeliveryAnchor(options.pool,input);
      return result.outcome==="exact"?{outcome:"exact" as const,
        externalResourceId:result.externalResourceId,externalResourceDigest:result.externalResourceDigest}
        :result.outcome==="ambiguous"?{outcome:"ambiguous" as const}:{outcome:"none" as const};
    },
  };
}
