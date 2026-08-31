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
            AND constraint_row.conname = 'cp_publication_candidate_organization_id_fkey'
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
        AND (SELECT count(*) FROM pg_class table_row
          WHERE table_row.relnamespace = current_schema()::regnamespace
            AND table_row.relkind = 'r'
            AND table_row.relname = ANY(ARRAY[
              'cp_publication_intent', 'cp_publication_branch_ownership',
              'cp_publication_capability', 'cp_publication_begin',
              'cp_publication_receipt', 'cp_publication_reconciliation',
              'cp_publication_completion'
            ])) = 7
        AND (SELECT array_agg(column_name::text ORDER BY ordinal_position)
             FROM information_schema.columns
             WHERE table_schema=current_schema() AND table_name='cp_publication_branch_ownership')
          = ARRAY['organization_id','ownership_id','run_id','attempt_id','attempt_number',
            'fencing_token_digest','runner_id','runner_generation','candidate_id','candidate_digest',
            'project_target_id','target_binding_digest','provider','owner','repo','remote','base_branch',
            'frozen_base_revision','workspace_tree_digest','branch','expected_head_sha',
            'attestation_digest','attested_at','created_at']
        AND (SELECT array_agg(column_name::text ORDER BY ordinal_position)
             FROM information_schema.columns
             WHERE table_schema=current_schema() AND table_name='cp_publication_capability')
          = ARRAY['organization_id','capability_id','intent_id','operation_id','idempotency_key',
            'step','attempt_number','capability_digest','capability','issued_at','expires_at']
        AND (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
             WHERE table_schema=current_schema() AND table_name='cp_publication_intent')
          = ARRAY['organization_id','intent_id','run_id','attempt_id','attempt_number','candidate_id','candidate_digest','ownership_id','ownership_digest','approval_id','approver_id','approval_digest','repository','branch','expected_head_sha','runner_id','runner_generation','approved_at','expires_at','created_at']
        AND (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
             WHERE table_schema=current_schema() AND table_name='cp_publication_begin')
          = ARRAY['organization_id','capability_id','operation_id','begun_at']
        AND (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
             WHERE table_schema=current_schema() AND table_name='cp_publication_receipt')
          = ARRAY['organization_id','receipt_id','capability_id','operation_id','outcome','receipt_digest','receipt','observed_at']
        AND (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
             WHERE table_schema=current_schema() AND table_name='cp_publication_reconciliation')
          = ARRAY['organization_id','reconciliation_id','capability_id','operation_id','observation','observed_at']
        AND (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
             WHERE table_schema=current_schema() AND table_name='cp_publication_completion')
          = ARRAY['organization_id','completion_id','run_id','attempt_id','attempt_number','fencing_token_digest','candidate_id','candidate_digest','intent_id','ownership_id','push_operation_id','push_receipt_digest','pull_request_operation_id','pull_request_receipt_digest','pull_request_external_id','pull_request_external_digest','repository','remote','base_branch','branch','expected_head_sha','observed_head_sha','required_check_names','evidence_digest','completion_decision','observation','created_at']
        AND EXISTS (SELECT 1 FROM pg_indexes
          WHERE schemaname=current_schema() AND tablename='cp_publication_branch_ownership'
            AND indexname='cp_publication_branch_owner_key'
            AND regexp_replace(indexdef, '[[:space:]\"]+', '', 'g')
              LIKE '%lower(provider),lower(owner),lower(repo),lower(branch)%')
        AND EXISTS (SELECT 1 FROM pg_trigger trigger_row
          JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
          WHERE trigger_row.tgrelid = 'cp_publication_completion'::regclass
            AND trigger_row.tgname = 'cp_publication_completion_immutable'
            AND trigger_row.tgenabled = 'O' AND NOT trigger_row.tgisinternal
            AND function_row.proname = 'cp_reject_publication_authority_mutation'
            AND function_row.pronamespace = current_schema()::regnamespace)
        AND NOT EXISTS (SELECT 1 FROM (VALUES
          ('cp_publication_intent','cp_publication_intent_immutable'),
          ('cp_publication_branch_ownership','cp_publication_branch_ownership_immutable'),
          ('cp_publication_capability','cp_publication_capability_immutable'),
          ('cp_publication_begin','cp_publication_begin_immutable'),
          ('cp_publication_receipt','cp_publication_receipt_immutable'),
          ('cp_publication_reconciliation','cp_publication_reconciliation_immutable'),
          ('cp_publication_completion','cp_publication_completion_immutable')
        ) expected(table_name, trigger_name)
        WHERE NOT EXISTS (SELECT 1 FROM pg_trigger trigger_row JOIN pg_proc function_row ON function_row.oid=trigger_row.tgfoid
          WHERE trigger_row.tgrelid=to_regclass(expected.table_name) AND trigger_row.tgname=expected.trigger_name
            AND trigger_row.tgenabled='O' AND NOT trigger_row.tgisinternal AND trigger_row.tgtype=27
            AND function_row.proname='cp_reject_publication_authority_mutation'
            AND function_row.pronamespace=current_schema()::regnamespace))
      ) AS schema_ready`,
    );
    // 0014 is durable authority, not a representative-table migration.  Keep
    // this catalog separate from the older 0013 check so every authority
    // family must remain immutable and structurally complete at startup.
    const publicationOperations = await pool.query<{ schema_ready: boolean }>(
      `WITH expected_spec(table_name, column_names, column_types) AS (VALUES
         ('cp_publication_branch_ownership', ARRAY['organization_id','ownership_id','run_id','attempt_id','attempt_number','fencing_token_digest','runner_id','runner_generation','candidate_id','candidate_digest','project_target_id','target_binding_digest','provider','owner','repo','remote','base_branch','frozen_base_revision','workspace_tree_digest','branch','expected_head_sha','attestation_digest','attested_at','created_at'], ARRAY['text','text','text','text','integer','text','text','integer','text','text','text','text','text','text','text','text','text','text','text','text','text','text','timestamp with time zone','timestamp with time zone']),
         ('cp_publication_intent', ARRAY['organization_id','intent_id','run_id','attempt_id','attempt_number','candidate_id','candidate_digest','ownership_id','ownership_digest','approval_id','approver_id','approval_digest','repository','branch','expected_head_sha','runner_id','runner_generation','approved_at','expires_at','created_at'], ARRAY['text','text','text','text','integer','text','text','text','text','text','text','text','jsonb','text','text','text','integer','timestamp with time zone','timestamp with time zone','timestamp with time zone']),
         ('cp_publication_capability', ARRAY['organization_id','capability_id','intent_id','operation_id','idempotency_key','step','attempt_number','capability_digest','capability','issued_at','expires_at'], ARRAY['text','text','text','text','text','text','integer','text','jsonb','timestamp with time zone','timestamp with time zone']),
         ('cp_publication_begin', ARRAY['organization_id','capability_id','operation_id','begun_at'], ARRAY['text','text','text','timestamp with time zone']),
         ('cp_publication_receipt', ARRAY['organization_id','receipt_id','capability_id','operation_id','outcome','receipt_digest','receipt','observed_at'], ARRAY['text','text','text','text','text','text','jsonb','timestamp with time zone']),
         ('cp_publication_reconciliation', ARRAY['organization_id','reconciliation_id','capability_id','operation_id','observation','observed_at'], ARRAY['text','text','text','text','jsonb','timestamp with time zone']),
         ('cp_publication_completion', ARRAY['organization_id','completion_id','run_id','attempt_id','attempt_number','fencing_token_digest','candidate_id','candidate_digest','intent_id','ownership_id','push_operation_id','push_receipt_digest','pull_request_operation_id','pull_request_receipt_digest','pull_request_external_id','pull_request_external_digest','repository','remote','base_branch','branch','expected_head_sha','observed_head_sha','required_check_names','evidence_digest','completion_decision','observation','created_at'], ARRAY['text','text','text','text','integer','text','text','text','text','text','text','text','text','text','text','text','jsonb','text','text','text','text','text','text[]','text','jsonb','jsonb','timestamp with time zone'])
       ), expected AS (
         SELECT spec.table_name,column_name,ordinal::integer AS ordinal,column_type
         FROM expected_spec spec CROSS JOIN LATERAL unnest(spec.column_names,spec.column_types)
           WITH ORDINALITY AS column_spec(column_name,column_type,ordinal)
       ), expected_constraint(constraint_name,constraint_type,source_table,target_table,
            source_columns,target_columns,validated,match_type,update_action,delete_action,
            is_deferrable,is_deferred,noinherit,check_definition) AS (VALUES
         ('cp_publication_branch_ownership_attestation_digest_check','c','cp_publication_branch_ownership',NULL,ARRAY['attestation_digest'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (attestation_digest ~ ''^sha256:[a-f0-9]{64}$''::text)'),
         ('cp_publication_branch_ownership_candidate_digest_check','c','cp_publication_branch_ownership',NULL,ARRAY['candidate_digest'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (candidate_digest ~ ''^sha256:[a-f0-9]{64}$''::text)'),
         ('cp_publication_branch_ownership_check','c','cp_publication_branch_ownership',NULL,ARRAY['provider','owner','repo'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (provider = lower(provider) AND owner = lower(owner) AND repo = lower(repo))'),
         ('cp_publication_branch_ownership_expected_head_sha_check','c','cp_publication_branch_ownership',NULL,ARRAY['expected_head_sha'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (expected_head_sha ~ ''^[a-f0-9]{40,64}$''::text)'),
         ('cp_publication_branch_ownership_fencing_token_digest_check','c','cp_publication_branch_ownership',NULL,ARRAY['fencing_token_digest'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (fencing_token_digest ~ ''^sha256:[a-f0-9]{64}$''::text)'),
         ('cp_publication_branch_ownership_frozen_base_revision_check','c','cp_publication_branch_ownership',NULL,ARRAY['frozen_base_revision'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (frozen_base_revision ~ ''^[a-f0-9]{40,64}$''::text)'),
         ('cp_publication_branch_ownership_runner_generation_check','c','cp_publication_branch_ownership',NULL,ARRAY['runner_generation'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (runner_generation > 0)'),
         ('cp_publication_branch_ownership_target_binding_digest_check','c','cp_publication_branch_ownership',NULL,ARRAY['target_binding_digest'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (target_binding_digest ~ ''^sha256:[a-f0-9]{64}$''::text)'),
         ('cp_publication_branch_ownership_workspace_tree_digest_check','c','cp_publication_branch_ownership',NULL,ARRAY['workspace_tree_digest'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (workspace_tree_digest ~ ''^[a-f0-9]{40,64}$''::text)'),
         ('cp_publication_branch_ownersh_organization_id_run_id_attem_fkey','f','cp_publication_branch_ownership','cp_hosted_attempt',ARRAY['organization_id','run_id','attempt_number','attempt_id'],ARRAY['organization_id','run_id','attempt_number','attempt_id'],true,'s','a','a',false,false,true,NULL),
         ('cp_publication_branch_ownership_pkey','p','cp_publication_branch_ownership',NULL,ARRAY['organization_id','ownership_id'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL),
         ('cp_publication_branch_ownershi_organization_id_candidate_id_key','u','cp_publication_branch_ownership',NULL,ARRAY['organization_id','candidate_id'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL),
         ('cp_publication_intent_approval_digest_check','c','cp_publication_intent',NULL,ARRAY['approval_digest'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (approval_digest ~ ''^sha256:[a-f0-9]{64}$''::text)'),
         ('cp_publication_intent_candidate_digest_check','c','cp_publication_intent',NULL,ARRAY['candidate_digest'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (candidate_digest ~ ''^sha256:[a-f0-9]{64}$''::text)'),
         ('cp_publication_intent_check','c','cp_publication_intent',NULL,ARRAY['expires_at','approved_at'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (expires_at > approved_at)'),
         ('cp_publication_intent_expected_head_sha_check','c','cp_publication_intent',NULL,ARRAY['expected_head_sha'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (expected_head_sha ~ ''^[a-f0-9]{40,64}$''::text)'),
         ('cp_publication_intent_ownership_digest_check','c','cp_publication_intent',NULL,ARRAY['ownership_digest'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (ownership_digest ~ ''^sha256:[a-f0-9]{64}$''::text)'),
         ('cp_publication_intent_runner_generation_check','c','cp_publication_intent',NULL,ARRAY['runner_generation'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (runner_generation > 0)'),
         ('cp_publication_intent_organization_id_fkey','f','cp_publication_intent','cp_organization',ARRAY['organization_id'],ARRAY['organization_id'],true,'s','a','a',false,false,true,NULL),
         ('cp_publication_intent_organization_id_ownership_id_fkey','f','cp_publication_intent','cp_publication_branch_ownership',ARRAY['organization_id','ownership_id'],ARRAY['organization_id','ownership_id'],true,'s','a','a',false,false,true,NULL),
         ('cp_publication_intent_organization_id_run_id_attempt_numbe_fkey','f','cp_publication_intent','cp_hosted_attempt',ARRAY['organization_id','run_id','attempt_number','attempt_id'],ARRAY['organization_id','run_id','attempt_number','attempt_id'],true,'s','a','a',false,false,true,NULL),
         ('cp_publication_intent_pkey','p','cp_publication_intent',NULL,ARRAY['organization_id','intent_id'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL),
         ('cp_publication_intent_organization_id_approval_id_key','u','cp_publication_intent',NULL,ARRAY['organization_id','approval_id'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL),
         ('cp_publication_intent_organization_id_candidate_id_key','u','cp_publication_intent',NULL,ARRAY['organization_id','candidate_id'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL),
         ('cp_publication_capability_attempt_number_check','c','cp_publication_capability',NULL,ARRAY['attempt_number'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (attempt_number > 0)'),
         ('cp_publication_capability_check','c','cp_publication_capability',NULL,ARRAY['expires_at','issued_at'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (expires_at > issued_at AND expires_at <= (issued_at + ''00:05:00''::interval))'),
         ('cp_publication_capability_step_check','c','cp_publication_capability',NULL,ARRAY['step'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (step = ANY (ARRAY[''push_owned_branch''::text, ''create_draft_pull_request''::text]))'),
         ('cp_publication_capability_organization_id_intent_id_fkey','f','cp_publication_capability','cp_publication_intent',ARRAY['organization_id','intent_id'],ARRAY['organization_id','intent_id'],true,'s','a','a',false,false,true,NULL),
         ('cp_publication_capability_pkey','p','cp_publication_capability',NULL,ARRAY['organization_id','capability_id'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL),
         ('cp_publication_capability_organization_id_intent_id_step_at_key','u','cp_publication_capability',NULL,ARRAY['organization_id','intent_id','step','attempt_number'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL),
         ('cp_publication_begin_organization_id_capability_id_fkey','f','cp_publication_begin','cp_publication_capability',ARRAY['organization_id','capability_id'],ARRAY['organization_id','capability_id'],true,'s','a','a',false,false,true,NULL),
         ('cp_publication_begin_pkey','p','cp_publication_begin',NULL,ARRAY['organization_id','capability_id'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL),
         ('cp_publication_receipt_outcome_check','c','cp_publication_receipt',NULL,ARRAY['outcome'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (outcome = ANY (ARRAY[''succeeded''::text, ''failed''::text, ''outcome_unknown''::text]))'),
         ('cp_publication_receipt_organization_id_capability_id_fkey','f','cp_publication_receipt','cp_publication_capability',ARRAY['organization_id','capability_id'],ARRAY['organization_id','capability_id'],true,'s','a','a',false,false,true,NULL),
         ('cp_publication_receipt_pkey','p','cp_publication_receipt',NULL,ARRAY['organization_id','receipt_id'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL),
         ('cp_publication_receipt_organization_id_capability_id_key','u','cp_publication_receipt',NULL,ARRAY['organization_id','capability_id'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL),
         ('cp_publication_reconciliation_organization_id_capability_i_fkey','f','cp_publication_reconciliation','cp_publication_capability',ARRAY['organization_id','capability_id'],ARRAY['organization_id','capability_id'],true,'s','a','a',false,false,true,NULL),
         ('cp_publication_reconciliation_pkey','p','cp_publication_reconciliation',NULL,ARRAY['organization_id','reconciliation_id'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL),
         ('cp_publication_reconciliation_organization_id_capability_id_key','u','cp_publication_reconciliation',NULL,ARRAY['organization_id','capability_id'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL),
         ('cp_publication_completion_check','c','cp_publication_completion',NULL,ARRAY['candidate_digest','fencing_token_digest','push_receipt_digest','pull_request_receipt_digest','pull_request_external_digest','evidence_digest'],ARRAY[]::text[],true,' ',' ',' ',false,false,false,'CHECK (candidate_digest ~ ''^sha256:[a-f0-9]{64}$''::text AND fencing_token_digest ~ ''^sha256:[a-f0-9]{64}$''::text AND push_receipt_digest ~ ''^sha256:[a-f0-9]{64}$''::text AND pull_request_receipt_digest ~ ''^sha256:[a-f0-9]{64}$''::text AND pull_request_external_digest ~ ''^sha256:[a-f0-9]{64}$''::text AND evidence_digest ~ ''^sha256:[a-f0-9]{64}$''::text)'),
         ('cp_publication_completion_organization_id_intent_id_fkey','f','cp_publication_completion','cp_publication_intent',ARRAY['organization_id','intent_id'],ARRAY['organization_id','intent_id'],true,'s','a','a',false,false,true,NULL),
         ('cp_publication_completion_organization_id_ownership_id_fkey','f','cp_publication_completion','cp_publication_branch_ownership',ARRAY['organization_id','ownership_id'],ARRAY['organization_id','ownership_id'],true,'s','a','a',false,false,true,NULL),
         ('cp_publication_completion_pkey','p','cp_publication_completion',NULL,ARRAY['organization_id','completion_id'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL),
         ('cp_publication_completion_organization_id_run_id_key','u','cp_publication_completion',NULL,ARRAY['organization_id','run_id'],ARRAY[]::text[],true,' ',' ',' ',false,false,true,NULL)
       ), actual_constraint AS (
         SELECT constraint_row.conname::text AS constraint_name,
           constraint_row.contype::text AS constraint_type,
           constraint_row.conrelid::regclass::text AS source_table,
           CASE WHEN constraint_row.confrelid=0 THEN NULL ELSE constraint_row.confrelid::regclass::text END AS target_table,
           ARRAY(SELECT attribute.attname::text FROM unnest(constraint_row.conkey) WITH ORDINALITY key(attnum,ordinal)
             JOIN pg_attribute attribute ON attribute.attrelid=constraint_row.conrelid AND attribute.attnum=key.attnum ORDER BY ordinal) AS source_columns,
           ARRAY(SELECT attribute.attname::text FROM unnest(constraint_row.confkey) WITH ORDINALITY key(attnum,ordinal)
             JOIN pg_attribute attribute ON attribute.attrelid=constraint_row.confrelid AND attribute.attnum=key.attnum ORDER BY ordinal) AS target_columns,
           constraint_row.convalidated AS validated,constraint_row.confmatchtype::text AS match_type,
           constraint_row.confupdtype::text AS update_action,constraint_row.confdeltype::text AS delete_action,
           constraint_row.condeferrable AS is_deferrable,constraint_row.condeferred AS is_deferred,
           constraint_row.connoinherit AS noinherit,
           CASE WHEN constraint_row.contype='c' THEN regexp_replace(
             pg_get_constraintdef(constraint_row.oid,true),'\\s+',' ','g') ELSE NULL END AS check_definition
         FROM pg_constraint constraint_row
         WHERE constraint_row.conrelid IN (SELECT to_regclass(table_name) FROM expected_spec)
       ), expected_index(index_name,source_table,is_unique,is_valid,is_ready,key_count,
            expression_definition,column_definitions,predicate_definition) AS (VALUES
         ('cp_publication_branch_owner_key','cp_publication_branch_ownership',true,true,true,5,
           'lower(provider), lower(owner), lower(repo), lower(branch)',
           ARRAY['organization_id','lower(provider)','lower(owner)','lower(repo)','lower(branch)'],NULL)
       ), actual_index AS (
         SELECT index_relation.relname::text AS index_name,index_row.indrelid::regclass::text AS source_table,
           index_row.indisunique AS is_unique,index_row.indisvalid AS is_valid,
           index_row.indisready AS is_ready,index_row.indnkeyatts::integer AS key_count,
           regexp_replace(pg_get_expr(index_row.indexprs,index_row.indrelid,true),'\\s+',' ','g') AS expression_definition,
           ARRAY(SELECT COALESCE(attribute.attname::text,pg_get_indexdef(index_row.indexrelid,key.ordinal::integer,false))
             FROM unnest(index_row.indkey) WITH ORDINALITY key(attnum,ordinal)
             LEFT JOIN pg_attribute attribute ON attribute.attrelid=index_row.indrelid AND attribute.attnum=key.attnum
             ORDER BY key.ordinal) AS column_definitions,
           CASE WHEN index_row.indpred IS NULL THEN NULL ELSE regexp_replace(
             pg_get_expr(index_row.indpred,index_row.indrelid,true),'\\s+',' ','g') END AS predicate_definition
         FROM pg_index index_row JOIN pg_class index_relation ON index_relation.oid=index_row.indexrelid
         WHERE index_row.indrelid IN (SELECT to_regclass(table_name) FROM expected_spec)
           AND index_row.indexprs IS NOT NULL
       ), immutable(table_name, trigger_name) AS (VALUES
         ('cp_publication_branch_ownership','cp_publication_branch_ownership_immutable'),
         ('cp_publication_intent','cp_publication_intent_immutable'),
         ('cp_publication_capability','cp_publication_capability_immutable'),
         ('cp_publication_begin','cp_publication_begin_immutable'),
         ('cp_publication_receipt','cp_publication_receipt_immutable'),
         ('cp_publication_reconciliation','cp_publication_reconciliation_immutable'),
         ('cp_publication_completion','cp_publication_completion_immutable')
       ) SELECT (
         NOT EXISTS (SELECT 1 FROM expected WHERE to_regclass(table_name) IS NULL)
         AND NOT EXISTS (SELECT 1 FROM expected expected_column
           LEFT JOIN pg_attribute attribute ON attribute.attrelid=to_regclass(expected_column.table_name)
             AND attribute.attnum=expected_column.ordinal AND NOT attribute.attisdropped
           LEFT JOIN pg_attrdef default_value ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
           WHERE attribute.attname IS DISTINCT FROM expected_column.column_name
             OR format_type(attribute.atttypid,attribute.atttypmod) IS DISTINCT FROM expected_column.column_type
             OR NOT attribute.attnotnull OR default_value.oid IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM expected_spec expected_table
           JOIN LATERAL (SELECT count(*)::integer AS count FROM pg_attribute
             WHERE attrelid=to_regclass(expected_table.table_name) AND attnum>0 AND NOT attisdropped) actual ON true
           WHERE actual.count<>cardinality(expected_table.column_names))
         AND NOT EXISTS ((SELECT * FROM expected_constraint EXCEPT SELECT * FROM actual_constraint)
           UNION ALL (SELECT * FROM actual_constraint EXCEPT SELECT * FROM expected_constraint))
         AND NOT EXISTS ((SELECT * FROM expected_index EXCEPT SELECT * FROM actual_index)
           UNION ALL (SELECT * FROM actual_index EXCEPT SELECT * FROM expected_index))
         AND NOT EXISTS (SELECT 1 FROM immutable expected_trigger WHERE NOT EXISTS (
           SELECT 1 FROM pg_trigger trigger_row JOIN pg_proc function_row ON function_row.oid=trigger_row.tgfoid
           WHERE trigger_row.tgrelid=to_regclass(expected_trigger.table_name)
             AND trigger_row.tgname=expected_trigger.trigger_name AND trigger_row.tgenabled='O'
             AND NOT trigger_row.tgisinternal AND trigger_row.tgtype=27 AND trigger_row.tgqual IS NULL
             AND trigger_row.tgnargs=0 AND function_row.proname='cp_reject_publication_authority_mutation'
             AND function_row.pronamespace=current_schema()::regnamespace))
         AND EXISTS (SELECT 1 FROM pg_proc function_row JOIN pg_language language_row ON language_row.oid=function_row.prolang
           WHERE function_row.proname='cp_reject_publication_authority_mutation'
             AND function_row.pronamespace=current_schema()::regnamespace
             AND function_row.pronargs=0 AND function_row.prorettype='trigger'::regtype
             AND language_row.lanname='plpgsql' AND function_row.provolatile='v'
             AND NOT function_row.prosecdef AND NOT function_row.proisstrict AND NOT function_row.proleakproof
             AND regexp_replace(function_row.prosrc,'\\s+',' ','g') = ' BEGIN RAISE EXCEPTION ''publication_authority_immutable''; END ')
       ) AS schema_ready`,
    );
    const current = schema.rows[0]?.schema_ready === true
      && publicationOperations.rows[0]?.schema_ready === true
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
    const result = await pool.query<{ present: boolean }>(`SELECT
      to_regclass('cp_slack_installation') IS NOT NULL
      AND to_regclass('cp_slack_action_authority') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='cp_slack_action_authority'::regclass
        AND attname='projection_generation' AND attnotnull AND NOT attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='cp_slack_action_authority'::regclass
        AND attname='publication_approval' AND NOT attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='cp_slack_action_authority'::regclass
        AND attname='authority_family_id' AND attnotnull AND NOT attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='cp_slack_action_authority'::regclass
        AND attname='authority_epoch' AND attnotnull AND NOT attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='cp_slack_action_authority'::regclass
        AND attname='claim_state' AND attnotnull AND NOT attisdropped)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_projection_generation_check' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_publication_shape_check' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_claim_shape_check' AND convalidated)
      AS present`);
    return result.rows[0]?.present
      ? { ready: true }
      : { ready: false, reason: "migrations_pending" };
  } catch { return { ready: false, reason: "migrations_pending" }; }
}

export async function checkProjectionSchemaReadiness(
  pool: Pick<MigrationPool, "query">,
): Promise<ReadinessResult> {
  try {
    const result = await pool.query<{ ready: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='cp_hosted_run'::regclass
        AND attname='projection_revision' AND attnotnull AND NOT attisdropped)
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_hosted_run'::regclass
        AND conname='cp_hosted_run_projection_revision_check' AND convalidated)
      AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='cp_provider_delivery_intent'::regclass
        AND attname='projection_revision' AND attnotnull AND NOT attisdropped)
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_provider_delivery_intent'::regclass
        AND conname='cp_provider_delivery_projection_revision_check' AND convalidated)
      AND to_regclass('cp_projection_delivery_watermark') IS NOT NULL
      AND EXISTS(SELECT 1 FROM pg_proc WHERE proname='cp_enqueue_team_relay_projection' AND pronargs=3)
      AND EXISTS(SELECT 1 FROM pg_proc WHERE proname='cp_hosted_run_projection_before' AND pronargs=0)
      AND EXISTS(SELECT 1 FROM pg_proc WHERE proname='cp_hosted_run_projection_after' AND pronargs=0)
      AND EXISTS(SELECT 1 FROM pg_proc WHERE proname='cp_related_projection_after' AND pronargs=0)
      AND EXISTS(SELECT 1 FROM pg_proc WHERE proname='cp_delivery_projection_after' AND pronargs=0)
      AND (SELECT count(*)=6 FROM pg_trigger trigger_row
        JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
        JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname=current_schema() AND NOT trigger_row.tgisinternal AND trigger_row.tgname IN (
        'cp_hosted_run_projection_before_trigger','cp_hosted_run_projection_after_trigger',
        'cp_permission_projection_trigger','cp_candidate_projection_trigger',
        'cp_publication_intent_projection_trigger','cp_delivery_projection_trigger')) AS ready`);
    return result.rows[0]?.ready ? { ready: true }
      : { ready: false, reason: "migrations_pending" };
  } catch { return { ready: false, reason: "migrations_pending" }; }
}
