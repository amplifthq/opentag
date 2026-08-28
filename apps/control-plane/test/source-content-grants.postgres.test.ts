import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("one-time source content grants", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let now = new Date("2026-08-28T00:00:00.000Z");
  beforeEach(async () => {
    fixture = await createIsolatedPostgres(); await fixture.migrate();
    await fixture.pool.query("INSERT INTO cp_organization VALUES($1,$2,$3)", ["org_a", "A", now]);
  });
  afterEach(async () => fixture.close());

  it("catches token persistence, replay, stale fence, wrong Attempt, wrong content, and expiry", async () => {
    const custody = createRelayContentCustody({ pool: fixture.pool,
      clock: { now: () => now }, key: { key: randomBytes(32), keyVersion: "v1" } });
    for (const contentId of ["content_1", "content_2"]) {
      await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
        sourceDeliveryId: "d", sourceMessageId: "m", sourceVersionRef: "s:v1",
        purpose: "source_context", contentId, payload: { text: contentId },
        expiresAt: new Date("2026-09-01T00:00:00Z") });
    }
    const grant = await custody.issueReadGrant({ organizationId: "org_a", runId: "run_1",
      attemptId: "attempt_1", fenceDigest: "fence_1", contentIds: ["content_1"],
      purpose: "source_context", expiresAt: new Date("2026-08-28T00:01:00Z") });
    const exact = { ...grant, organizationId: "org_a", runId: "run_1", attemptId: "attempt_1",
      fenceDigest: "fence_1", contentIds: ["content_1"], purpose: "source_context" as const };
    for (const mutation of [
      { ...exact, attemptId: "attempt_other" },
      { ...exact, fenceDigest: "fence_stale" },
      { ...exact, contentIds: ["content_2"] },
    ]) await expect(custody.read(mutation)).rejects.toThrow("source_content_grant_invalid");
    await expect(custody.read(exact)).resolves.toHaveLength(1);
    await expect(custody.read(exact)).rejects.toThrow("source_content_grant_consumed");
    const row = await fixture.pool.query("SELECT token_hash, to_jsonb(g)::text AS body FROM cp_source_content_read_grant g");
    expect(row.rows[0]?.token_hash).not.toBe(grant.token);
    expect(row.rows[0]?.body).not.toContain(grant.token);

    const expired = await custody.issueReadGrant({ organizationId: "org_a", runId: "run_2",
      attemptId: "attempt_2", fenceDigest: "fence_2", contentIds: ["content_2"],
      purpose: "source_context", expiresAt: new Date("2026-08-28T00:02:00Z") });
    now = new Date("2026-08-28T00:03:00Z");
    await expect(custody.read({ ...expired, organizationId: "org_a", runId: "run_2",
      attemptId: "attempt_2", fenceDigest: "fence_2", contentIds: ["content_2"],
      purpose: "source_context" })).rejects.toThrow("source_content_grant_expired");
  });
});
