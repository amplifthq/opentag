import { afterEach, describe, expect, it } from "vitest";
import {
  checkMigrationReadiness,
  checkProjectionSchemaReadiness,
  checkSlackIngressSchemaReadiness,
  checkSourceContentSchemaReadiness,
  checkSourceIngressSchemaReadiness,
} from "../src/database/migrations.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const FINAL_TABLES = [
  "control_plane_migrations",
  "cp_api_key",
  "cp_effect",
  "cp_effect_attempt",
  "cp_effect_evidence",
  "cp_hosted_attempt",
  "cp_hosted_audit_event",
  "cp_hosted_lifecycle_receipt",
  "cp_hosted_run",
  "cp_ingress_reservation",
  "cp_job",
  "cp_login_throttle",
  "cp_management_audit_event",
  "cp_material_action_begin_intent",
  "cp_material_action_current",
  "cp_material_action_receipt",
  "cp_membership",
  "cp_operator",
  "cp_organization",
  "cp_permission_operation",
  "cp_permission_request",
  "cp_project_target",
  "cp_projection_deferred_revision",
  "cp_projection_delivery_watermark",
  "cp_projection_event_cursor",
  "cp_provider_delivery_intent",
  "cp_provider_delivery_truth_lock",
  "cp_publication_candidate",
  "cp_runner",
  "cp_runner_credential",
  "cp_runner_operation",
  "cp_runner_readiness",
  "cp_session",
  "cp_slack_action_authority",
  "cp_slack_binding",
  "cp_source_content",
  "cp_source_content_invalidation_receipt",
  "cp_source_content_read_grant",
  "cp_source_replay_tombstone",
] as const;

describe.skipIf(!TEST_DATABASE_URL)("fresh PostgreSQL baseline", () => {
  const opened: Array<Awaited<ReturnType<typeof createIsolatedPostgres>>> = [];
  const fresh = async () => {
    const fixture = await createIsolatedPostgres();
    opened.push(fixture);
    return fixture;
  };
  afterEach(async () => {
    while (opened.length > 0) await opened.pop()!.close();
  });

  it("creates exactly the current 38-table schema and is idempotently ready", async () => {
    const fixture = await fresh();
    expect(fixture.migrations.map(({ name }) => name)).toEqual(["0000_control_plane.sql"]);
    await expect(fixture.migrate()).resolves.toBeUndefined();
    await expect(fixture.migrate()).resolves.toBeUndefined();
    await expect(checkMigrationReadiness(fixture.pool,fixture.migrations))
      .resolves.toEqual({ready:true});
    await expect(checkSourceContentSchemaReadiness(fixture.pool))
      .resolves.toEqual({ready:true});
    await expect(checkSourceIngressSchemaReadiness(fixture.pool))
      .resolves.toEqual({ready:true});
    await expect(checkSlackIngressSchemaReadiness(fixture.pool))
      .resolves.toEqual({ready:true});
    await expect(checkProjectionSchemaReadiness(fixture.pool))
      .resolves.toEqual({ready:true});

    const tables = await fixture.pool.query<{table_name:string}>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema=$1 ORDER BY table_name`,[fixture.schema]);
    expect(tables.rows.map(({table_name})=>table_name)).toEqual(FINAL_TABLES);
    expect((await fixture.pool.query(
      "SELECT to_regclass('cp_projection_job_v2_authority') AS relation",
    )).rows).toEqual([{relation:null}]);
    const providerColumns = await fixture.pool.query<{column_name:string}>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema=$1 AND table_name='cp_provider_delivery_intent' ORDER BY ordinal_position`,
      [fixture.schema]);
    expect(providerColumns.rows.map(({column_name})=>column_name)).not.toContain("payload_custody_ref");
    const truthLockColumns = await fixture.pool.query<{column_name:string}>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema=$1 AND table_name='cp_provider_delivery_truth_lock' ORDER BY ordinal_position`,
      [fixture.schema]);
    expect(truthLockColumns.rows.map(({column_name})=>column_name)).toEqual(["current_truth_key"]);
    const runnerColumns = await fixture.pool.query<{column_name:string}>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema=$1 AND table_name='cp_runner' ORDER BY ordinal_position`,
      [fixture.schema]);
    expect(runnerColumns.rows.map(({column_name})=>column_name)).not.toContain("display_name");
  });

  it("rejects an existing database carrying a retired applied migration name", async () => {
    const fixture = await fresh();
    await fixture.pool.query(`CREATE TABLE control_plane_migrations(
      name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL)`);
    await fixture.pool.query(
      "INSERT INTO control_plane_migrations VALUES('0025_runner_identity.sql','retired',clock_timestamp())",
    );
    await expect(fixture.migrate()).rejects.toThrow("migration_unknown_applied");
    expect((await fixture.pool.query<{count:number}>(
      `SELECT count(*)::int AS count FROM information_schema.tables
       WHERE table_schema=$1 AND table_name LIKE 'cp_%'`,[fixture.schema])).rows[0])
      .toEqual({count:0});
  });

  it("rejects an edited checksum for the applied baseline", async () => {
    const fixture = await fresh();
    await fixture.migrate();
    await fixture.pool.query(
      "UPDATE control_plane_migrations SET checksum='edited' WHERE name='0000_control_plane.sql'",
    );
    await expect(fixture.migrate()).rejects.toThrow("migration_checksum_mismatch");
  });

  it("fails migration readiness when a required baseline table is missing", async () => {
    const fixture = await fresh(); await fixture.migrate();
    await fixture.pool.query("DROP TABLE cp_login_throttle");
    await expect(checkMigrationReadiness(fixture.pool,fixture.migrations))
      .resolves.toEqual({ready:false,reason:"migrations_pending"});
  });

  it("fails migration readiness when the migration ledger primary key is removed", async () => {
    const fixture = await fresh(); await fixture.migrate();
    await fixture.pool.query(
      "ALTER TABLE control_plane_migrations DROP CONSTRAINT control_plane_migrations_pkey",
    );
    await expect(checkMigrationReadiness(fixture.pool,fixture.migrations))
      .resolves.toEqual({ready:false,reason:"migrations_pending"});
  });

  it("fails migration readiness when immutable Candidate authority is weakened", async () => {
    const fixture = await fresh(); await fixture.migrate();
    await fixture.pool.query("DROP TRIGGER cp_publication_candidate_immutable ON cp_publication_candidate");
    await expect(checkMigrationReadiness(fixture.pool,fixture.migrations))
      .resolves.toEqual({ready:false,reason:"migrations_pending"});
  });

  it("fails migration readiness for a same-name weakened Effect constraint", async () => {
    const fixture = await fresh(); await fixture.migrate();
    await fixture.pool.query(`ALTER TABLE cp_effect DROP CONSTRAINT cp_effect_projection_shape_check;
      ALTER TABLE cp_effect ADD CONSTRAINT cp_effect_projection_shape_check CHECK(true)`);
    await expect(checkMigrationReadiness(fixture.pool,fixture.migrations))
      .resolves.toEqual({ready:false,reason:"migrations_pending"});
  });

  it("fails Slack readiness for same-name weakened binding roles", async () => {
    const fixture = await fresh(); await fixture.migrate();
    await fixture.pool.query(`ALTER TABLE cp_slack_binding DROP CONSTRAINT cp_slack_binding_roles_check;
      ALTER TABLE cp_slack_binding ADD CONSTRAINT cp_slack_binding_roles_check CHECK(true)`);
    await expect(checkSlackIngressSchemaReadiness(fixture.pool))
      .resolves.toEqual({ready:false,reason:"migrations_pending"});
  });

  it("fails Slack readiness when the action FK loses cascade semantics", async () => {
    const fixture = await fresh(); await fixture.migrate();
    await fixture.pool.query(`ALTER TABLE cp_slack_action_authority
      DROP CONSTRAINT cp_slack_action_authority_slack_binding_fkey;
      ALTER TABLE cp_slack_action_authority ADD CONSTRAINT cp_slack_action_authority_slack_binding_fkey
      FOREIGN KEY(organization_id,binding_id,installation_id)
      REFERENCES cp_slack_binding(organization_id,binding_id,installation_id)`);
    await expect(checkSlackIngressSchemaReadiness(fixture.pool))
      .resolves.toEqual({ready:false,reason:"migrations_pending"});
  });

  it("fails projection readiness when the Effect projection source is removed", async () => {
    const fixture = await fresh(); await fixture.migrate();
    await fixture.pool.query("DROP TRIGGER cp_effect_projection ON cp_effect");
    await expect(checkProjectionSchemaReadiness(fixture.pool))
      .resolves.toEqual({ready:false,reason:"migrations_pending"});
  });
});
