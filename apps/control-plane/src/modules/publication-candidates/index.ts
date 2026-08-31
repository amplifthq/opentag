import { canonicalJsonStringify } from "@opentag/control-protocol";
import { ProposalReadinessAssessmentSchema, PublicationCandidateSchema,
  type ProposalReadinessAssessment, type PublicationCandidate } from "@opentag/core";
import type { Pool } from "pg";
import type { PostgresTransactionClient } from "../../database/postgres.js";

type Queryable = PostgresTransactionClient;

export async function readPublicationCandidateInTransaction(client: Queryable, command: {
  organizationId: string; runId: string; attemptId: string;
}) {
  const result = await client.query<{ candidate: unknown; completion_assessment: unknown }>(
    `SELECT candidate, completion_assessment FROM cp_publication_candidate
     WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3 FOR UPDATE`,
    [command.organizationId, command.runId, command.attemptId],
  );
  return result.rows[0] ? {
    candidate: PublicationCandidateSchema.parse(result.rows[0].candidate),
    assessment: ProposalReadinessAssessmentSchema.parse(result.rows[0].completion_assessment),
  } : null;
}

export async function persistPublicationCandidateInTransaction(client: Queryable, command: {
  organizationId: string;
  attemptNumber: number;
  candidate: PublicationCandidate;
  assessment: ProposalReadinessAssessment;
}) {
    const parsed = PublicationCandidateSchema.safeParse(command.candidate);
    if (!parsed.success) throw new Error("PublicationCandidate invalid", { cause: parsed.error });
    const candidate = parsed.data;
    const assessment = ProposalReadinessAssessmentSchema.parse(command.assessment);
    if (candidate.verificationEvidenceIds.length === 0) {
      throw new Error("PublicationCandidate verification evidence is required.");
    }
    const existing = await client.query<{ candidate: unknown; completion_assessment: unknown }>(
      `SELECT candidate, completion_assessment FROM cp_publication_candidate
       WHERE organization_id = $1 AND (candidate_id = $2
         OR (run_id = $3 AND attempt_id = $4)) FOR UPDATE`,
      [command.organizationId, candidate.candidateId, candidate.runId, candidate.attemptId],
    );
    if (existing.rows[0]) {
      const stored = PublicationCandidateSchema.parse(existing.rows[0].candidate);
      const storedAssessment = ProposalReadinessAssessmentSchema.parse(
        existing.rows[0].completion_assessment);
      return canonicalJsonStringify(stored) === canonicalJsonStringify(candidate)
        && canonicalJsonStringify(storedAssessment) === canonicalJsonStringify(assessment)
        ? { kind: "replayed", candidate: stored } as const
        : { kind: "conflict", reason: "candidate_mismatch" } as const;
    }
    const inserted = await client.query<{ candidate: unknown }>(
      `INSERT INTO cp_publication_candidate(
         organization_id, candidate_id, run_id, attempt_id, attempt_number, project_target_id,
         frozen_base_revision, workspace_tree_digest, patch_digest, changed_files,
         verification_evidence_ids, publication_policy_digest, candidate,
         completion_assessment, created_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)
       ON CONFLICT DO NOTHING RETURNING candidate`,
      [command.organizationId, candidate.candidateId, candidate.runId,
        candidate.attemptId, command.attemptNumber, candidate.projectTargetId, candidate.frozenBaseRevision,
        candidate.workspaceTreeDigest, candidate.patchDigest, candidate.changedFiles,
        candidate.verificationEvidenceIds, candidate.publicationPolicyDigest,
        JSON.stringify(candidate), JSON.stringify(assessment), candidate.createdAt],
    );
    if (inserted.rows[0]) return { kind: "created", candidate } as const;
    const raced = await client.query<{ candidate: unknown; completion_assessment: unknown }>(
      `SELECT candidate, completion_assessment FROM cp_publication_candidate
       WHERE organization_id = $1 AND (candidate_id = $2
         OR (run_id = $3 AND attempt_id = $4)) FOR UPDATE`,
      [command.organizationId, candidate.candidateId, candidate.runId, candidate.attemptId],
    );
    const stored = raced.rows[0]
      ? PublicationCandidateSchema.parse(raced.rows[0].candidate) : null;
    const storedAssessment = raced.rows[0]
      ? ProposalReadinessAssessmentSchema.parse(raced.rows[0].completion_assessment) : null;
    return stored && storedAssessment
      && canonicalJsonStringify(stored) === canonicalJsonStringify(candidate)
      && canonicalJsonStringify(storedAssessment) === canonicalJsonStringify(assessment)
      ? { kind: "replayed", candidate: stored } as const
      : { kind: "conflict", reason: "candidate_mismatch" } as const;
  }

export function createPublicationCandidateRepository(input: { pool: Pool }) {
  return {
    async get(command: { organizationId: string; candidateId: string }) {
      const result = await input.pool.query<{ candidate: unknown }>(
        `SELECT candidate FROM cp_publication_candidate
         WHERE organization_id = $1 AND candidate_id = $2`,
        [command.organizationId, command.candidateId],
      );
      return result.rows[0]
        ? PublicationCandidateSchema.parse(result.rows[0].candidate) : null;
    },
  };
}
