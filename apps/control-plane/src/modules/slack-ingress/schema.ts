import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text,
  timestamp, unique } from "drizzle-orm/pg-core";
import { sourceAppInstallations, sourceBindings } from "../source-ingress/schema.js";

export const slackInstallations = pgTable("cp_slack_installation", {
  organizationId: text("organization_id").notNull(),
  installationId: text("installation_id").notNull(),
  bindingId: text("binding_id").notNull(), teamId: text("team_id").notNull(),
  appId: text("app_id").notNull(), channelId: text("channel_id").notNull(),
  botUserId: text("bot_user_id").notNull(), signingSecretRef: text("signing_secret_ref").notNull(),
  memberUserIds: text("member_user_ids").array().notNull(),
  botTokenRef: text("bot_token_ref").notNull(),
  routeIdentity: text("route_identity").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.installationId] }),
  unique("cp_slack_installation_team_id_app_id_channel_id_key").on(
    table.teamId, table.appId, table.channelId),
  unique("cp_slack_installation_route_identity_key").on(table.routeIdentity),
  foreignKey({ columns: [table.organizationId, table.installationId], foreignColumns: [
    sourceAppInstallations.organizationId, sourceAppInstallations.installationId,
  ] }).onDelete("cascade"),
  foreignKey({ columns: [table.organizationId, table.bindingId], foreignColumns: [
    sourceBindings.organizationId, sourceBindings.bindingId,
  ] }),
  check("cp_slack_installation_identity_check", sql`${table.teamId} <> '' AND ${table.appId} <> ''
    AND ${table.channelId} <> '' AND ${table.botUserId} <> ''`),
  check("cp_slack_installation_secret_refs_check",
    sql`${table.signingSecretRef} <> '' AND ${table.botTokenRef} <> ''`),
  check("cp_slack_installation_members_check", sql`cardinality(${table.memberUserIds}) > 0`),
  check("cp_slack_installation_route_identity_check", sql`${table.routeIdentity} <> ''`),
]);

export const slackActionAuthorities = pgTable("cp_slack_action_authority", {
  organizationId: text("organization_id").notNull(), actionId: text("action_id").notNull(),
  actionTokenHash: text("action_token_hash").notNull(), installationId: text("installation_id").notNull(),
  bindingId: text("binding_id").notNull(), teamId: text("team_id").notNull(),
  appId: text("app_id").notNull(), channelId: text("channel_id").notNull(),
  threadRootMessageId: text("thread_root_message_id").notNull(), runId: text("run_id").notNull(),
  pendingRequestId: text("pending_request_id").notNull(), actionKind: text("action_kind").notNull(),
  actionDescriptor: jsonb("action_descriptor").notNull(),
  actionDescriptorDigest: text("action_descriptor_digest").notNull(),
  approvalEpoch: text("approval_epoch").notNull(), frozenCeiling: jsonb("frozen_ceiling").notNull(),
  frozenCeilingDigest: text("frozen_ceiling_digest").notNull(),
  policyDigest: text("policy_digest").notNull(), runnerId: text("runner_id").notNull(),
  attemptId: text("attempt_id").notNull(), attemptNumber: integer("attempt_number").notNull(),
  projectionGeneration: integer("projection_generation").notNull(),
  authorityFamilyId: text("authority_family_id").notNull(), authorityEpoch: integer("authority_epoch").notNull(),
  claimState: text("claim_state").notNull(), claimedAt: timestamp("claimed_at", { withTimezone: true }),
  attemptEpoch: integer("attempt_epoch").notNull(), fencingTokenDigest: text("fencing_token_digest").notNull(),
  permissionRequestDigest: text("permission_request_digest").notNull(),
  pendingActionId: text("pending_action_id").notNull(),
  publicationApproval: jsonb("publication_approval"),
  allowedDecisions: text("allowed_decisions").array().notNull(),
  requesterUserId: text("requester_user_id"), operatorUserIds: text("operator_user_ids").array().notNull(),
  memberUserIds: text("member_user_ids").array().notNull(),
  approverUserId: text("approver_user_id"), adminUserIds: text("admin_user_ids").array().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.actionId] }),
  unique("cp_slack_action_authority_action_token_hash_key").on(table.actionTokenHash),
  foreignKey({ columns: [table.organizationId, table.installationId], foreignColumns: [
    slackInstallations.organizationId, slackInstallations.installationId,
  ] }).onDelete("cascade"),
  foreignKey({ columns: [table.organizationId, table.bindingId], foreignColumns: [
    sourceBindings.organizationId, sourceBindings.bindingId,
  ] }),
  check("cp_slack_action_authority_kind_check",
    sql`${table.actionKind} IN ('status','cancel','approval','publication','bind','unbind')`),
  check("cp_slack_action_authority_decisions_check", sql`cardinality(${table.allowedDecisions}) > 0
    AND ${table.allowedDecisions} <@ ARRAY['status','cancel','allow_once','allow_run','deny','publication_approve','bind','unbind']::text[]`),
  check("cp_slack_action_authority_members_check", sql`cardinality(${table.memberUserIds}) > 0`),
  check("cp_slack_action_authority_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  check("cp_slack_action_authority_attempt_number_check", sql`${table.attemptNumber} > 0`),
  check("cp_slack_action_authority_projection_generation_check", sql`${table.projectionGeneration} > 0`),
  check("cp_slack_action_authority_epoch_check", sql`${table.authorityEpoch} > 0`),
  check("cp_slack_action_authority_claim_state_check", sql`${table.claimState} IN ('available','claimed','consumed')`),
  check("cp_slack_action_authority_claim_shape_check", sql`
    (${table.claimState}='available' AND ${table.claimedAt} IS NULL AND ${table.consumedAt} IS NULL)
    OR (${table.claimState}='claimed' AND ${table.claimedAt} IS NOT NULL AND ${table.consumedAt} IS NULL)
    OR (${table.claimState}='consumed' AND ${table.consumedAt} IS NOT NULL)`),
  check("cp_slack_action_authority_publication_shape_check",
    sql`(${table.actionKind} = 'publication') = (${table.publicationApproval} IS NOT NULL)`),
  index("cp_slack_action_authority_lookup_idx").on(table.organizationId,
    table.installationId, table.channelId, table.threadRootMessageId),
  index("cp_slack_action_authority_family_idx").on(table.organizationId,
    table.authorityFamilyId, table.claimState),
]);
