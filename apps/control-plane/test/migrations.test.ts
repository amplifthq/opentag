import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkMigrationReadiness,
  loadSqlMigrations,
  runMigrations,
  type SqlMigration,
} from "../src/database/migrations.js";

type RecordedQuery = { text: string; values?: readonly unknown[] };

function migrationHarness(
  applied: Array<{ name: string; checksum: string }> = [],
  options: { failUnlock?: boolean; schemaReady?: boolean } = {},
) {
  const queries: RecordedQuery[] = [];
  let released = 0;
  const client = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push(values ? { text, values } : { text });
      if (text.includes("SELECT name, checksum")) return { rows: applied };
      if (text.includes("AS schema_ready")) {
        return { rows: [{ schema_ready: options.schemaReady ?? true }] };
      }
      if (options.failUnlock && text.includes("pg_advisory_unlock")) {
        throw new Error("unlock_failed");
      }
      return { rows: [], rowCount: 1 };
    },
    release() { released += 1; },
  };
  return {
    pool: {
      async connect() { return client; },
      async query(text: string, values?: readonly unknown[]) { return client.query(text, values); },
    },
    queries,
    released: () => released,
  };
}

const migration = (name: string, sql: string): SqlMigration => ({
  name,
  sql,
  checksum: createHash("sha256").update(sql).digest("hex"),
});

describe("fresh PostgreSQL baseline", () => {
  it("ships one direct 38-table baseline without retired schema history", async () => {
    const migrations = await loadSqlMigrations(join(process.cwd(), "apps/control-plane/migrations"));
    expect(migrations.map(({ name }) => name)).toEqual([
      "0000_control_plane.sql", "0001_slack_delivery_observation.sql",
    ]);
    const sql = migrations[0]!.sql;
    expect(sql.match(/^CREATE TABLE cp_/gmu)).toHaveLength(38);
    expect(sql).toContain("CREATE TABLE cp_effect (");
    expect(sql).toContain("CREATE TABLE cp_slack_binding (");
    expect(sql).toContain("CREATE TRIGGER cp_effect_projection");
    expect(sql).toContain("CREATE TRIGGER cp_hosted_run_projection_after_trigger");
    expect(sql).not.toContain("cp_projection_job_v2_authority");
    expect(sql).not.toContain("payload_custody_ref");
    expect(sql).not.toMatch(/CREATE\s+VIEW/iu);
    expect(sql).not.toMatch(/CREATE\s+SCHEMA/iu);
    expect(sql).not.toMatch(/\b(?:cp_publication_(?:intent|branch_ownership|capability|begin|receipt|reconciliation|completion)|cp_source_app_installation|cp_source_binding|cp_slack_installation|cp_job_settlement|cp_source_resolution|cp_source_resolution_admission|cp_source_content_dependency|cp_hosted_claim|cp_projection_job_v2_authority|payload_custody_ref|app_instance_id)\b/u);
    const truthLock = /CREATE TABLE cp_provider_delivery_truth_lock \([\s\S]*?\n\);/u.exec(sql)?.[0];
    expect(truthLock).toBeDefined();
    expect(truthLock).not.toContain("created_at");
    const runner = /CREATE TABLE cp_runner \([\s\S]*?\n\);/u.exec(sql)?.[0];
    expect(runner).toBeDefined();
    expect(runner).not.toContain("display_name");
  });

  it("serializes baseline application and records its reviewed checksum", async () => {
    const harness = migrationHarness();
    const baseline = migration("0000_control_plane.sql", "CREATE TABLE example(id text)");
    await runMigrations(harness.pool, [baseline]);
    expect(harness.queries.map(({ text }) => text)).toEqual([
      "SELECT pg_advisory_lock($1)",
      expect.stringContaining("CREATE TABLE IF NOT EXISTS control_plane_migrations"),
      expect.stringContaining("SELECT name, checksum"),
      "BEGIN",
      baseline.sql,
      expect.stringContaining("INSERT INTO control_plane_migrations"),
      "COMMIT",
      "SELECT pg_advisory_unlock($1)",
    ]);
    expect(harness.queries[5]?.values).toEqual([baseline.name, baseline.checksum]);
    expect(harness.released()).toBe(1);
  });

  it("refuses an edited applied baseline", async () => {
    const current = migration("0000_control_plane.sql", "SELECT 2");
    const harness = migrationHarness([{ name: current.name, checksum: "edited" }]);
    await expect(runMigrations(harness.pool, [current]))
      .rejects.toThrow("migration_checksum_mismatch");
    expect(harness.released()).toBe(1);
  });

  it("refuses any applied migration name absent from the fresh image", async () => {
    const current = migration("0000_control_plane.sql", "SELECT 1");
    const harness = migrationHarness([
      { name: current.name, checksum: current.checksum },
      { name: "0025_runner_identity.sql", checksum: "retired" },
    ]);
    await expect(runMigrations(harness.pool, [current]))
      .rejects.toThrow("migration_unknown_applied");
    expect(harness.released()).toBe(1);
  });

  it("releases the client even when advisory unlock fails", async () => {
    const harness = migrationHarness([], { failUnlock: true });
    await expect(runMigrations(harness.pool, [])).rejects.toThrow("unlock_failed");
    expect(harness.released()).toBe(1);
  });

  it("fails readiness closed for missing, edited, or extra migration state", async () => {
    const current = migration("0000_control_plane.sql", "SELECT 1");
    await expect(checkMigrationReadiness(
      migrationHarness([], { schemaReady: false }).pool, [current],
    )).resolves.toEqual({ ready: false, reason: "migrations_pending" });
    await expect(checkMigrationReadiness(
      migrationHarness([{ name: current.name, checksum: "wrong" }]).pool, [current],
    )).resolves.toEqual({ ready: false, reason: "migrations_pending" });
    await expect(checkMigrationReadiness(
      migrationHarness([{ name: current.name, checksum: current.checksum }],
        { schemaReady: true }).pool, [current],
    )).resolves.toEqual({ ready: true });
    await expect(checkMigrationReadiness(migrationHarness([
      { name: current.name, checksum: current.checksum },
      { name: "0001_retired.sql", checksum: "retired" },
    ]).pool, [current])).resolves.toEqual({ ready: false, reason: "migrations_pending" });
  });
});
