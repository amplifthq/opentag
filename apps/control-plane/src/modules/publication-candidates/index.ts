import { PublicationCandidateSchema } from "@opentag/core";
import type { Pool } from "pg";

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
