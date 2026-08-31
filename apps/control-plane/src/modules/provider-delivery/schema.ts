import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, unique,
  uniqueIndex } from "drizzle-orm/pg-core";

export const providerDeliveryIntents = pgTable("cp_provider_delivery_intent", {
  intentId: text("intent_id").primaryKey(), organizationId: text("organization_id").notNull(),
  journalIntentDigest: text("journal_intent_digest").notNull(),
  intent: jsonb("intent").notNull(), payload: jsonb("payload").notNull(),
  payloadDigest: text("payload_digest").notNull(), payloadCustodyRef: text("payload_custody_ref").notNull(),
  presentationPhase: text("presentation_phase").notNull(), currentTruthKey: text("current_truth_key").notNull(),
  state: text("state").notNull(),
  revision: integer("revision").notNull(), sequence: integer("sequence").notNull(),
  scopeKind: text("scope_kind").notNull(), scopeId: text("scope_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(), providerId: text("provider_id").notNull(),
  providerInstanceId: text("provider_instance_id").notNull(), providerBindingDigest: text("provider_binding_digest").notNull(),
  providerConfigGeneration: integer("provider_config_generation").notNull(),
  providerConfigGenerationDigest: text("provider_config_generation_digest").notNull(),
  runtimeOwnerId: text("runtime_owner_id").notNull(), runtimeGeneration: integer("runtime_generation").notNull(),
  schemaGeneration: integer("schema_generation").notNull(), authoritySnapshotDigest: text("authority_snapshot_digest").notNull(),
  statusMessageId: text("status_message_id"), runId: text("run_id"),
  projectionRevision: integer("projection_revision"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseFence: text("lease_fence"), leaseFenceDigest: text("lease_fence_digest"), installationBeginMarkerId: text("installation_begin_marker_id"),
  installationBeginMarkerDigest: text("installation_begin_marker_digest"), scopeBeginMarkerId: text("scope_begin_marker_id"),
  scopeBeginMarkerDigest: text("scope_begin_marker_digest"), begunAt: timestamp("begun_at", { withTimezone: true }),
  evidenceDigest: text("evidence_digest"), errorCode: text("error_code"),
  externalResourceDigest: text("external_resource_digest"), externalResourceId: text("external_resource_id"),
  outcomeRecordedAt: timestamp("outcome_recorded_at", { withTimezone: true }), deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  supersededByIntentId: text("superseded_by_intent_id"), createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  unique("cp_provider_delivery_intent_journal_digest_key").on(table.journalIntentDigest),
  unique("cp_provider_delivery_intent_idempotency_key").on(table.organizationId, table.scopeKind, table.scopeId,
    table.providerId, table.providerInstanceId, table.idempotencyKey),
  check("cp_provider_delivery_intent_revision_check", sql`${table.revision} > 0 AND ${table.sequence} > 0
    AND ${table.providerConfigGeneration} > 0 AND ${table.runtimeGeneration} > 0 AND ${table.schemaGeneration} > 0`),
  check("cp_provider_delivery_intent_state_check", sql`${table.state} IN
    ('pending','leased','provider_io_begun','accepted','rejected','outcome_unknown','attention','superseded')`),
  check("cp_provider_delivery_intent_phase_check", sql`${table.presentationPhase} IN ('received','running','terminal')`),
  check("cp_provider_delivery_error_code_check", sql`${table.errorCode} IS NULL OR ${table.errorCode} IN
    ('provider_adapter_not_registered','delivery_request_preparation_failed','delivery_request_digest_mismatch',
     'delivery_payload_custody_unavailable','provider_binding_mismatch','invalid_delivery_shape','provider_5xx',
     'malformed_response','slack_rejected','ambiguous_response','deadline_exceeded','transport_error',
     'provider_delivery_timeout','provider_delivery_exception','provider_result_invalid','delivery_settlement_stale',
     'delivery_restart_after_begin','delivery_deadline_exceeded','delivery_superseded')`),
  check("cp_provider_delivery_intent_shape_check", sql`
    (${table.state} = 'pending' AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL
      AND ${table.leaseFence} IS NULL AND ${table.leaseFenceDigest} IS NULL
      AND ${table.installationBeginMarkerId} IS NULL AND ${table.installationBeginMarkerDigest} IS NULL
      AND ${table.scopeBeginMarkerId} IS NULL AND ${table.scopeBeginMarkerDigest} IS NULL
      AND ${table.begunAt} IS NULL
      AND ${table.evidenceDigest} IS NULL AND ${table.errorCode} IS NULL
      AND ${table.externalResourceId} IS NULL AND ${table.externalResourceDigest} IS NULL
      AND ${table.supersededByIntentId} IS NULL AND ${table.outcomeRecordedAt} IS NULL)
    OR (${table.state} = 'leased' AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL
      AND ${table.leaseFence} IS NOT NULL AND ${table.leaseFenceDigest} IS NOT NULL
      AND ${table.installationBeginMarkerId} IS NULL AND ${table.installationBeginMarkerDigest} IS NULL
      AND ${table.scopeBeginMarkerId} IS NULL AND ${table.scopeBeginMarkerDigest} IS NULL
      AND ${table.begunAt} IS NULL
      AND ${table.evidenceDigest} IS NULL AND ${table.errorCode} IS NULL
      AND ${table.externalResourceId} IS NULL AND ${table.externalResourceDigest} IS NULL
      AND ${table.supersededByIntentId} IS NULL AND ${table.outcomeRecordedAt} IS NULL)
    OR (${table.state} = 'provider_io_begun' AND ${table.leaseOwner} IS NOT NULL
      AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.leaseFence} IS NOT NULL
      AND ${table.leaseFenceDigest} IS NOT NULL AND ${table.begunAt} IS NOT NULL
      AND ${table.installationBeginMarkerId} IS NOT NULL AND ${table.installationBeginMarkerDigest} IS NOT NULL
      AND ${table.scopeBeginMarkerId} IS NOT NULL AND ${table.scopeBeginMarkerDigest} IS NOT NULL
      AND ${table.evidenceDigest} IS NULL AND ${table.errorCode} IS NULL
      AND ${table.externalResourceId} IS NULL AND ${table.externalResourceDigest} IS NULL
      AND ${table.supersededByIntentId} IS NULL AND ${table.outcomeRecordedAt} IS NULL)
    OR (${table.state} IN ('accepted','rejected','outcome_unknown','attention')
      AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL
      AND ${table.leaseFence} IS NOT NULL AND ${table.leaseFenceDigest} IS NOT NULL
      AND ${table.installationBeginMarkerId} IS NOT NULL AND ${table.installationBeginMarkerDigest} IS NOT NULL
      AND ${table.scopeBeginMarkerId} IS NOT NULL AND ${table.scopeBeginMarkerDigest} IS NOT NULL
      AND ${table.begunAt} IS NOT NULL
      AND ${table.evidenceDigest} IS NOT NULL AND ${table.outcomeRecordedAt} IS NOT NULL
      AND ${table.supersededByIntentId} IS NULL
      AND ((${table.state}='accepted' AND ${table.errorCode} IS NULL) OR (${table.state}<>'accepted' AND ${table.errorCode} IS NOT NULL))
      AND ((${table.externalResourceId} IS NULL AND ${table.externalResourceDigest} IS NULL)
        OR (${table.state}='accepted' AND ${table.externalResourceId} IS NOT NULL AND ${table.externalResourceDigest} IS NOT NULL)))
    OR (${table.state}='attention' AND ${table.begunAt} IS NULL AND ${table.leaseOwner} IS NULL
      AND ${table.leaseExpiresAt} IS NULL AND ${table.leaseFence} IS NULL AND ${table.leaseFenceDigest} IS NULL
      AND ${table.installationBeginMarkerId} IS NULL AND ${table.installationBeginMarkerDigest} IS NULL
      AND ${table.scopeBeginMarkerId} IS NULL AND ${table.scopeBeginMarkerDigest} IS NULL
      AND ${table.externalResourceId} IS NULL AND ${table.externalResourceDigest} IS NULL
      AND ${table.supersededByIntentId} IS NULL
      AND ${table.evidenceDigest} IS NOT NULL AND ${table.errorCode}='delivery_deadline_exceeded'
      AND ${table.outcomeRecordedAt} IS NOT NULL)
    OR (${table.state}='superseded' AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL
      AND ${table.leaseFence} IS NULL AND ${table.leaseFenceDigest} IS NULL AND ${table.begunAt} IS NULL
      AND ${table.installationBeginMarkerId} IS NULL AND ${table.installationBeginMarkerDigest} IS NULL
      AND ${table.scopeBeginMarkerId} IS NULL AND ${table.scopeBeginMarkerDigest} IS NULL
      AND ${table.externalResourceId} IS NULL AND ${table.externalResourceDigest} IS NULL
      AND ${table.evidenceDigest} IS NOT NULL AND ${table.errorCode}='delivery_superseded'
      AND ${table.outcomeRecordedAt} IS NOT NULL AND ${table.supersededByIntentId} IS NOT NULL)`),
  index("cp_provider_delivery_claim_idx").on(table.state, table.leaseExpiresAt, table.createdAt, table.intentId),
  index("cp_provider_delivery_external_resource_idx").on(table.runId, table.statusMessageId,
    table.providerId, table.providerInstanceId, table.externalResourceId),
  uniqueIndex("cp_provider_delivery_one_terminal_idx").on(table.currentTruthKey)
    .where(sql`${table.presentationPhase} = 'terminal'`),
]);
