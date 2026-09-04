import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceAppDefinition } from "@opentag/source-app-runtime";
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
import { createDurableJobQueue } from "../src/modules/jobs/index.js";
import { createSourceIngressService } from "../src/modules/source-ingress/index.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const bindingDigest = digest("binding_1");
const generationDigest = digest("generation_1");
const sourceApp = (): SourceAppDefinition<unknown, unknown, unknown> => ({
  appId: "fixture-source", protocol: "opentag.channel.v1",
  capabilities: { threads: true, messageUpdate: true, reactions: false,
    interactiveActions: false, attachments: "metadata", authenticatedDeletion: true,
    stableSourceVersions: true },
  installation: { organizationId: "org_a", appInstanceId: "instance_1", bindingDigest,
    credentialGeneration: 1, credentialGenerationDigest: generationDigest },
  ingress: { verify: async (input) => input, normalize: () => null },
  context: { readThread: async () => ({ messages: [], truncated: false, decodedBytes: 0 }) },
  presentation: { render: () => ({}) },
  delivery: { prepare: () => ({}), deliver: async () => ({ status: "failed",
    error: { code: "unused", retryable: false } }), reconcile: async () => ({ status: "failed",
    error: { code: "unused", retryable: false } }) },
});

describe.skipIf(!TEST_DATABASE_URL)("Source ingress transaction crash boundaries", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const now = new Date("2026-08-28T00:00:00.000Z");

  beforeEach(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    await fixture.pool.query("INSERT INTO cp_organization VALUES($1,$2,$3)", ["org_a", "A", now]);
    await fixture.pool.query(
      `INSERT INTO cp_source_app_installation VALUES(
        $1,$2,$3,$4,$5,$6,$7,'active',$8,$8)`,
      ["org_a", "install_1", "fixture-source", "instance_1", bindingDigest, 1, generationDigest, now],
    );
    await fixture.pool.query(
      `INSERT INTO cp_source_binding VALUES($1,$2,$3,$4,'active',$5,$5)`,
      ["org_a", "binding_1", "install_1", bindingDigest, now],
    );
  });
  afterEach(async () => fixture.close());

  const reserve = () => {
    const clock = { now: () => now };
    return createSourceIngressService({
    pool: fixture.pool, clock,
    custody: createRelayContentCustody({ pool: fixture.pool, clock,
      key: { key: randomBytes(32), keyVersion: "v1" } }),
    jobs: createDurableJobQueue({ pool: fixture.pool, clock,
      leaseDurationMs: 30_000, tokenFactory: () => "lease_1" }),
  }).reserve({ organizationId: "org_a", installationId: "install_1", bindingId: "binding_1",
    sourceApp: sourceApp(), sourceDeliveryId: "evt_1", sourceMessageId: "message_1",
    sourceVersionRef: "fixture:message_1:v1", rawDigest: digest("raw"),
    normalizedContent: { secretText: "never persist me in metadata" },
    expiresAt: new Date("2026-09-04T00:00:00.000Z") });
  };

  for (const boundary of [
    { table: "cp_ingress_reservation", timing: "AFTER" },
    { table: "cp_source_content", timing: "AFTER" },
    { table: "cp_job", timing: "AFTER" },
  ] as const) {
    it(`returns no ack permission and rolls back after ${boundary.table} write failure`, async () => {
      await fixture.pool.query(`
        CREATE FUNCTION fail_ingress_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected_ingress_write_failure'; END $$;
        CREATE TRIGGER fail_ingress_write ${boundary.timing} INSERT ON ${boundary.table}
        FOR EACH ROW EXECUTE FUNCTION fail_ingress_write();
      `);
      await expect(reserve()).resolves.toEqual({ outcome: "unavailable", mayAcknowledge: false });
      const counts = await fixture.pool.query(
        `SELECT (SELECT count(*)::int FROM cp_ingress_reservation) AS reservations,
                (SELECT count(*)::int FROM cp_source_content) AS contents,
                (SELECT count(*)::int FROM cp_job) AS jobs`,
      );
      expect(counts.rows[0]).toEqual({ reservations: 0, contents: 0, jobs: 0 });
    });
  }
});
