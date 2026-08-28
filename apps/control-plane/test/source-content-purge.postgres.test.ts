import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("source content lifecycle purge", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let now = new Date("2026-08-28T00:00:00Z");
  beforeEach(async () => { fixture = await createIsolatedPostgres(); await fixture.migrate();
    await fixture.pool.query("INSERT INTO cp_organization VALUES($1,$2,$3)", ["org_a", "A", now]); });
  afterEach(async () => fixture.close());

  it("catches retaining terminal ciphertext past seven days or reconstructable tombstones", async () => {
    const custody = createRelayContentCustody({ pool: fixture.pool, clock: { now: () => now },
      key: { key: randomBytes(32), keyVersion: "v1" } });
    await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
      sourceDeliveryId: "delivery", sourceMessageId: "message", sourceVersionRef: "s:v1",
      purpose: "source_context", contentId: "content_1", payload: { text: "purge me" },
      expiresAt: new Date("2026-09-01T00:00:00Z") });
    await custody.markTerminal({ organizationId: "org_a", contentId: "content_1" });
    now = new Date("2026-09-04T00:00:01Z");
    expect(await custody.purge()).toEqual({ purged: 1, tombstonesExpired: 0 });
    expect((await fixture.pool.query("SELECT count(*)::int AS count FROM cp_source_content")).rows[0]?.count).toBe(0);
    const tombstone = await fixture.pool.query("SELECT to_jsonb(t)::text AS body, expires_at FROM cp_source_replay_tombstone t");
    expect(tombstone.rows[0]?.body).not.toContain("purge me");
    expect(tombstone.rows[0]?.body).not.toContain("ciphertext");
    await expect(custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
      sourceDeliveryId: "delivery", sourceMessageId: "message", sourceVersionRef: "s:v1",
      purpose: "source_context", contentId: "content_1", payload: { text: "replay" },
      expiresAt: new Date("2026-09-05T00:00:00Z") })).rejects.toThrow("source_content_replayed");
  });
});
