import { sql } from "drizzle-orm";
import {
  boolean, check, customType, foreignKey, index, jsonb, pgTable,
  primaryKey, text, timestamp, unique, uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "../identity/schema.js";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const sourceContents = pgTable("cp_source_content", {
  organizationId: text("organization_id").notNull().references(() => organizations.organizationId),
  contentId: text("content_id").notNull(),
  installationId: text("installation_id").notNull(),
  sourceAppId: text("source_app_id").notNull(),
  sourceDeliveryId: text("source_delivery_id").notNull(),
  sourceMessageId: text("source_message_id").notNull(),
  sourceVersionRef: text("source_version_ref").notNull(),
  purpose: text("purpose").notNull(),
  ciphertext: bytea("ciphertext"), contentNonce: bytea("content_nonce"),
  contentTag: bytea("content_tag"), wrappedDek: bytea("wrapped_dek"),
  wrappingNonce: bytea("wrapping_nonce"), wrappingTag: bytea("wrapping_tag"),
  aadDigest: text("aad_digest").notNull(), keyVersion: text("key_version").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.contentId] }),
  check("cp_source_content_crypto_shred_check", sql`(
    (${table.deletedAt} IS NULL AND ${table.ciphertext} IS NOT NULL
      AND ${table.contentNonce} IS NOT NULL AND ${table.contentTag} IS NOT NULL
      AND ${table.wrappedDek} IS NOT NULL AND ${table.wrappingNonce} IS NOT NULL
      AND ${table.wrappingTag} IS NOT NULL)
    OR (${table.deletedAt} IS NOT NULL AND ${table.ciphertext} IS NULL
      AND ${table.contentNonce} IS NULL AND ${table.contentTag} IS NULL
      AND ${table.wrappedDek} IS NULL AND ${table.wrappingNonce} IS NULL
      AND ${table.wrappingTag} IS NULL)
  )`),
  index("cp_source_content_source_version_idx").on(table.organizationId, table.sourceVersionRef, table.contentId),
  index("cp_source_content_purge_idx").on(table.terminalAt, table.expiresAt),
]);

export const sourceContentDependencies = pgTable("cp_source_content_dependency", {
  organizationId: text("organization_id").notNull(), contentId: text("content_id").notNull(),
  sourceVersionRef: text("source_version_ref").notNull(), dependencyId: text("dependency_id").notNull(),
  terminal: boolean("terminal").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.contentId, table.dependencyId] }),
  foreignKey({ columns: [table.organizationId, table.contentId],
    foreignColumns: [sourceContents.organizationId, sourceContents.contentId] }).onDelete("cascade"),
  index("cp_source_content_dependency_version_idx").on(table.organizationId, table.sourceVersionRef, table.terminal),
]);

export const sourceContentReadGrants = pgTable("cp_source_content_read_grant", {
  grantId: text("grant_id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.organizationId),
  tokenHash: text("token_hash").notNull(), runId: text("run_id").notNull(),
  attemptId: text("attempt_id").notNull(), fenceDigest: text("fence_digest").notNull(),
  contentIds: text("content_ids").array().notNull(), purpose: text("purpose").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  unique("cp_source_content_read_grant_token_hash_key").on(table.tokenHash),
  check("cp_source_content_read_grant_content_ids_check", sql`cardinality(${table.contentIds}) > 0`),
  index("cp_source_content_read_grant_active_idx").on(table.organizationId, table.expiresAt)
    .where(sql`${table.consumedAt} IS NULL AND ${table.revokedAt} IS NULL`),
]);

export const sourceReplayTombstones = pgTable("cp_source_replay_tombstone", {
  organizationId: text("organization_id").notNull().references(() => organizations.organizationId),
  replayIdentityDigest: text("replay_identity_digest").notNull(),
  sourceVersionDigest: text("source_version_digest").notNull(), commandId: text("command_id"),
  requestDigest: text("request_digest"), invalidationReceipt: jsonb("invalidation_receipt"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.replayIdentityDigest] }),
  check("cp_source_replay_tombstone_receipt_check", sql`(
    ${table.invalidationReceipt} IS NULL OR (
      jsonb_typeof(${table.invalidationReceipt}) = 'object'
      AND ${table.invalidationReceipt} ?& ARRAY[
        'commandId', 'organizationId', 'sourceVersionRef', 'reason',
        'recordedAt', 'authorityReceiptDigest'
      ]
      AND ${table.invalidationReceipt} - ARRAY[
        'commandId', 'organizationId', 'sourceVersionRef', 'reason',
        'recordedAt', 'authorityReceiptDigest'
      ] = '{}'::jsonb
      AND ${table.invalidationReceipt}->>'reason' = 'source_content_deleted'
      AND ${table.invalidationReceipt}->>'authorityReceiptDigest'
        ~ '^sha256:[a-f0-9]{64}$'
      AND length(${table.invalidationReceipt}->>'commandId') BETWEEN 1 AND 512
      AND length(${table.invalidationReceipt}->>'organizationId') BETWEEN 1 AND 512
      AND length(${table.invalidationReceipt}->>'sourceVersionRef') BETWEEN 1 AND 512
      AND length(${table.invalidationReceipt}->>'recordedAt') BETWEEN 1 AND 64
    )
  )`),
  index("cp_source_replay_tombstone_expiry_idx").on(table.expiresAt),
  uniqueIndex("cp_source_replay_tombstone_command_idx").on(table.organizationId, table.commandId)
    .where(sql`${table.commandId} IS NOT NULL`),
]);
