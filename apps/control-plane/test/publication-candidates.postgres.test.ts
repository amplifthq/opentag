import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicationCandidateRepository } from "../src/modules/publication-candidates/index.js";
import * as publicationCandidateModule from "../src/modules/publication-candidates/index.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe.skipIf(!TEST_DATABASE_URL)("PublicationCandidate PostgreSQL repository", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    await fixture.pool.query(
      `INSERT INTO cp_organization(organization_id, display_name, created_at)
       VALUES('org_candidate', 'Candidate', clock_timestamp())`,
    );
  });

  afterAll(async () => fixture.close());

  const candidate = {
    candidateId: "candidate_1",
    runId: "run_candidate_1",
    attemptId: "attempt_candidate_1",
    projectTargetId: "target_candidate_1",
    frozenBaseRevision: "a".repeat(40),
    workspaceTreeDigest: "b".repeat(40),
    patchDigest: sha256("binary-patch"),
    changedFiles: ["packages/core/src/schema.ts"],
    verificationEvidenceIds: [sha256("verification")],
    publicationPolicyDigest: sha256("proposal-only-policy"),
    createdAt: "2026-08-15T07:00:00.000Z",
  } as const;

  it("exposes no out-of-transaction Candidate write and rejects orphan persistence", async () => {
    const repository = createPublicationCandidateRepository({ pool: fixture.pool });
    expect("put" in repository).toBe(false);
    expect("persistPublicationCandidateInTransaction" in publicationCandidateModule).toBe(false);
    await expect(fixture.pool.query(
      `INSERT INTO cp_publication_candidate(
         organization_id, candidate_id, run_id, attempt_id, attempt_number,
         project_target_id, frozen_base_revision, workspace_tree_digest,
         patch_digest, changed_files, verification_evidence_ids,
         publication_policy_digest, candidate, completion_assessment, created_at)
       VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)`,
      ["org_candidate", candidate.candidateId, candidate.runId, candidate.attemptId,
        candidate.projectTargetId, candidate.frozenBaseRevision,
        candidate.workspaceTreeDigest, candidate.patchDigest, candidate.changedFiles,
        candidate.verificationEvidenceIds, candidate.publicationPolicyDigest,
        JSON.stringify(candidate), JSON.stringify({ state: "proposal_ready", accepted: true,
          candidateId: candidate.candidateId, reasonCodes: ["proposal_ready"],
          assessedAt: candidate.createdAt }), candidate.createdAt],
    )).rejects.toThrow(/foreign key|cp_publication_candidate_attempt_fk/iu);
  });

  it("keeps the public repository read-only", async () => {
    const repository = createPublicationCandidateRepository({ pool: fixture.pool });
    await expect(repository.get({ organizationId: "org_candidate", candidateId: "missing" }))
      .resolves.toBeNull();
  });
});
