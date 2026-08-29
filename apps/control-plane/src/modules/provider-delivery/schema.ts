import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

export const providerDeliveryIntents = pgTable("cp_provider_delivery_intent", {
  intentId: text("intent_id").primaryKey(), journalIntentDigest: text("journal_intent_digest").notNull(),
  intent: jsonb("intent").notNull(), payload: jsonb("payload").notNull(),
  payloadCustodyRef: text("payload_custody_ref").notNull(), state: text("state").notNull(),
  revision: integer("revision").notNull(), sequence: integer("sequence").notNull(),
  scopeKind: text("scope_kind").notNull(), scopeId: text("scope_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(), providerId: text("provider_id").notNull(),
  providerInstanceId: text("provider_instance_id").notNull(), providerBindingDigest: text("provider_binding_digest").notNull(),
  providerConfigGeneration: integer("provider_config_generation").notNull(),
  providerConfigGenerationDigest: text("provider_config_generation_digest").notNull(),
  runtimeOwnerId: text("runtime_owner_id").notNull(), runtimeGeneration: integer("runtime_generation").notNull(),
  schemaGeneration: integer("schema_generation").notNull(), authoritySnapshotDigest: text("authority_snapshot_digest").notNull(),
  statusMessageId: text("status_message_id"), runId: text("run_id"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseFenceDigest: text("lease_fence_digest"), installationBeginMarkerId: text("installation_begin_marker_id"),
  installationBeginMarkerDigest: text("installation_begin_marker_digest"), scopeBeginMarkerId: text("scope_begin_marker_id"),
  scopeBeginMarkerDigest: text("scope_begin_marker_digest"), begunAt: timestamp("begun_at", { withTimezone: true }),
  evidenceDigest: text("evidence_digest"), errorCode: text("error_code"),
  externalResourceDigest: text("external_resource_digest"), externalResourceId: text("external_resource_id"),
  outcomeRecordedAt: timestamp("outcome_recorded_at", { withTimezone: true }), deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  supersededByIntentId: text("superseded_by_intent_id"), createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  unique("cp_provider_delivery_intent_journal_digest_key").on(table.journalIntentDigest),
  unique("cp_provider_delivery_intent_idempotency_key").on(table.scopeKind, table.scopeId,
    table.providerId, table.providerInstanceId, table.idempotencyKey),
  check("cp_provider_delivery_intent_revision_check", sql`${table.revision} > 0 AND ${table.sequence} > 0
    AND ${table.providerConfigGeneration} > 0 AND ${table.runtimeGeneration} > 0 AND ${table.schemaGeneration} > 0`),
  check("cp_provider_delivery_intent_state_check", sql`${table.state} IN
    ('pending','leased','provider_io_begun','accepted','rejected','outcome_unknown','attention','superseded')`),
  index("cp_provider_delivery_claim_idx").on(table.state, table.leaseExpiresAt, table.createdAt, table.intentId),
  index("cp_provider_delivery_external_resource_idx").on(table.runId, table.statusMessageId,
    table.providerId, table.providerInstanceId, table.externalResourceId),
]);
