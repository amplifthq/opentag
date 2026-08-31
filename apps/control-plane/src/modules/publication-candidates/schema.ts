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
    columns: [table.organizationId, table.runId, table.attemptNumber],
    foreignColumns: [hostedAttempts.organizationId, hostedAttempts.runId,
      hostedAttempts.attemptNumber] }),
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
