import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicationCandidateRepository } from "../src/modules/publication-candidates/index.js";
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

  it("persists one immutable content-free candidate and replays only its exact identity", async () => {
    const repository = createPublicationCandidateRepository({ pool: fixture.pool });
    await expect(repository.put({ organizationId: "org_candidate", candidate }))
      .resolves.toEqual({ kind: "created", candidate });
    await expect(repository.put({ organizationId: "org_candidate", candidate }))
      .resolves.toEqual({ kind: "replayed", candidate });
    await expect(repository.put({
      organizationId: "org_candidate",
      candidate: { ...candidate, patchDigest: sha256("different-patch") },
    })).resolves.toEqual({ kind: "conflict", reason: "candidate_mismatch" });

    const row = await fixture.pool.query<{ candidate: unknown }>(
      "SELECT candidate FROM cp_publication_candidate WHERE organization_id = $1 AND candidate_id = $2",
      ["org_candidate", candidate.candidateId],
    );
    expect(row.rows[0]?.candidate).toEqual(candidate);
    expect(JSON.stringify(row.rows[0])).not.toMatch(/binary-patch|xoxb-|\/Users\//u);
  });

  it("rejects wrong run, attempt, base, policy, unsorted files, and missing verification", async () => {
    const repository = createPublicationCandidateRepository({ pool: fixture.pool });
    for (const malformed of [
      { ...candidate, candidateId: "candidate_wrong_run", runId: "" },
      { ...candidate, candidateId: "candidate_wrong_attempt", attemptId: "" },
      { ...candidate, candidateId: "candidate_wrong_base", frozenBaseRevision: "mutable" },
      { ...candidate, candidateId: "candidate_wrong_policy", publicationPolicyDigest: "policy" },
      { ...candidate, candidateId: "candidate_unsorted", changedFiles: ["z.ts", "a.ts"] },
      { ...candidate, candidateId: "candidate_unverified", verificationEvidenceIds: [] },
    ]) {
      await expect(repository.put({ organizationId: "org_candidate", candidate: malformed }))
        .rejects.toThrow(/PublicationCandidate/u);
    }
  });
});
