import { canonicalJsonStringify } from "@opentag/control-protocol";
import { PublicationCandidateSchema, type PublicationCandidate } from "@opentag/core";
import type { Pool } from "pg";
import type { PostgresTransactionClient } from "../../database/postgres.js";

type Queryable = PostgresTransactionClient;

export function createPublicationCandidateRepository(input: { pool: Pool }) {
  async function putWithClient(client: Queryable, command: {
    organizationId: string;
    candidate: PublicationCandidate;
  }) {
    const parsed = PublicationCandidateSchema.safeParse(command.candidate);
    if (!parsed.success) throw new Error("PublicationCandidate invalid", { cause: parsed.error });
    const candidate = parsed.data;
    if (candidate.verificationEvidenceIds.length === 0) {
      throw new Error("PublicationCandidate verification evidence is required.");
    }
    const existing = await client.query<{ candidate: unknown }>(
      `SELECT candidate FROM cp_publication_candidate
       WHERE organization_id = $1 AND candidate_id = $2 FOR UPDATE`,
      [command.organizationId, candidate.candidateId],
    );
    if (existing.rows[0]) {
      const stored = PublicationCandidateSchema.parse(existing.rows[0].candidate);
      return canonicalJsonStringify(stored) === canonicalJsonStringify(candidate)
        ? { kind: "replayed", candidate: stored } as const
        : { kind: "conflict", reason: "candidate_mismatch" } as const;
    }
    const conflictingAttempt = await client.query(
      `SELECT 1 FROM cp_publication_candidate
       WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3 FOR UPDATE`,
      [command.organizationId, candidate.runId, candidate.attemptId],
    );
    if (conflictingAttempt.rows[0]) {
      return { kind: "conflict", reason: "candidate_mismatch" } as const;
    }
    await client.query(
      `INSERT INTO cp_publication_candidate(
         organization_id, candidate_id, run_id, attempt_id, project_target_id,
         frozen_base_revision, workspace_tree_digest, patch_digest, changed_files,
         verification_evidence_ids, publication_policy_digest, candidate, created_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
      [command.organizationId, candidate.candidateId, candidate.runId,
        candidate.attemptId, candidate.projectTargetId, candidate.frozenBaseRevision,
        candidate.workspaceTreeDigest, candidate.patchDigest, candidate.changedFiles,
        candidate.verificationEvidenceIds, candidate.publicationPolicyDigest,
        JSON.stringify(candidate), candidate.createdAt],
    );
    return { kind: "created", candidate } as const;
  }

  return {
    put: (command: { organizationId: string; candidate: PublicationCandidate }) =>
      putWithClient(input.pool as unknown as PostgresTransactionClient, command),
    putInTransaction: (client: Queryable, command: {
      organizationId: string; candidate: PublicationCandidate;
    }) => putWithClient(client, command),
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
