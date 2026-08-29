import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkMigrationReadiness, runMigrations } from "../src/database/migrations.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL migration corpus", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("migrates an empty schema and is idempotently ready", async () => {
    expect(fixture.migrations.map(({ name }) => name)).toEqual([
      "0000_control_plane.sql",
      "0001_permissions.sql",
      "0002_material_actions.sql",
      "0003_bind_session_tenant.sql",
      "0004_login_throttle.sql",
      "0005_source_content.sql",
      "0006_source_ingress.sql",
      "0007_hosted_run_offline_safe.sql",
    ]);

    await expect(fixture.migrate()).resolves.toBeUndefined();
    await expect(fixture.migrate()).resolves.toBeUndefined();
    await expect(
      checkMigrationReadiness(fixture.pool, fixture.migrations),
    ).resolves.toEqual({ ready: true });

    const result = await fixture.pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [fixture.schema],
    );
    expect(result.rows.map(({ table_name }) => table_name)).toEqual(
      expect.arrayContaining([
        "control_plane_migrations",
        "cp_runner",
        "cp_hosted_run",
        "cp_hosted_attempt",
        "cp_job",
        "cp_permission_request",
        "cp_permission_operation",
        "cp_material_action_receipt",
        "cp_material_action_current",
        "cp_management_audit_event",
        "cp_login_throttle",
        "cp_source_app_installation",
        "cp_source_binding",
        "cp_ingress_reservation",
        "cp_source_resolution",
        "cp_source_content_invalidation_receipt",
      ]),
    );

    const sessionTenantColumn = await fixture.pool.query<{
      is_nullable: string;
    }>(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'cp_session'
         AND column_name = 'organization_id'`,
      [fixture.schema],
    );
    expect(sessionTenantColumn.rows).toEqual([{ is_nullable: "NO" }]);

    const sessionTenantForeignKey = await fixture.pool.query<{
      constraint_name: string;
    }>(
      `SELECT constraint_name
       FROM information_schema.table_constraints
       WHERE table_schema = $1
         AND table_name = 'cp_session'
         AND constraint_type = 'FOREIGN KEY'
         AND constraint_name = 'cp_session_membership_fk'`,
      [fixture.schema],
    );
    expect(sessionTenantForeignKey.rows).toEqual([
      { constraint_name: "cp_session_membership_fk" },
    ]);
  });

  it("carries legacy hosted rows into the canonical immutable lifecycle", async () => {
    const legacy = await createIsolatedPostgres();
    try {
      await runMigrations(legacy.pool, legacy.migrations.slice(0, -1));
      const createdAt = "2026-08-28T00:00:00.000Z";
      await legacy.pool.query(
        "INSERT INTO cp_organization(organization_id, display_name, created_at) VALUES($1,$2,$3)",
        ["org_legacy", "Legacy", createdAt],
      );
      await legacy.pool.query(
        `INSERT INTO cp_runner(organization_id, runner_id, registration_generation,
           credential_generation, current_credential_id, capabilities, created_at, updated_at)
         VALUES($1,$2,1,1,$3,'[]'::jsonb,$4,$4)`,
        ["org_legacy", "runner_legacy", "credential_legacy", createdAt],
      );
      await legacy.pool.query(
        `INSERT INTO cp_hosted_run(organization_id, run_id, admission_id,
           admission_operation_id, admission_digest, source_identity_digest,
           runner_id, executor_id, state, hosted_admission,
           admission_policy_snapshot, created_at, updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending','{}'::jsonb,'{}'::jsonb,$9,$9)`,
        ["org_legacy", "run_legacy", "admission_legacy", "operation_legacy",
          `sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`,
          "runner_legacy", "executor_legacy", createdAt],
      );

      await runMigrations(legacy.pool, legacy.migrations);

      const row = await legacy.pool.query(
        `SELECT state, source_version_ref, source_content_ids, queue_claim_deadline,
           publication_mode, completion_mode FROM cp_hosted_run WHERE run_id = $1`,
        ["run_legacy"],
      );
      expect(row.rows[0]).toMatchObject({ state: "queued",
        source_version_ref: `legacy:sha256:${"2".repeat(64)}`,
        source_content_ids: ["legacy:run_legacy"], publication_mode: "proposal_only",
        completion_mode: "proposal_ready" });
      await expect(legacy.pool.query(
        "UPDATE cp_hosted_run SET queue_claim_deadline = queue_claim_deadline + interval '1 hour' WHERE run_id = $1",
        ["run_legacy"],
      )).rejects.toThrow("hosted_run_admission_frozen");
    } finally {
      await legacy.close();
    }
  });
});
