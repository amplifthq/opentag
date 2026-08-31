import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReadinessResult } from "../application.js";

const MIGRATION_LOCK_KEY = 7_118_403_982;
const MIGRATION_NAME = /^[0-9]{4}_[a-z0-9_]+\.sql$/u;

export type SqlMigration = {
  name: string;
  checksum: string;
  sql: string;
};

type QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[];
  rowCount?: number | null;
};

type MigrationClient = {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  release(): void;
};

type MigrationPool = {
  connect(): Promise<MigrationClient>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
};

const migrationTableSql = `
  CREATE TABLE IF NOT EXISTS control_plane_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )
`;

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export async function loadSqlMigrations(directory: string): Promise<SqlMigration[]> {
  const names = (await readdir(directory))
    .filter((name) => MIGRATION_NAME.test(name))
    .sort();
  const migrations = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(directory, name), "utf8");
      return { name, sql, checksum: checksum(sql) };
    }),
  );
  return migrations;
}

async function readAppliedMigrations(client: Pick<MigrationClient, "query">) {
  const result = await client.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM control_plane_migrations ORDER BY name",
  );
  return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

export async function runMigrations(
  pool: Pick<MigrationPool, "connect">,
  migrations: readonly SqlMigration[],
): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    locked = true;
    await client.query(migrationTableSql);
    const applied = await readAppliedMigrations(client);
    const expectedNames = new Set(migrations.map(({ name }) => name));
    if ([...applied.keys()].some((name) => !expectedNames.has(name))) {
      throw new Error("migration_unknown_applied");
    }

    for (const migration of migrations) {
      const existingChecksum = applied.get(migration.name);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== migration.checksum) {
          throw new Error("migration_checksum_mismatch");
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO control_plane_migrations(name, checksum) VALUES($1, $2)",
          [migration.name, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }
}

export async function checkMigrationReadiness(
  pool: Pick<MigrationPool, "query">,
  migrations: readonly SqlMigration[],
): Promise<ReadinessResult> {
  try {
    const result = await pool.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM control_plane_migrations ORDER BY name",
    );
    const applied = new Map(result.rows.map((row) => [row.name, row.checksum]));
    const schema = await pool.query<{ schema_ready: boolean }>(
      `SELECT (
        to_regclass('cp_publication_candidate') IS NOT NULL
        AND (SELECT count(*) = 15 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'cp_publication_candidate'
          AND column_name = ANY(ARRAY['organization_id','candidate_id','run_id','attempt_id',
            'attempt_number','project_target_id','frozen_base_revision','workspace_tree_digest',
            'patch_digest','changed_files','verification_evidence_ids',
            'publication_policy_digest','candidate','completion_assessment','created_at']))
        AND (SELECT count(*) = 10 FROM pg_constraint
          WHERE conrelid = 'cp_publication_candidate'::regclass
          AND conname = ANY(ARRAY['cp_publication_candidate_pkey',
            'cp_publication_candidate_organization_run_attempt_key',
            'cp_publication_candidate_attempt_fk','cp_publication_candidate_changed_files_check',
            'cp_publication_candidate_verification_check',
            'cp_publication_candidate_base_revision_check','cp_publication_candidate_tree_digest_check',
            'cp_publication_candidate_patch_digest_check','cp_publication_candidate_policy_digest_check',
            'cp_publication_candidate_content_free_check']))
        AND to_regclass('cp_publication_candidate_run_idx') IS NOT NULL
        AND EXISTS (SELECT 1 FROM pg_proc
          WHERE proname = 'cp_reject_publication_candidate_mutation'
            AND pronamespace = current_schema()::regnamespace
            AND prosrc LIKE '%publication_candidate_immutable%')
        AND EXISTS (SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'cp_publication_candidate'::regclass
            AND tgname = 'cp_publication_candidate_immutable'
            AND tgenabled = 'O' AND NOT tgisinternal)
      ) AS schema_ready`,
    );
    const current = schema.rows[0]?.schema_ready === true
      && applied.size === migrations.length
      && migrations.every(
        (migration) => applied.get(migration.name) === migration.checksum,
      );
    return current
      ? { ready: true }
      : { ready: false, reason: "migrations_pending" };
  } catch {
    return { ready: false, reason: "migrations_pending" };
  }
}

export async function checkSourceContentSchemaReadiness(
  pool: Pick<MigrationPool, "query">,
): Promise<ReadinessResult> {
  try {
    const result = await pool.query<{ present: boolean }>(
      `SELECT bool_and(to_regclass(name) IS NOT NULL) AS present
       FROM unnest($1::text[]) AS required(name)`,
      [["cp_source_content", "cp_source_content_dependency",
        "cp_source_content_read_grant", "cp_source_replay_tombstone"]],
    );
    return result.rows[0]?.present
      ? { ready: true }
      : { ready: false, reason: "migrations_pending" };
  } catch {
    return { ready: false, reason: "migrations_pending" };
  }
}

export async function checkSourceIngressSchemaReadiness(
  pool: Pick<MigrationPool, "query">,
): Promise<ReadinessResult> {
  try {
    const result = await pool.query<{ present: boolean }>(
      `SELECT bool_and(to_regclass(name) IS NOT NULL) AS present
       FROM unnest($1::text[]) AS required(name)`,
      [["cp_source_app_installation", "cp_source_binding",
        "cp_ingress_reservation", "cp_source_resolution"]],
    );
    return result.rows[0]?.present
      ? { ready: true }
      : { ready: false, reason: "migrations_pending" };
  } catch {
    return { ready: false, reason: "migrations_pending" };
  }
}

export async function checkSlackIngressSchemaReadiness(
  pool: Pick<MigrationPool, "query">,
): Promise<ReadinessResult> {
  try {
    const result = await pool.query<{ present: boolean }>(
      `SELECT bool_and(to_regclass(name) IS NOT NULL) AS present
       FROM unnest($1::text[]) AS required(name)`,
      [["cp_slack_installation", "cp_slack_action_authority"]],
    );
    return result.rows[0]?.present
      ? { ready: true }
      : { ready: false, reason: "migrations_pending" };
  } catch { return { ready: false, reason: "migrations_pending" }; }
}
