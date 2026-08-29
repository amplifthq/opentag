import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey,
  text, timestamp, unique } from "drizzle-orm/pg-core";
import { organizations } from "../identity/schema.js";

export const sourceAppInstallations = pgTable("cp_source_app_installation", {
  organizationId: text("organization_id").notNull().references(() => organizations.organizationId),
  installationId: text("installation_id").notNull(), sourceAppId: text("source_app_id").notNull(),
  appInstanceId: text("app_instance_id").notNull(), bindingDigest: text("binding_digest").notNull(),
  credentialGeneration: integer("credential_generation").notNull(),
  credentialGenerationDigest: text("credential_generation_digest").notNull(),
  state: text("state").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.installationId] }),
  check("cp_source_app_installation_state_check", sql`${table.state} IN ('active', 'disabled')`),
  check("cp_source_app_installation_generation_check", sql`${table.credentialGeneration} > 0`),
  unique("cp_source_app_installation_instance_key").on(
    table.organizationId, table.sourceAppId, table.appInstanceId,
  ),
]);

export const sourceBindings = pgTable("cp_source_binding", {
  organizationId: text("organization_id").notNull(), bindingId: text("binding_id").notNull(),
  installationId: text("installation_id").notNull(), bindingDigest: text("binding_digest").notNull(),
  state: text("state").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.bindingId] }),
  foreignKey({ columns: [table.organizationId, table.installationId], foreignColumns: [
    sourceAppInstallations.organizationId, sourceAppInstallations.installationId,
  ] }).onDelete("cascade"),
  check("cp_source_binding_state_check", sql`${table.state} IN ('active', 'disabled')`),
  index("cp_source_binding_installation_idx").on(table.organizationId, table.installationId),
]);

export const ingressReservations = pgTable("cp_ingress_reservation", {
  reservationId: text("reservation_id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.organizationId),
  installationId: text("installation_id").notNull(), bindingId: text("binding_id").notNull(),
  sourceAppId: text("source_app_id").notNull(), sourceDeliveryId: text("source_delivery_id").notNull(),
  sourceMessageId: text("source_message_id").notNull(), sourceVersionRef: text("source_version_ref").notNull(),
  rawDigest: text("raw_digest").notNull(), contentId: text("content_id").notNull(),
  contentAadDigest: text("content_aad_digest").notNull(), contentKeyVersion: text("content_key_version").notNull(),
  state: text("state").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  foreignKey({ columns: [table.organizationId, table.bindingId], foreignColumns: [
    sourceBindings.organizationId, sourceBindings.bindingId,
  ] }),
  unique("cp_ingress_reservation_delivery_key").on(
    table.organizationId, table.installationId, table.sourceDeliveryId,
  ),
  unique("cp_ingress_reservation_tenant_key").on(table.organizationId, table.reservationId),
  check("cp_ingress_reservation_state_check", sql`${table.state} IN ('pending', 'resolved')`),
  index("cp_ingress_reservation_pending_idx").on(table.state, table.createdAt),
]);

export const sourceResolutions = pgTable("cp_source_resolution", {
  resolutionId: text("resolution_id").primaryKey(), organizationId: text("organization_id").notNull(),
  reservationId: text("reservation_id").notNull(), resolution: jsonb("resolution").notNull(),
  operatorAttention: boolean("operator_attention").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  foreignKey({ columns: [table.organizationId, table.reservationId], foreignColumns: [
    ingressReservations.organizationId, ingressReservations.reservationId,
  ] }).onDelete("cascade"),
  unique("cp_source_resolution_reservation_key").on(table.organizationId, table.reservationId),
  check("cp_source_resolution_kind_check", sql`${table.resolution}->>'kind' IN (
    'accepted','waiting_for_runner','follow_up_queued','binding_change_pending',
    'setup_required','not_authorized','invalid_request','rate_limited','queue_full',
    'storage_quota_exceeded','source_content_deleted','temporarily_unavailable'
  )`),
]);
