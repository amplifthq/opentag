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
      `WITH expected_columns(name, type_name) AS (VALUES
        ('organization_id','text'),('candidate_id','text'),('run_id','text'),
        ('attempt_id','text'),('attempt_number','integer'),('project_target_id','text'),
        ('frozen_base_revision','text'),('workspace_tree_digest','text'),
        ('patch_digest','text'),('changed_files','text[]'),
        ('verification_evidence_ids','text[]'),('publication_policy_digest','text'),
        ('candidate','jsonb'),('completion_assessment','jsonb'),
        ('created_at','timestamp with time zone')
      ), expected_checks(name, definition) AS (VALUES
        ('cp_publication_candidate_changed_files_check',
          'CHECK((cardinality(changed_files)>0))'),
        ('cp_publication_candidate_verification_check',
          'CHECK((cardinality(verification_evidence_ids)>0))'),
        ('cp_publication_candidate_base_revision_check',
          'CHECK((frozen_base_revision~''^[a-f0-9]{40,64}$''::text))'),
        ('cp_publication_candidate_tree_digest_check',
          'CHECK((workspace_tree_digest~''^[a-f0-9]{40,64}$''::text))'),
        ('cp_publication_candidate_patch_digest_check',
          'CHECK((patch_digest~''^sha256:[a-f0-9]{64}$''::text))'),
        ('cp_publication_candidate_policy_digest_check',
          'CHECK((publication_policy_digest~''^sha256:[a-f0-9]{64}$''::text))'),
        ('cp_publication_candidate_content_free_check',
          'CHECK(((jsonb_typeof(candidate)=''object''::text)AND(NOT(candidate?|ARRAY[''baseToFinalBinaryDiff''::text,''limitations''::text,''workspacePath''::text,''logs''::text,''output''::text,''secret''::text]))))')
      ) SELECT (
        to_regclass('cp_publication_candidate') IS NOT NULL
        AND (SELECT count(*) = 15 FROM pg_attribute
          WHERE attrelid = 'cp_publication_candidate'::regclass
            AND attnum > 0 AND NOT attisdropped)
        AND NOT EXISTS (SELECT 1 FROM expected_columns expected
          LEFT JOIN pg_attribute attribute
            ON attribute.attrelid = 'cp_publication_candidate'::regclass
           AND attribute.attname = expected.name AND attribute.attnum > 0
           AND NOT attribute.attisdropped
          LEFT JOIN pg_attrdef default_value
            ON default_value.adrelid = attribute.attrelid
           AND default_value.adnum = attribute.attnum
          WHERE attribute.attname IS NULL OR NOT attribute.attnotnull
            OR format_type(attribute.atttypid, attribute.atttypmod) <> expected.type_name
            OR default_value.oid IS NOT NULL)
        AND EXISTS (SELECT 1 FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid = 'cp_publication_candidate'::regclass
            AND constraint_row.conname = 'cp_publication_candidate_pkey'
            AND constraint_row.contype = 'p'
            AND ARRAY(SELECT attribute.attname::text FROM unnest(constraint_row.conkey)
              WITH ORDINALITY key(attnum, ordinal)
              JOIN pg_attribute attribute ON attribute.attrelid = constraint_row.conrelid
                AND attribute.attnum = key.attnum ORDER BY key.ordinal)
              = ARRAY['organization_id','candidate_id'])
        AND EXISTS (SELECT 1 FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid = 'cp_publication_candidate'::regclass
            AND constraint_row.conname = 'cp_publication_candidate_organization_run_attempt_key'
            AND constraint_row.contype = 'u'
            AND ARRAY(SELECT attribute.attname::text FROM unnest(constraint_row.conkey)
              WITH ORDINALITY key(attnum, ordinal)
              JOIN pg_attribute attribute ON attribute.attrelid = constraint_row.conrelid
                AND attribute.attnum = key.attnum ORDER BY key.ordinal)
              = ARRAY['organization_id','run_id','attempt_id'])
        AND EXISTS (SELECT 1 FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid = 'cp_hosted_attempt'::regclass
            AND constraint_row.conname = 'cp_hosted_attempt_exact_identity_key'
            AND constraint_row.contype = 'u'
            AND ARRAY(SELECT attribute.attname::text FROM unnest(constraint_row.conkey)
              WITH ORDINALITY key(attnum, ordinal)
              JOIN pg_attribute attribute ON attribute.attrelid = constraint_row.conrelid
                AND attribute.attnum = key.attnum ORDER BY key.ordinal)
              = ARRAY['organization_id','run_id','attempt_number','attempt_id'])
        AND EXISTS (SELECT 1 FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid = 'cp_publication_candidate'::regclass
            AND constraint_row.conname = 'cp_publication_candidate_attempt_fk'
            AND constraint_row.contype = 'f'
            AND constraint_row.convalidated
            AND NOT constraint_row.condeferrable AND NOT constraint_row.condeferred
            AND constraint_row.confmatchtype = 's'
            AND constraint_row.confupdtype = 'a' AND constraint_row.confdeltype = 'a'
            AND constraint_row.confrelid = 'cp_hosted_attempt'::regclass
            AND ARRAY(SELECT attribute.attname::text FROM unnest(constraint_row.conkey)
              WITH ORDINALITY key(attnum, ordinal)
              JOIN pg_attribute attribute ON attribute.attrelid = constraint_row.conrelid
                AND attribute.attnum = key.attnum ORDER BY key.ordinal)
              = ARRAY['organization_id','run_id','attempt_number','attempt_id']
            AND ARRAY(SELECT attribute.attname::text FROM unnest(constraint_row.confkey)
              WITH ORDINALITY key(attnum, ordinal)
              JOIN pg_attribute attribute ON attribute.attrelid = constraint_row.confrelid
                AND attribute.attnum = key.attnum ORDER BY key.ordinal)
              = ARRAY['organization_id','run_id','attempt_number','attempt_id'])
        AND EXISTS (SELECT 1 FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid = 'cp_publication_candidate'::regclass
            AND constraint_row.contype = 'f'
            AND constraint_row.convalidated
            AND NOT constraint_row.condeferrable AND NOT constraint_row.condeferred
            AND constraint_row.confmatchtype = 's'
            AND constraint_row.confupdtype = 'a' AND constraint_row.confdeltype = 'a'
            AND constraint_row.confrelid = 'cp_organization'::regclass
            AND ARRAY(SELECT attribute.attname::text FROM unnest(constraint_row.conkey)
              WITH ORDINALITY key(attnum, ordinal)
              JOIN pg_attribute attribute ON attribute.attrelid = constraint_row.conrelid
                AND attribute.attnum = key.attnum ORDER BY key.ordinal)
              = ARRAY['organization_id']
            AND ARRAY(SELECT attribute.attname::text FROM unnest(constraint_row.confkey)
              WITH ORDINALITY key(attnum, ordinal)
              JOIN pg_attribute attribute ON attribute.attrelid = constraint_row.confrelid
                AND attribute.attnum = key.attnum ORDER BY key.ordinal)
              = ARRAY['organization_id'])
        AND NOT EXISTS (SELECT 1 FROM expected_checks expected
          LEFT JOIN pg_constraint constraint_row
            ON constraint_row.conrelid = 'cp_publication_candidate'::regclass
           AND constraint_row.conname = expected.name
          WHERE constraint_row.oid IS NULL OR constraint_row.contype <> 'c'
            OR NOT constraint_row.convalidated OR constraint_row.connoinherit
            OR regexp_replace(pg_get_constraintdef(constraint_row.oid),
              '[[:space:]]+', '', 'g') <> expected.definition)
        AND EXISTS (SELECT 1 FROM pg_index index_row
          JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
          WHERE index_row.indrelid = 'cp_publication_candidate'::regclass
            AND index_class.relname = 'cp_publication_candidate_run_idx'
            AND index_row.indisvalid AND index_row.indisready
            AND NOT index_row.indisunique AND index_row.indpred IS NULL
            AND ARRAY(SELECT attribute.attname::text FROM unnest(index_row.indkey::smallint[])
              WITH ORDINALITY key(attnum, ordinal)
              JOIN pg_attribute attribute ON attribute.attrelid = index_row.indrelid
                AND attribute.attnum = key.attnum ORDER BY key.ordinal)
              = ARRAY['organization_id','run_id'])
        AND EXISTS (SELECT 1 FROM pg_proc
          WHERE proname = 'cp_reject_publication_candidate_mutation'
            AND pronamespace = current_schema()::regnamespace
            AND prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
            AND prorettype = 'trigger'::regtype AND pronargs = 0
            AND NOT prosecdef AND NOT proleakproof AND provolatile = 'v'
            AND regexp_replace(prosrc, '[[:space:]]+', '', 'g')
              = 'BEGINRAISEEXCEPTION''publication_candidate_immutable'';END')
        AND EXISTS (SELECT 1 FROM pg_trigger trigger_row
          JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
          WHERE tgrelid = 'cp_publication_candidate'::regclass
            AND tgname = 'cp_publication_candidate_immutable'
            AND tgenabled = 'O' AND NOT tgisinternal AND tgtype = 27
            AND tgqual IS NULL AND tgnargs = 0
            AND function_row.proname = 'cp_reject_publication_candidate_mutation'
            AND function_row.pronamespace = current_schema()::regnamespace
            AND regexp_replace(pg_get_triggerdef(trigger_row.oid),
              '[[:space:]]+', ' ', 'g') NOT LIKE '% WHEN %'
            AND regexp_replace(pg_get_triggerdef(trigger_row.oid),
              '[[:space:]]+', '', 'g') LIKE
              'CREATETRIGGERcp_publication_candidate_immutableBEFOREDELETEORUPDATEON%FOREACHROWEXECUTEFUNCTION%cp_reject_publication_candidate_mutation()')
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
