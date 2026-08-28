import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
import { runMigrations } from "../src/database/migrations.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("relay source content envelope custody", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const clock = { now: () => new Date("2026-08-28T00:00:00.000Z") };
  const key = randomBytes(32);

  beforeEach(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    await fixture.pool.query(
      "INSERT INTO cp_organization(organization_id, display_name) VALUES($1, $2)",
      ["org_a", "A"],
    );
  });
  afterEach(async () => fixture.close());

  const content = () => ({
    organizationId: "org_a",
    installationId: "install_1",
    sourceAppId: "slack",
    sourceDeliveryId: "delivery_1",
    sourceMessageId: "message_1",
    sourceVersionRef: "slack:message_1:v1",
    purpose: "source_context" as const,
    contentId: "content_1",
    payload: { text: "fix this", channel: "private" },
    expiresAt: new Date("2026-09-04T00:00:00.000Z"),
  });

  it("catches tenant, source-version, or purpose substitution during decryption", async () => {
    const custody = createRelayContentCustody({
      pool: fixture.pool, clock, key: { key, keyVersion: "v1" },
    });
    await custody.store(content());
    const grant = await custody.issueReadGrant({
      organizationId: "org_a", runId: "run_1", attemptId: "attempt_1",
      fenceDigest: "fence_1", contentIds: ["content_1"],
      purpose: "source_context", expiresAt: new Date("2026-08-28T00:05:00.000Z"),
    });
    await expect(custody.read({
      ...grant, organizationId: "org_other", runId: "run_1",
      attemptId: "attempt_1", fenceDigest: "fence_1",
      contentIds: ["content_1"], purpose: "source_context",
    })).rejects.toThrow("source_content_context_mismatch");
    await expect(custody.read({
      ...grant, organizationId: "org_a", runId: "run_1",
      attemptId: "attempt_1", fenceDigest: "fence_1",
      contentIds: ["content_1"], purpose: "source_context",
    })).resolves.toEqual([{ contentId: "content_1", payload: content().payload }]);
  });

  it("catches process-local encryption that cannot survive restart", async () => {
    const first = createRelayContentCustody({
      pool: fixture.pool, clock, key: { key, keyVersion: "v1" },
    });
    await first.store(content());
    const restarted = createRelayContentCustody({
      pool: fixture.pool, clock, key: { key: Buffer.from(key), keyVersion: "v1" },
    });
    expect(await restarted.checkReadiness()).toEqual({ ready: true });
    const grant = await restarted.issueReadGrant({
      organizationId: "org_a", runId: "run_2", attemptId: "attempt_2",
      fenceDigest: "fence_2", contentIds: ["content_1"], purpose: "source_context",
      expiresAt: new Date("2026-08-28T00:05:00.000Z"),
    });
    await expect(restarted.read({ ...grant, organizationId: "org_a", runId: "run_2",
      attemptId: "attempt_2", fenceDigest: "fence_2", contentIds: ["content_1"],
      purpose: "source_context" })).resolves.toHaveLength(1);
  });

  it("catches accepting a missing or wrong operator KEK and leaking plaintext to PostgreSQL", async () => {
    const custody = createRelayContentCustody({
      pool: fixture.pool, clock, key: { key, keyVersion: "v1" },
    });
    await custody.store(content());
    const wrong = createRelayContentCustody({
      pool: fixture.pool, clock,
      key: { key: randomBytes(32), keyVersion: "v1" },
    });
    expect(await wrong.checkReadiness()).toEqual({
      ready: false, reason: "configuration_invalid",
    });
    const stored = await fixture.pool.query("SELECT row_to_json(c)::text AS row FROM cp_source_content c");
    expect(stored.rows[0]?.row).not.toContain("fix this");
    expect(stored.rows[0]?.row).not.toContain("private");
    expect(stored.rows[0]?.row).not.toContain(key.toString("base64"));
  });

  it("catches backups that lose encrypted content, revocation, or replay tombstones", async () => {
    let mutableNow = new Date("2026-08-28T00:00:00.000Z");
    const authority = { async invalidate(input: { commandId: string; organizationId: string;
      sourceVersionRef: string }) {
      return { commandId: input.commandId, organizationId: input.organizationId,
        sourceVersionRef: input.sourceVersionRef, reason: "source_content_deleted" as const,
        recordedAt: "2026-08-28T00:00:00.000Z",
        authorityReceiptDigest: `sha256:${"a".repeat(64)}` };
    } };
    const original = createRelayContentCustody({ pool: fixture.pool,
      clock: { now: () => mutableNow }, key: { key, keyVersion: "v1" },
      invalidationAuthority: authority });
    const makeContent = (contentId: string, version: string) => ({
      ...content(), contentId, sourceDeliveryId: `delivery_${contentId}`,
      sourceMessageId: `message_${contentId}`, sourceVersionRef: version,
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    });
    await original.store(makeContent("active", "s:active:v1"));
    await original.store(makeContent("revoked", "s:revoked:v1"));
    await original.store(makeContent("purged", "s:purged:v1"));
    const revokedGrant = await original.issueReadGrant({ organizationId: "org_a",
      runId: "run_revoked", attemptId: "attempt_revoked", fenceDigest: "fence_revoked",
      contentIds: ["revoked"], purpose: "source_context",
      expiresAt: new Date("2026-12-01T00:00:00.000Z") });
    await original.withdraw({ schemaVersion: 1, kind: "verified_source_withdrawal",
      organizationId: "org_a", sourceVersionRef: "s:revoked:v1",
      commandId: "withdraw_restore", verification: { installationId: "install_1",
        sourceAppId: "slack", sourceDeliveryId: "delivery_revoked",
        verifiedAt: "2026-08-28T00:00:00.000Z",
        evidenceDigest: `sha256:${"b".repeat(64)}` } });
    await original.markTerminal({ organizationId: "org_a", contentId: "purged" });
    mutableNow = new Date("2026-09-04T00:00:01.000Z");
    await original.purge();

    const restoreDatabase = `opentag_source_restore_${randomBytes(8).toString("hex")}`;
    const restoreUrl = new URL(TEST_DATABASE_URL!);
    restoreUrl.pathname = `/${restoreDatabase}`;
    let restoredPool: Pool | undefined;
    try {
      await fixture.admin.query(`CREATE DATABASE ${restoreDatabase}`);
      restoredPool = new Pool({ connectionString: restoreUrl.toString(), max: 4 });
      await runMigrations(restoredPool, fixture.migrations);
      const tables = [
        ["cp_organization", ["organization_id", "display_name", "created_at"]],
        ["cp_source_content", ["organization_id", "content_id", "installation_id",
          "source_app_id", "source_delivery_id", "source_message_id", "source_version_ref",
          "purpose", "ciphertext", "content_nonce", "content_tag", "wrapped_dek",
          "wrapping_nonce", "wrapping_tag", "aad_digest", "key_version", "expires_at",
          "terminal_at", "deleted_at", "created_at"]],
        ["cp_source_content_read_grant", ["grant_id", "organization_id", "token_hash",
          "run_id", "attempt_id", "fence_digest", "content_ids", "purpose", "expires_at",
          "consumed_at", "revoked_at", "created_at"]],
        ["cp_source_replay_tombstone", ["organization_id", "replay_identity_digest",
          "source_version_digest", "command_id", "request_digest", "invalidation_receipt",
          "created_at", "expires_at"]],
      ] as const;
      for (const [table, columns] of tables) {
        const exported = await fixture.pool.query(
          `SELECT ${columns.join(", ")} FROM ${table}`,
        );
        for (const row of exported.rows) await restoredPool.query(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES(${columns.map(
            (_, index) => `$${index + 1}`,
          ).join(", ")})`,
          columns.map((column) => row[column]),
        );
      }
      const restarted = createRelayContentCustody({ pool: restoredPool,
        clock: { now: () => mutableNow }, key: { key: Buffer.from(key), keyVersion: "v1" },
        invalidationAuthority: authority });
      const fresh = await restarted.issueReadGrant({ organizationId: "org_a", runId: "run_fresh",
        attemptId: "attempt_fresh", fenceDigest: "fence_fresh", contentIds: ["active"],
        purpose: "source_context", expiresAt: new Date("2026-12-01T00:00:00.000Z") });
      await expect(restarted.read({ ...fresh, organizationId: "org_a", runId: "run_fresh",
        attemptId: "attempt_fresh", fenceDigest: "fence_fresh", contentIds: ["active"],
        purpose: "source_context" })).resolves.toHaveLength(1);
      await expect(restarted.read({ ...revokedGrant, organizationId: "org_a",
        runId: "run_revoked", attemptId: "attempt_revoked", fenceDigest: "fence_revoked",
        contentIds: ["revoked"], purpose: "source_context" }))
        .rejects.toThrow("source_content_deleted");
      await expect(restarted.store(makeContent("purged", "s:purged:v1")))
        .rejects.toThrow("source_content_replayed");
    } finally {
      await restoredPool?.end();
      await fixture.admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
        [restoreDatabase],
      );
      await fixture.admin.query(`DROP DATABASE IF EXISTS ${restoreDatabase}`);
    }
  });
});
