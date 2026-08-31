import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organizations } from "../identity/schema.js";
import { hostedAttempts } from "../hosted-runs/schema.js";

export const publicationCandidates = pgTable("cp_publication_candidate", {
  organizationId: text("organization_id").notNull()
    .references(() => organizations.organizationId),
  candidateId: text("candidate_id").notNull(),
  runId: text("run_id").notNull(),
  attemptId: text("attempt_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  projectTargetId: text("project_target_id").notNull(),
  frozenBaseRevision: text("frozen_base_revision").notNull(),
  workspaceTreeDigest: text("workspace_tree_digest").notNull(),
  patchDigest: text("patch_digest").notNull(),
  changedFiles: text("changed_files").array().notNull(),
  verificationEvidenceIds: text("verification_evidence_ids").array().notNull(),
  publicationPolicyDigest: text("publication_policy_digest").notNull(),
  candidate: jsonb("candidate").notNull(),
  completionAssessment: jsonb("completion_assessment").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.candidateId] }),
  unique("cp_publication_candidate_organization_run_attempt_key")
    .on(table.organizationId, table.runId, table.attemptId),
  foreignKey({ name: "cp_publication_candidate_attempt_fk",
    columns: [table.organizationId, table.runId, table.attemptNumber, table.attemptId],
    foreignColumns: [hostedAttempts.organizationId, hostedAttempts.runId,
      hostedAttempts.attemptNumber, hostedAttempts.attemptId] }),
  check("cp_publication_candidate_verification_check",
    sql`cardinality(${table.verificationEvidenceIds}) > 0`),
  check("cp_publication_candidate_changed_files_check",
    sql`cardinality(${table.changedFiles}) > 0`),
  check("cp_publication_candidate_base_revision_check",
    sql`${table.frozenBaseRevision} ~ '^[a-f0-9]{40,64}$'`),
  check("cp_publication_candidate_tree_digest_check",
    sql`${table.workspaceTreeDigest} ~ '^[a-f0-9]{40,64}$'`),
  check("cp_publication_candidate_patch_digest_check",
    sql`${table.patchDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  check("cp_publication_candidate_policy_digest_check",
    sql`${table.publicationPolicyDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  check("cp_publication_candidate_content_free_check", sql`(
    jsonb_typeof(${table.candidate}) = 'object'
    AND NOT ${table.candidate} ?| ARRAY[
      'baseToFinalBinaryDiff', 'limitations', 'workspacePath', 'logs', 'output', 'secret'
    ]
  )`),
  index("cp_publication_candidate_run_idx").on(table.organizationId, table.runId),
]);

export const publicationIntents = pgTable("cp_publication_intent", {
  organizationId: text("organization_id").notNull()
    .references(() => organizations.organizationId),
  intentId: text("intent_id").notNull(),
  runId: text("run_id").notNull(),
  attemptId: text("attempt_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  candidateId: text("candidate_id").notNull(),
  candidateDigest: text("candidate_digest").notNull(),
  approvalId: text("approval_id").notNull(),
  approverId: text("approver_id").notNull(),
  repository: jsonb("repository").notNull(),
  branch: text("branch").notNull(),
  expectedHeadSha: text("expected_head_sha").notNull(),
  runnerId: text("runner_id").notNull(),
  runnerGeneration: integer("runner_generation").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.intentId] }),
  unique("cp_publication_intent_candidate_key")
    .on(table.organizationId, table.candidateId),
  check("cp_publication_intent_digest_check",
    sql`${table.candidateDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  check("cp_publication_intent_head_check",
    sql`${table.expectedHeadSha} ~ '^[a-f0-9]{40,64}$'`),
  check("cp_publication_intent_expiry_check", sql`${table.expiresAt} > ${table.approvedAt}`),
]);

export const publicationBranchOwnership = pgTable("cp_publication_branch_ownership", {
  organizationId: text("organization_id").notNull(),
  ownershipId: text("ownership_id").notNull(),
  intentId: text("intent_id").notNull(),
  repository: jsonb("repository").notNull(),
  branch: text("branch").notNull(),
  expectedHeadSha: text("expected_head_sha").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.ownershipId] }),
  unique("cp_publication_branch_owner_key")
    .on(table.organizationId, table.repository, table.branch),
  foreignKey({ columns: [table.organizationId, table.intentId],
    foreignColumns: [publicationIntents.organizationId, publicationIntents.intentId] }),
]);

export const publicationCapabilities = pgTable("cp_publication_capability", {
  organizationId: text("organization_id").notNull(),
  capabilityId: text("capability_id").notNull(),
  intentId: text("intent_id").notNull(),
  operationId: text("operation_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  step: text("step").notNull(),
  capabilityDigest: text("capability_digest").notNull(),
  capability: jsonb("capability").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.capabilityId] }),
  foreignKey({ columns: [table.organizationId, table.intentId],
    foreignColumns: [publicationIntents.organizationId, publicationIntents.intentId] }),
  check("cp_publication_capability_step_check",
    sql`${table.step} IN ('push_owned_branch','create_draft_pull_request')`),
]);

export const publicationBegins = pgTable("cp_publication_begin", {
  organizationId: text("organization_id").notNull(),
  capabilityId: text("capability_id").notNull(),
  operationId: text("operation_id").notNull(),
  begunAt: timestamp("begun_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.capabilityId] }),
  foreignKey({ columns: [table.organizationId, table.capabilityId],
    foreignColumns: [publicationCapabilities.organizationId, publicationCapabilities.capabilityId] }),
]);

export const publicationReceipts = pgTable("cp_publication_receipt", {
  organizationId: text("organization_id").notNull(),
  receiptId: text("receipt_id").notNull(),
  capabilityId: text("capability_id").notNull(),
  operationId: text("operation_id").notNull(),
  outcome: text("outcome").notNull(),
  receiptDigest: text("receipt_digest").notNull(),
  receipt: jsonb("receipt").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.receiptId] }),
  foreignKey({ columns: [table.organizationId, table.capabilityId],
    foreignColumns: [publicationCapabilities.organizationId, publicationCapabilities.capabilityId] }),
  check("cp_publication_receipt_outcome_check",
    sql`${table.outcome} IN ('succeeded','failed','outcome_unknown')`),
]);

export const publicationReconciliations = pgTable("cp_publication_reconciliation", {
  organizationId: text("organization_id").notNull(),
  reconciliationId: text("reconciliation_id").notNull(),
  capabilityId: text("capability_id").notNull(),
  operationId: text("operation_id").notNull(),
  observation: jsonb("observation").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.reconciliationId] }),
  unique("cp_publication_reconciliation_capability_key")
    .on(table.organizationId, table.capabilityId),
  foreignKey({ columns: [table.organizationId, table.capabilityId],
    foreignColumns: [publicationCapabilities.organizationId, publicationCapabilities.capabilityId] }),
]);

export const publicationCompletions = pgTable("cp_publication_completion", {
  organizationId: text("organization_id").notNull(), completionId: text("completion_id").notNull(),
  runId: text("run_id").notNull(), attemptId: text("attempt_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(), fencingTokenDigest: text("fencing_token_digest").notNull(),
  candidateId: text("candidate_id").notNull(), candidateDigest: text("candidate_digest").notNull(),
  intentId: text("intent_id").notNull(), ownershipId: text("ownership_id").notNull(),
  pushOperationId: text("push_operation_id").notNull(), pushReceiptDigest: text("push_receipt_digest").notNull(),
  pullRequestOperationId: text("pull_request_operation_id").notNull(),
  pullRequestReceiptDigest: text("pull_request_receipt_digest").notNull(),
  pullRequestExternalId: text("pull_request_external_id").notNull(),
  pullRequestExternalDigest: text("pull_request_external_digest").notNull(),
  repository: jsonb("repository").notNull(), remote: text("remote").notNull(),
  baseBranch: text("base_branch").notNull(), branch: text("branch").notNull(),
  expectedHeadSha: text("expected_head_sha").notNull(), observedHeadSha: text("observed_head_sha").notNull(),
  requiredCheckNames: text("required_check_names").array().notNull(), evidenceDigest: text("evidence_digest").notNull(),
  completionDecision: jsonb("completion_decision").notNull(), observation: jsonb("observation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.completionId] }),
  unique("cp_publication_completion_run_key").on(table.organizationId, table.runId),
  foreignKey({ columns: [table.organizationId, table.intentId],
    foreignColumns: [publicationIntents.organizationId, publicationIntents.intentId] }),
  foreignKey({ columns: [table.organizationId, table.ownershipId],
    foreignColumns: [publicationBranchOwnership.organizationId, publicationBranchOwnership.ownershipId] }),
]);
