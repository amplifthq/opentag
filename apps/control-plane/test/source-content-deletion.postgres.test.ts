import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("authenticated source withdrawal", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const now = new Date("2026-08-28T00:00:00Z");
  beforeEach(async () => { fixture = await createIsolatedPostgres(); await fixture.migrate();
    await fixture.pool.query("INSERT INTO cp_organization VALUES($1,$2,$3)", ["org_a", "A", now]); });
  afterEach(async () => fixture.close());

  it("catches unauthenticated deletion, plaintext retention, and duplicate invalidation after replay", async () => {
    const calls: unknown[] = [];
    const receipt = { receiptId: "receipt_1", commandId: "withdraw_1", digest: "immutable_1" };
    const custody = createRelayContentCustody({ pool: fixture.pool, clock: { now: () => now },
      key: { key: randomBytes(32), keyVersion: "v1" }, invalidationAuthority: {
        async invalidate(input) { calls.push(input); return receipt; },
      } });
    await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
      sourceDeliveryId: "d", sourceMessageId: "m", sourceVersionRef: "s:v1",
      purpose: "source_context", contentId: "content_1", payload: { text: "erase me" },
      expiresAt: new Date("2026-09-01T00:00:00Z") });
    await custody.addDependency({ organizationId: "org_a", contentId: "content_1",
      sourceVersionRef: "s:v1", dependencyId: "intent_1", terminal: false });
    await expect(custody.withdraw({ organizationId: "org_a", sourceVersionRef: "s:v1",
      commandId: "withdraw_1", authenticated: false })).rejects.toThrow("source_withdrawal_unauthorized");
    await expect(custody.withdraw({ organizationId: "org_a", sourceVersionRef: "s:v1",
      commandId: "withdraw_1", authenticated: true })).resolves.toEqual(receipt);
    await expect(custody.withdraw({ organizationId: "org_a", sourceVersionRef: "s:v1",
      commandId: "withdraw_1", authenticated: true })).resolves.toEqual(receipt);
    await expect(custody.withdraw({ organizationId: "org_a", sourceVersionRef: "s:v1",
      commandId: "withdraw_2", authenticated: true })).rejects
      .toThrow("source_withdrawal_conflict");
    expect(calls).toHaveLength(1);
    const content = await fixture.pool.query("SELECT ciphertext, wrapped_dek, deleted_at FROM cp_source_content");
    expect(content.rows[0]).toMatchObject({ ciphertext: null, wrapped_dek: null });
    expect(content.rows[0]?.deleted_at).toBeInstanceOf(Date);
    expect(JSON.stringify(calls)).not.toContain("erase me");
  });

  it("catches a withdrawal winner releasing plaintext through a concurrent grant read", async () => {
    const custody = createRelayContentCustody({ pool: fixture.pool, clock: { now: () => now },
      key: { key: randomBytes(32), keyVersion: "v1" }, invalidationAuthority: {
        async invalidate(input) { return { receiptId: "r", commandId: input.commandId, digest: "d" }; },
      } });
    await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
      sourceDeliveryId: "d", sourceMessageId: "m", sourceVersionRef: "s:v1",
      purpose: "source_context", contentId: "content_1", payload: { text: "secret" },
      expiresAt: new Date("2026-09-01T00:00:00Z") });
    const grant = await custody.issueReadGrant({ organizationId: "org_a", runId: "run",
      attemptId: "attempt", fenceDigest: "fence", contentIds: ["content_1"], purpose: "source_context",
      expiresAt: new Date("2026-08-28T00:01:00Z") });
    await custody.withdraw({ organizationId: "org_a", sourceVersionRef: "s:v1",
      commandId: "withdraw", authenticated: true });
    await expect(custody.read({ ...grant, organizationId: "org_a", runId: "run",
      attemptId: "attempt", fenceDigest: "fence", contentIds: ["content_1"],
      purpose: "source_context" })).rejects.toThrow("source_content_deleted");
  });
});
