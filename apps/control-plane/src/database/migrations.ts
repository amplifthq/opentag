import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReadinessResult } from "../application.js";

const MIGRATION_LOCK_KEY = 7_118_403_982;
const MIGRATION_NAME = /^[0-9]{4}_[a-z0-9_]+\.sql$/u;
const CONTROL_PLANE_TABLES = [
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
        (SELECT array_agg(table_name::text ORDER BY table_name)
          FROM information_schema.tables
          WHERE table_schema=current_schema() AND table_type='BASE TABLE')=$1::text[]
        AND EXISTS (SELECT 1 FROM pg_class table_row
          WHERE table_row.relnamespace=current_schema()::regnamespace
            AND table_row.relname='control_plane_migrations'
            AND table_row.relkind='r' AND table_row.relpersistence='p'
            AND NOT table_row.relrowsecurity AND NOT table_row.relforcerowsecurity)
        AND (SELECT count(*)=3 FROM information_schema.columns
          WHERE table_schema=current_schema() AND table_name='control_plane_migrations'
            AND ((ordinal_position=1 AND column_name='name' AND data_type='text'
                AND is_nullable='NO' AND column_default IS NULL)
              OR (ordinal_position=2 AND column_name='checksum' AND data_type='text'
                AND is_nullable='NO' AND column_default IS NULL)
              OR (ordinal_position=3 AND column_name='applied_at'
                AND data_type='timestamp with time zone' AND is_nullable='NO'
                AND column_default='clock_timestamp()')))
        AND (SELECT count(*)=1 FROM pg_constraint
          WHERE conrelid='control_plane_migrations'::regclass)
        AND EXISTS (SELECT 1 FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid='control_plane_migrations'::regclass
            AND constraint_row.conname='control_plane_migrations_pkey'
            AND constraint_row.contype='p' AND constraint_row.convalidated
            AND NOT constraint_row.condeferrable AND NOT constraint_row.condeferred
            AND ARRAY(SELECT attribute.attname::text
              FROM unnest(constraint_row.conkey) WITH ORDINALITY key(attnum,ordinal)
              JOIN pg_attribute attribute ON attribute.attrelid=constraint_row.conrelid
                AND attribute.attnum=key.attnum ORDER BY key.ordinal)=ARRAY['name'])
        AND to_regclass('cp_publication_candidate') IS NOT NULL
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
      ) AS schema_ready`,
      [CONTROL_PLANE_TABLES],
    );
    // EffectAuthority replaces the seven-table publication operation ledger.
    // Startup checks both the positive shape and the absence of the superseded
    // authority so an old image cannot silently become a second writer.
    const effectAuthority = await pool.query<{ schema_ready: boolean }>(
      `WITH legacy_table(name) AS (VALUES
         ('cp_publication_branch_ownership'),('cp_publication_intent'),
         ('cp_publication_capability'),('cp_publication_begin'),
         ('cp_publication_receipt'),('cp_publication_reconciliation'),
         ('cp_publication_completion')
       ), expected_columns(table_name,column_names) AS (VALUES
         ('cp_effect',ARRAY['organization_id','effect_id','idempotency_key','effect_kind',
           'request_id','request_digest','runner_id','runner_generation','run_id',
           'run_attempt_id','run_attempt_number','fencing_token_digest','candidate_id',
           'candidate_digest','project_target_id','target_binding_digest',
           'target_binding_generation','target_digest','target','policy_snapshot_id',
           'policy_snapshot_digest','approval_request_id','approval_request_digest',
           'approval_expires_at','approval_id','approval_digest','approval','state',
           'current_attempt_number','current_evidence_digest','external_resource','reason_code',
           'requested_at','created_at','updated_at']),
         ('cp_effect_attempt',ARRAY['organization_id','permit_id','effect_id',
           'effect_attempt_number','permit_kind','original_execute_permit_id',
           'acquire_request_id','acquire_journal_digest','runner_id','runner_generation',
           'request_digest','target_digest','approval_digest','permit_digest','permit',
           'issued_at','expires_at','created_at']),
         ('cp_effect_evidence',ARRAY['organization_id','evidence_id','effect_id','permit_id',
           'effect_attempt_number','sequence','predecessor_evidence_digest','payload_digest',
           'evidence_digest','evidence','observed_at','created_at'])
       ), required_constraint(table_name,constraint_name,constraint_type) AS (VALUES
         ('cp_project_target','cp_project_target_binding_generation_check','c'),
         ('cp_effect','cp_effect_pkey','p'),
         ('cp_effect','cp_effect_approval_shape_check','c'),
         ('cp_effect','cp_effect_projection_shape_check','c'),
         ('cp_effect_attempt','cp_effect_attempt_pkey','p'),
         ('cp_effect_attempt','cp_effect_attempt_permit_shape_check','c'),
         ('cp_effect_attempt','cp_effect_attempt_permit_window_check','c'),
         ('cp_effect_evidence','cp_effect_evidence_pkey','p')
       ), required_trigger(table_name,trigger_name,function_name) AS (VALUES
         ('cp_effect','cp_effect_request_immutable','cp_reject_effect_request_mutation'),
         ('cp_effect','cp_effect_approval_immutable','cp_reject_effect_approval_rewrite'),
         ('cp_effect','cp_effect_delete_immutable','cp_reject_effect_authority_mutation'),
         ('cp_effect','cp_effect_state_transition','cp_guard_effect_state_transition'),
         ('cp_effect','cp_effect_projection','cp_project_effect_change'),
         ('cp_effect_attempt','cp_effect_reconciliation_origin',
           'cp_guard_effect_reconciliation_origin'),
         ('cp_effect_attempt','cp_effect_attempt_immutable','cp_reject_effect_authority_mutation'),
         ('cp_effect_evidence','cp_effect_evidence_immutable','cp_reject_effect_authority_mutation'),
         ('cp_hosted_run','cp_hosted_run_cancel_unpermitted_effects',
           'cp_cancel_unpermitted_effects_after_work_terminal')
       ), authority_table(table_name) AS (VALUES
         ('cp_effect'),('cp_effect_attempt'),('cp_effect_evidence')
       ), catalog_line(line) AS (
         SELECT concat_ws('|','column',table_row.relname,attribute.attnum::text,
           attribute.attname,format_type(attribute.atttypid,attribute.atttypmod),
           attribute.attnotnull::text,COALESCE(pg_get_expr(default_value.adbin,
             default_value.adrelid,true),'<null>'))
         FROM pg_class table_row
         JOIN pg_attribute attribute ON attribute.attrelid=table_row.oid
           AND attribute.attnum>0 AND NOT attribute.attisdropped
         LEFT JOIN pg_attrdef default_value ON default_value.adrelid=table_row.oid
           AND default_value.adnum=attribute.attnum
         WHERE table_row.relnamespace=current_schema()::regnamespace
           AND (table_row.relname IN (SELECT table_name FROM authority_table)
             OR (table_row.relname='cp_project_target'
               AND attribute.attname='binding_generation'))
         UNION ALL
         SELECT concat_ws('|','constraint',source_table.relname,constraint_row.conname,
           constraint_row.contype::text,
           array_to_string(ARRAY(SELECT attribute.attname::text
             FROM unnest(constraint_row.conkey) WITH ORDINALITY key(attnum,ordinal)
             JOIN pg_attribute attribute ON attribute.attrelid=constraint_row.conrelid
               AND attribute.attnum=key.attnum ORDER BY key.ordinal),','),
           CASE WHEN constraint_row.confrelid=0 THEN '<null>'
             ELSE constraint_row.confrelid::regclass::text END,
           array_to_string(ARRAY(SELECT attribute.attname::text
             FROM unnest(constraint_row.confkey) WITH ORDINALITY key(attnum,ordinal)
             JOIN pg_attribute attribute ON attribute.attrelid=constraint_row.confrelid
               AND attribute.attnum=key.attnum ORDER BY key.ordinal),','),
           constraint_row.convalidated::text,constraint_row.confmatchtype::text,
           constraint_row.confupdtype::text,constraint_row.confdeltype::text,
           constraint_row.condeferrable::text,constraint_row.condeferred::text,
           constraint_row.connoinherit::text,
           regexp_replace(pg_get_constraintdef(constraint_row.oid,true),'[[:space:]]+','','g'))
         FROM pg_constraint constraint_row
         JOIN pg_class source_table ON source_table.oid=constraint_row.conrelid
         WHERE source_table.relnamespace=current_schema()::regnamespace
           AND (source_table.relname IN (SELECT table_name FROM authority_table)
             OR (source_table.relname='cp_project_target'
               AND constraint_row.conname='cp_project_target_binding_generation_check'))
         UNION ALL
         SELECT concat_ws('|','index',source_table.relname,index_table.relname,
           index_row.indisunique::text,index_row.indisprimary::text,
           index_row.indisvalid::text,index_row.indisready::text,
           index_row.indnkeyatts::text,index_row.indnatts::text,
           array_to_string(ARRAY(SELECT pg_get_indexdef(index_row.indexrelid,
             ordinal::integer,false) FROM generate_series(1,index_row.indnatts)
             ordinal ORDER BY ordinal),','),
           COALESCE(regexp_replace(pg_get_expr(index_row.indpred,index_row.indrelid,true),
             '[[:space:]]+','','g'),'<null>'))
         FROM pg_index index_row
         JOIN pg_class source_table ON source_table.oid=index_row.indrelid
         JOIN pg_class index_table ON index_table.oid=index_row.indexrelid
         WHERE source_table.relnamespace=current_schema()::regnamespace
           AND source_table.relname IN (SELECT table_name FROM authority_table)
         UNION ALL
         SELECT concat_ws('|','trigger',source_table.relname,trigger_row.tgname,
           trigger_row.tgenabled,trigger_row.tgtype::text,
           COALESCE(pg_get_expr(trigger_row.tgqual,trigger_row.tgrelid,true),'<null>'),
           encode(trigger_row.tgargs,'hex'),function_row.proname,
           function_row.provolatile,function_row.prosecdef::text,
           function_row.proisstrict::text,function_row.proleakproof::text,
           language_row.lanname,
           regexp_replace(function_row.prosrc,'[[:space:]]+','','g'))
         FROM pg_trigger trigger_row
         JOIN pg_class source_table ON source_table.oid=trigger_row.tgrelid
         JOIN pg_proc function_row ON function_row.oid=trigger_row.tgfoid
         JOIN pg_language language_row ON language_row.oid=function_row.prolang
         WHERE source_table.relnamespace=current_schema()::regnamespace
           AND NOT trigger_row.tgisinternal
           AND (source_table.relname IN (SELECT table_name FROM authority_table)
             OR (source_table.relname='cp_hosted_run'
               AND trigger_row.tgname='cp_hosted_run_cancel_unpermitted_effects'))
       ), catalog_fingerprint(value) AS (
         SELECT md5(string_agg(line,E'\n' ORDER BY line)) FROM catalog_line
       ) SELECT (
         to_regclass('cp_effect') IS NOT NULL
         AND to_regclass('cp_effect_attempt') IS NOT NULL
         AND to_regclass('cp_effect_evidence') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM legacy_table WHERE to_regclass(name) IS NOT NULL)
         AND to_regprocedure('cp_reject_publication_authority_mutation()') IS NULL
         AND NOT EXISTS (SELECT 1 FROM expected_columns expected WHERE
           (SELECT array_agg(column_name::text ORDER BY ordinal_position)
            FROM information_schema.columns WHERE table_schema=current_schema()
              AND table_name=expected.table_name) IS DISTINCT FROM expected.column_names)
         AND EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema=current_schema() AND table_name='cp_project_target'
             AND column_name='binding_generation' AND data_type='integer'
             AND is_nullable='NO' AND column_default IS NULL)
         AND NOT EXISTS (SELECT 1 FROM required_constraint expected WHERE NOT EXISTS (
           SELECT 1 FROM pg_constraint constraint_row
           WHERE constraint_row.conrelid=to_regclass(expected.table_name)
             AND constraint_row.conname=expected.constraint_name
             AND constraint_row.contype::text=expected.constraint_type
             AND constraint_row.convalidated
             AND (constraint_row.contype <> 'c' OR NOT constraint_row.connoinherit)))
         AND NOT EXISTS (SELECT 1 FROM required_trigger expected WHERE NOT EXISTS (
           SELECT 1 FROM pg_trigger trigger_row
           JOIN pg_proc function_row ON function_row.oid=trigger_row.tgfoid
           WHERE trigger_row.tgrelid=to_regclass(expected.table_name)
             AND trigger_row.tgname=expected.trigger_name
             AND trigger_row.tgenabled='O' AND NOT trigger_row.tgisinternal
             AND function_row.proname=expected.function_name
             AND function_row.pronamespace=current_schema()::regnamespace))
         AND EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace=current_schema()::regnamespace
           AND proname='cp_reject_effect_authority_mutation' AND pronargs=0
           AND prorettype='trigger'::regtype
           AND regexp_replace(prosrc,'[[:space:]]+','','g')=
             'BEGINRAISEEXCEPTION''effect_authority_immutable'';END')
         AND EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace=current_schema()::regnamespace
           AND proname='cp_reject_effect_request_mutation' AND pronargs=0
           AND prosrc LIKE '%effect_request_immutable%' AND prosrc LIKE '%IS DISTINCT FROM%')
         AND EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace=current_schema()::regnamespace
           AND proname='cp_reject_effect_approval_rewrite' AND pronargs=0
           AND prosrc LIKE '%effect_approval_immutable%' AND prosrc LIKE '%OLD.approval_id%')
         AND EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace=current_schema()::regnamespace
           AND proname='cp_guard_effect_state_transition' AND pronargs=0
           AND prosrc LIKE '%effect_state_transition_invalid%'
           AND prosrc LIKE '%effect_terminal_projection_immutable%')
         AND EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace=current_schema()::regnamespace
           AND proname='cp_guard_effect_reconciliation_origin' AND pronargs=0
           AND prosrc LIKE '%effect_reconciliation_origin_invalid%'
           AND prosrc LIKE '%origin.permit_kind=''execute''%')
         AND EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace=current_schema()::regnamespace
           AND proname='cp_project_effect_change' AND pronargs=0
           AND prosrc LIKE '%projection_revision = projection_revision + 1%')
         AND EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace=current_schema()::regnamespace
           AND proname='cp_cancel_unpermitted_effects_after_work_terminal' AND pronargs=0
           AND prosrc LIKE '%work.cancelled_before_permit%')
         AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname=current_schema()
           AND tablename='cp_effect' AND indexname='cp_effect_dispatch_idx')
         AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname=current_schema()
           AND tablename='cp_effect_attempt' AND indexname='cp_effect_execute_attempt_key'
           AND indexdef LIKE '%WHERE (permit_kind = ''execute''::text)%')
         AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname=current_schema()
           AND tablename='cp_effect_evidence' AND indexname='cp_effect_evidence_chain_idx')
         AND (SELECT value FROM catalog_fingerprint) = '2d1e3961cf07a79a6cc1d40a61847116'
       ) AS schema_ready`,
    );
    const current = schema.rows[0]?.schema_ready === true
      && effectAuthority.rows[0]?.schema_ready === true
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
      [["cp_source_content", "cp_source_content_read_grant",
        "cp_source_replay_tombstone"]],
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
      [["cp_slack_binding", "cp_ingress_reservation"]],
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
    const result = await pool.query<{ present: boolean }>(`WITH catalog_line(line) AS (
      SELECT concat_ws('|','column',attribute.attnum::text,attribute.attname,
        format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull::text,
        COALESCE(pg_get_expr(default_value.adbin,default_value.adrelid,true),'<null>'))
      FROM pg_attribute attribute
      LEFT JOIN pg_attrdef default_value ON default_value.adrelid=attribute.attrelid
        AND default_value.adnum=attribute.attnum
      WHERE attribute.attrelid=to_regclass('cp_slack_binding')
        AND attribute.attnum>0 AND NOT attribute.attisdropped
      UNION ALL
      SELECT concat_ws('|','constraint',source.relname,constraint_row.conname,
        constraint_row.contype::text,
        array_to_string(ARRAY(SELECT target_attribute.attname::text
          FROM unnest(constraint_row.conkey) WITH ORDINALITY key(attnum,n)
          JOIN pg_attribute target_attribute ON target_attribute.attrelid=constraint_row.conrelid
            AND target_attribute.attnum=key.attnum ORDER BY n),','),
        CASE WHEN constraint_row.confrelid=0 THEN '<null>'
          ELSE constraint_row.confrelid::regclass::text END,
        array_to_string(ARRAY(SELECT target_attribute.attname::text
          FROM unnest(constraint_row.confkey) WITH ORDINALITY key(attnum,n)
          JOIN pg_attribute target_attribute ON target_attribute.attrelid=constraint_row.confrelid
            AND target_attribute.attnum=key.attnum ORDER BY n),','),
        constraint_row.convalidated::text,constraint_row.confmatchtype::text,
        constraint_row.confupdtype::text,constraint_row.confdeltype::text,
        constraint_row.condeferrable::text,constraint_row.condeferred::text,
        constraint_row.connoinherit::text,
        regexp_replace(pg_get_constraintdef(constraint_row.oid,true),'[[:space:]]+','','g'))
      FROM pg_constraint constraint_row
      JOIN pg_class source ON source.oid=constraint_row.conrelid
      WHERE source.relnamespace=current_schema()::regnamespace
        AND (constraint_row.conrelid=to_regclass('cp_slack_binding')
          OR constraint_row.conname IN ('cp_ingress_reservation_slack_binding_fkey',
            'cp_slack_action_authority_slack_binding_fkey'))
      UNION ALL
      SELECT concat_ws('|','index',index_table.relname,index_row.indisunique::text,
        index_row.indisprimary::text,index_row.indisvalid::text,index_row.indisready::text,
        index_row.indnkeyatts::text,index_row.indnatts::text,
        array_to_string(ARRAY(SELECT pg_get_indexdef(index_row.indexrelid,n,false)
          FROM generate_series(1,index_row.indnatts) n ORDER BY n),','),
        COALESCE(regexp_replace(pg_get_expr(index_row.indpred,index_row.indrelid,true),
          '[[:space:]]+','','g'),'<null>'))
      FROM pg_index index_row JOIN pg_class index_table ON index_table.oid=index_row.indexrelid
      WHERE index_row.indrelid=to_regclass('cp_slack_binding')
      UNION ALL
      SELECT concat_ws('|','trigger',trigger_row.tgname,trigger_row.tgenabled,
        trigger_row.tgtype::text,COALESCE(pg_get_expr(trigger_row.tgqual,
          trigger_row.tgrelid,true),'<null>'),encode(trigger_row.tgargs,'hex'),
        function_row.proname,regexp_replace(function_row.prosrc,'[[:space:]]+','','g'))
      FROM pg_trigger trigger_row JOIN pg_proc function_row ON function_row.oid=trigger_row.tgfoid
      WHERE trigger_row.tgrelid=to_regclass('cp_slack_binding')
        AND NOT trigger_row.tgisinternal
    ), catalog_fingerprint(value) AS (
      SELECT md5(string_agg(line,E'\n' ORDER BY line)) FROM catalog_line
    ) SELECT
      to_regclass('cp_slack_binding') IS NOT NULL
      AND to_regclass('cp_slack_action_authority') IS NOT NULL
      AND to_regclass('cp_source_app_installation') IS NULL
      AND to_regclass('cp_source_binding') IS NULL
      AND to_regclass('cp_slack_installation') IS NULL
      AND (SELECT array_agg(column_name::text ORDER BY ordinal_position)
        FROM information_schema.columns WHERE table_schema=current_schema()
          AND table_name='cp_slack_binding')=ARRAY[
        'organization_id','binding_id','installation_id','binding_digest','state',
        'credential_generation','credential_generation_digest','route_identity','team_id',
        'app_id','channel_id','bot_user_id','member_user_ids','operator_user_ids',
        'approver_user_id','admin_user_ids','signing_secret_ref','bot_token_ref',
        'project_target_id','publication_mode','display_name','created_at','updated_at']
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='cp_slack_binding' AND column_name='display_name'
        AND data_type='text' AND is_nullable='NO' AND column_default='''OpenTag''::text')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_binding'::regclass
        AND conname='cp_slack_binding_pkey' AND contype='p' AND convalidated
        AND pg_get_constraintdef(oid)='PRIMARY KEY (organization_id, binding_id)')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_binding'::regclass
        AND conname='cp_slack_binding_organization_id_installation_id_key' AND contype='u'
        AND convalidated AND pg_get_constraintdef(oid)=
          'UNIQUE (organization_id, installation_id)')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_binding'::regclass
        AND conname='cp_slack_binding_organization_id_binding_id_installation_id_key'
        AND contype='u' AND convalidated AND pg_get_constraintdef(oid)=
          'UNIQUE (organization_id, binding_id, installation_id)')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_binding'::regclass
        AND conname='cp_slack_binding_route_identity_key' AND contype='u' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_binding'::regclass
        AND conname='cp_slack_binding_team_id_app_id_channel_id_key'
        AND contype='u' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_binding'::regclass
        AND conname='cp_slack_binding_publication_mode_check' AND contype='c' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_binding'::regclass
        AND conname='cp_slack_binding_roles_check' AND contype='c' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_ingress_reservation'::regclass
        AND conname='cp_ingress_reservation_slack_binding_fkey' AND contype='f' AND convalidated
        AND confrelid='cp_slack_binding'::regclass AND confdeltype='a'
        AND ARRAY(SELECT attname::text FROM unnest(conkey) WITH ORDINALITY key(attnum,n)
          JOIN pg_attribute ON attrelid=conrelid AND pg_attribute.attnum=key.attnum ORDER BY n)
          =ARRAY['organization_id','binding_id','installation_id'])
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_slack_binding_fkey' AND contype='f' AND convalidated
        AND confrelid='cp_slack_binding'::regclass AND confdeltype='c'
        AND ARRAY(SELECT attname::text FROM unnest(conkey) WITH ORDINALITY key(attnum,n)
          JOIN pg_attribute ON attrelid=conrelid AND pg_attribute.attnum=key.attnum ORDER BY n)
          =ARRAY['organization_id','binding_id','installation_id'])
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='cp_slack_action_authority'::regclass
        AND attname='effect_approval' AND NOT attisdropped AND NOT attnotnull
        AND format_type(atttypid,atttypmod)='jsonb'
        AND NOT EXISTS (SELECT 1 FROM pg_attrdef
          WHERE adrelid='cp_slack_action_authority'::regclass AND adnum=attnum))
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_projection_generation_check' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_effect_shape_check' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_kind_check' AND convalidated
        AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')=
          'CHECK((action_kind=ANY(ARRAY[''status''::text,''cancel''::text,''approval''::text,''effect''::text,''bind''::text,''unbind''::text])))')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_claim_shape_check' AND convalidated)
      AND (SELECT value FROM catalog_fingerprint)='14357047bdee89643757ab33fd042fd3'
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
    const result = await pool.query<{ ready: boolean;
      function_bodies: Record<string,string> | null }>(`SELECT
      (SELECT count(*)=1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='cp_hosted_run' AND ordinal_position=29 AND column_name='projection_revision'
        AND data_type='integer' AND is_nullable='NO' AND column_default='1')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_hosted_run'::regclass
        AND conname='cp_hosted_run_projection_revision_check' AND convalidated)
      AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='cp_provider_delivery_intent'::regclass
        AND attname='projection_revision' AND attnotnull AND NOT attisdropped)
      AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='cp_provider_delivery_intent'::regclass
        AND attname='projection_purpose' AND attnotnull AND NOT attisdropped)
      AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='cp_provider_delivery_intent'::regclass
        AND attname='projection_event_sequence' AND attnotnull AND NOT attisdropped)
      AND (SELECT count(*)=3 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='cp_provider_delivery_intent' AND (
          (ordinal_position=44 AND column_name='projection_revision' AND data_type='integer'
            AND is_nullable='NO' AND column_default='1') OR
          (ordinal_position=45 AND column_name='projection_purpose' AND data_type='text'
            AND is_nullable='NO' AND column_default='''external''::text') OR
          (ordinal_position=46 AND column_name='projection_event_sequence' AND data_type='integer'
            AND is_nullable='NO' AND column_default='0')))
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_provider_delivery_intent'::regclass
        AND conname='cp_provider_delivery_projection_purpose_check' AND contype='c' AND convalidated
        AND NOT connoinherit AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')=
          'CHECK((projection_purpose=ANY(ARRAY[''external''::text,''anchor_create''::text,''anchor_update''::text])))')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_provider_delivery_intent'::regclass
        AND conname='cp_provider_delivery_projection_event_sequence_check' AND contype='c' AND convalidated
        AND NOT connoinherit AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')=
          'CHECK((projection_event_sequence>=0))')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_provider_delivery_intent'::regclass
        AND conname='cp_provider_delivery_projection_revision_check' AND contype='c' AND convalidated
        AND NOT connoinherit AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')=
          'CHECK((projection_revision>0))')
      AND to_regclass('cp_projection_delivery_watermark') IS NOT NULL
      AND to_regclass('cp_projection_deferred_revision') IS NOT NULL
      AND to_regclass('cp_projection_event_cursor') IS NOT NULL
      AND to_regclass('cp_provider_delivery_truth_lock') IS NOT NULL
      AND (SELECT count(*)=3 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='cp_projection_event_cursor')
      AND (SELECT count(*)=8 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='cp_projection_delivery_watermark')
      AND (SELECT count(*)=7 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='cp_projection_deferred_revision')
      AND (SELECT count(*)=1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='cp_provider_delivery_truth_lock')
      AND (SELECT count(*)=3 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='cp_projection_event_cursor'
        AND ((ordinal_position=1 AND column_name='organization_id' AND data_type='text'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=2 AND column_name='run_id' AND data_type='text'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=3 AND column_name='current_sequence' AND data_type='integer' AND is_nullable='NO'
            AND column_default='0')))
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_projection_delivery_watermark'::regclass
        AND conname='cp_projection_delivery_watermark_run_event_key' AND contype='u' AND convalidated
        AND pg_get_constraintdef(oid)='UNIQUE (organization_id, run_id, event_sequence)')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_projection_delivery_watermark'::regclass
        AND conname='cp_projection_delivery_watermark_event_sequence_check' AND contype='c' AND convalidated
        AND NOT connoinherit AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')=
          'CHECK((event_sequence>0))')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_projection_delivery_watermark'::regclass
        AND conname='cp_projection_delivery_watermark_check' AND contype='c' AND convalidated
        AND NOT connoinherit AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')=
          'CHECK(((delivery_revision>0)AND(projection_revision>0)))')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_projection_event_cursor'::regclass
        AND conname='cp_projection_event_cursor_current_sequence_check' AND contype='c' AND convalidated
        AND NOT connoinherit AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')=
          'CHECK((current_sequence>=0))')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_projection_event_cursor'::regclass
        AND conname='cp_projection_event_cursor_pkey' AND contype='p' AND convalidated
        AND pg_get_constraintdef(oid)='PRIMARY KEY (organization_id, run_id)')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_projection_event_cursor'::regclass
        AND conname='cp_projection_event_cursor_organization_id_run_id_fkey' AND contype='f'
        AND convalidated AND NOT condeferrable AND NOT condeferred AND confrelid='cp_hosted_run'::regclass
        AND confupdtype='a' AND confdeltype='a'
        AND pg_get_constraintdef(oid)='FOREIGN KEY (organization_id, run_id) REFERENCES cp_hosted_run(organization_id, run_id)')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_projection_delivery_watermark'::regclass
        AND conname='cp_projection_delivery_watermark_pkey' AND contype='p' AND convalidated
        AND pg_get_constraintdef(oid)='PRIMARY KEY (intent_id, delivery_state, delivery_revision)')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_projection_delivery_watermark'::regclass
        AND conname='cp_projection_delivery_watermark_organization_id_run_id_fkey' AND contype='f'
        AND convalidated AND NOT condeferrable AND NOT condeferred AND confrelid='cp_hosted_run'::regclass
        AND confupdtype='a' AND confdeltype='a'
        AND pg_get_constraintdef(oid)='FOREIGN KEY (organization_id, run_id) REFERENCES cp_hosted_run(organization_id, run_id)')
      AND (SELECT count(*)=7 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='cp_projection_deferred_revision'
        AND ((ordinal_position=1 AND column_name='organization_id' AND data_type='text'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=2 AND column_name='run_id' AND data_type='text'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=3 AND column_name='projection_revision' AND data_type='integer'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=4 AND column_name='anchor_intent_id' AND data_type='text'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=5 AND column_name='state' AND data_type='text'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=6 AND column_name='created_at' AND data_type='timestamp with time zone'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=7 AND column_name='woken_at' AND data_type='timestamp with time zone'
            AND is_nullable='YES' AND column_default IS NULL)))
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_projection_deferred_revision'::regclass
        AND conname='cp_projection_deferred_revision_pkey' AND contype='p' AND convalidated
        AND pg_get_constraintdef(oid)='PRIMARY KEY (organization_id, run_id, projection_revision)')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_projection_deferred_revision'::regclass
        AND conname='cp_projection_deferred_revision_organization_id_run_id_fkey' AND contype='f'
        AND convalidated AND NOT condeferrable AND NOT condeferred AND confrelid='cp_hosted_run'::regclass
        AND confupdtype='a' AND confdeltype='a'
        AND pg_get_constraintdef(oid)='FOREIGN KEY (organization_id, run_id) REFERENCES cp_hosted_run(organization_id, run_id)')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_projection_deferred_revision'::regclass
        AND conname='cp_projection_deferred_revision_projection_revision_check' AND contype='c' AND convalidated
        AND NOT connoinherit AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')='CHECK((projection_revision>0))')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_projection_deferred_revision'::regclass
        AND conname='cp_projection_deferred_revision_state_check' AND contype='c' AND convalidated
        AND NOT connoinherit AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')=
          'CHECK((state=ANY(ARRAY[''pending''::text,''woken''::text])))')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_projection_deferred_revision'::regclass
        AND conname='cp_projection_deferred_revision_check' AND contype='c' AND convalidated
        AND NOT connoinherit AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')=
          'CHECK((((state=''pending''::text)AND(woken_atISNULL))OR((state=''woken''::text)AND(woken_atISNOTNULL))))')
      AND (SELECT count(*)=1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='cp_provider_delivery_truth_lock'
        AND ordinal_position=1 AND column_name='current_truth_key' AND data_type='text'
        AND is_nullable='NO' AND column_default IS NULL)
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_provider_delivery_truth_lock'::regclass
        AND conname='cp_provider_delivery_truth_lock_pkey' AND contype='p' AND convalidated
        AND pg_get_constraintdef(oid)='PRIMARY KEY (current_truth_key)')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_decisions_check' AND convalidated
        AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')=
          'CHECK(((cardinality(allowed_decisions)>0)AND(allowed_decisions<@ARRAY[''status''::text,''cancel''::text,''allow_once''::text,''allow_run''::text,''deny''::text,''effect_approve''::text,''bind''::text,''unbind''::text])))')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_epoch_check' AND convalidated
        AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')='CHECK((authority_epoch>0))')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_claim_state_check' AND convalidated
        AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')=
          'CHECK((claim_state=ANY(ARRAY[''available''::text,''claimed''::text,''consumed''::text])))')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_claim_shape_check' AND convalidated
        AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')=
          'CHECK((((claim_state=''available''::text)AND(claimed_atISNULL)AND(consumed_atISNULL))OR((claim_state=''claimed''::text)AND(claimed_atISNOTNULL)AND(consumed_atISNULL))OR((claim_state=''consumed''::text)AND(consumed_atISNOTNULL))))')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_projection_generation_check' AND convalidated
        AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')='CHECK((projection_generation>0))')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cp_slack_action_authority'::regclass
        AND conname='cp_slack_action_authority_effect_shape_check' AND convalidated
        AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]+','','g')=
          'CHECK(((action_kind=''effect''::text)=(effect_approvalISNOTNULL)))')
      AND (SELECT count(*)=8 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='cp_projection_delivery_watermark'
        AND ((ordinal_position=1 AND column_name='organization_id' AND data_type='text'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=2 AND column_name='run_id' AND data_type='text'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=3 AND column_name='intent_id' AND data_type='text'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=4 AND column_name='delivery_state' AND data_type='text'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=5 AND column_name='delivery_revision' AND data_type='integer'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=6 AND column_name='projection_revision' AND data_type='integer'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=7 AND column_name='created_at' AND data_type='timestamp with time zone'
            AND is_nullable='NO' AND column_default IS NULL)
          OR (ordinal_position=8 AND column_name='event_sequence' AND data_type='integer'
            AND is_nullable='NO' AND column_default IS NULL)))
      AND EXISTS(SELECT 1 FROM pg_proc function_row JOIN pg_namespace namespace
        ON namespace.oid=function_row.pronamespace JOIN pg_language language_row ON language_row.oid=function_row.prolang
        WHERE namespace.nspname=current_schema() AND function_row.proname='cp_enqueue_team_relay_projection'
          AND function_row.pronargs=3 AND language_row.lanname='plpgsql'
          AND pg_get_function_result(function_row.oid)='void'
          AND pg_get_functiondef(function_row.oid) LIKE '%cp_insert_team_relay_v2_job%')
      AND EXISTS(SELECT 1 FROM pg_proc function_row JOIN pg_namespace namespace
        ON namespace.oid=function_row.pronamespace JOIN pg_language language_row ON language_row.oid=function_row.prolang
        WHERE namespace.nspname=current_schema() AND function_row.proname='cp_insert_team_relay_v2_job'
          AND function_row.pronargs=3 AND language_row.lanname='plpgsql'
          AND pg_get_function_result(function_row.oid)='void')
      AND NOT EXISTS(SELECT 1 FROM (VALUES
        ('cp_hosted_run_projection_before',0,''::text,'trigger'),
        ('cp_hosted_run_projection_after',0,'','trigger'),
        ('cp_related_projection_after',0,'','trigger'),
        ('cp_enqueue_team_relay_projection',3,'25 25 23','void'),
        ('cp_delivery_projection_after',0,'','trigger'),
        ('cp_insert_team_relay_v2_job',3,'25 25 3802','void'),
        ('cp_project_effect_change',0,'','trigger'),
        ('cp_provider_delivery_guard',0,'','trigger'),
        ('cp_provider_delivery_delete_guard',0,'','trigger')
      ) expected(name,nargs,argtypes,result_type)
      LEFT JOIN pg_proc function_row ON function_row.pronamespace=current_schema()::regnamespace
        AND function_row.proname=expected.name
      LEFT JOIN pg_language language_row ON language_row.oid=function_row.prolang
      WHERE function_row.oid IS NULL OR function_row.pronargs<>expected.nargs
        OR function_row.proargtypes::text<>expected.argtypes
        OR pg_get_function_result(function_row.oid)<>expected.result_type
        OR language_row.lanname<>'plpgsql' OR function_row.provolatile<>'v'
        OR function_row.proisstrict OR function_row.prosecdef OR function_row.proleakproof
        OR function_row.proparallel<>'u' OR function_row.proconfig IS NOT NULL
        OR function_row.proacl IS NOT NULL OR pg_get_userbyid(function_row.proowner)<>current_user)
      AND EXISTS(SELECT 1 FROM pg_proc function_row JOIN pg_namespace namespace ON namespace.oid=function_row.pronamespace
        JOIN pg_language language_row ON language_row.oid=function_row.prolang
        WHERE namespace.nspname=current_schema() AND function_row.proname='cp_delivery_projection_after'
          AND function_row.pronargs=0 AND language_row.lanname='plpgsql'
          AND pg_get_function_result(function_row.oid)='trigger'
          AND pg_get_functiondef(function_row.oid) LIKE '%projection_purpose%anchor_create%'
          AND pg_get_functiondef(function_row.oid) LIKE '%projection_purpose%anchor_update%'
          AND pg_get_functiondef(function_row.oid) LIKE '%anchor_intent_id%NEW.intent_id%'
          AND pg_get_functiondef(function_row.oid) LIKE '%event_sequence%'
          AND pg_get_functiondef(function_row.oid) LIKE '%cp_projection_event_cursor%'
          AND pg_get_functiondef(function_row.oid) LIKE '%cp_projection_delivery_watermark%')
      AND (SELECT count(*)=6 FROM pg_trigger trigger_row
        JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
        JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        JOIN pg_proc function_row ON function_row.oid=trigger_row.tgfoid
        WHERE namespace.nspname=current_schema() AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled='O' AND trigger_row.tgqual IS NULL AND trigger_row.tgnargs=0
          AND function_row.pronamespace=current_schema()::regnamespace AND (
          (trigger_row.tgname='cp_hosted_run_projection_before_trigger' AND relation.relname='cp_hosted_run'
            AND trigger_row.tgtype=19 AND function_row.proname='cp_hosted_run_projection_before') OR
          (trigger_row.tgname='cp_hosted_run_projection_after_trigger' AND relation.relname='cp_hosted_run'
            AND trigger_row.tgtype=21 AND function_row.proname='cp_hosted_run_projection_after') OR
          (trigger_row.tgname='cp_permission_projection_trigger' AND relation.relname='cp_permission_request'
            AND trigger_row.tgtype=21 AND function_row.proname='cp_related_projection_after') OR
          (trigger_row.tgname='cp_candidate_projection_trigger' AND relation.relname='cp_publication_candidate'
            AND trigger_row.tgtype=21 AND function_row.proname='cp_related_projection_after') OR
          (trigger_row.tgname='cp_effect_projection' AND relation.relname='cp_effect'
            AND trigger_row.tgtype=21 AND function_row.proname='cp_project_effect_change') OR
          (trigger_row.tgname='cp_delivery_projection_trigger' AND relation.relname='cp_provider_delivery_intent'
            AND trigger_row.tgtype=17 AND function_row.proname='cp_delivery_projection_after')))
      AND NOT EXISTS(SELECT 1 FROM pg_trigger trigger_row
        JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
        JOIN pg_namespace relation_namespace ON relation_namespace.oid=relation.relnamespace
        JOIN pg_proc function_row ON function_row.oid=trigger_row.tgfoid
        WHERE NOT trigger_row.tgisinternal AND trigger_row.tgenabled='O'
          AND relation_namespace.nspname=current_schema()
          AND function_row.pronamespace=current_schema()::regnamespace
          AND function_row.proname LIKE '%projection%'
          AND trigger_row.tgname NOT IN ('cp_hosted_run_projection_before_trigger',
            'cp_hosted_run_projection_after_trigger','cp_permission_projection_trigger',
            'cp_candidate_projection_trigger','cp_effect_projection',
            'cp_delivery_projection_trigger'))
      AND NOT EXISTS(SELECT 1 FROM pg_trigger trigger_row
        JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
        JOIN pg_namespace relation_namespace ON relation_namespace.oid=relation.relnamespace
        JOIN pg_proc function_row ON function_row.oid=trigger_row.tgfoid
        WHERE NOT trigger_row.tgisinternal AND trigger_row.tgenabled='O'
          AND relation_namespace.nspname=current_schema()
          AND relation.relname=ANY(ARRAY['cp_hosted_run','cp_permission_request',
            'cp_publication_candidate','cp_effect','cp_provider_delivery_intent',
            'cp_projection_event_cursor','cp_projection_delivery_watermark',
            'cp_projection_deferred_revision','cp_provider_delivery_truth_lock'])
          AND (NOT ((relation.relname,trigger_row.tgname,trigger_row.tgtype,function_row.proname) IN (
            ('cp_hosted_run','cp_hosted_run_frozen_admission_guard',19,'cp_hosted_run_frozen_admission_guard'),
            ('cp_hosted_run','cp_hosted_run_projection_after_trigger',21,'cp_hosted_run_projection_after'),
            ('cp_hosted_run','cp_hosted_run_projection_before_trigger',19,'cp_hosted_run_projection_before'),
            ('cp_hosted_run','cp_hosted_run_source_content_terminal_after',17,
              'cp_hosted_run_source_content_terminal_after'),
            ('cp_hosted_run','cp_hosted_run_cancel_unpermitted_effects',17,
              'cp_cancel_unpermitted_effects_after_work_terminal'),
            ('cp_permission_request','cp_permission_projection_trigger',21,'cp_related_projection_after'),
            ('cp_provider_delivery_intent','cp_delivery_projection_trigger',17,'cp_delivery_projection_after'),
            ('cp_provider_delivery_intent','cp_provider_delivery_delete_guard',11,'cp_provider_delivery_delete_guard'),
            ('cp_provider_delivery_intent','cp_provider_delivery_guard',19,'cp_provider_delivery_guard'),
            ('cp_publication_candidate','cp_candidate_projection_trigger',21,'cp_related_projection_after'),
            ('cp_publication_candidate','cp_publication_candidate_immutable',27,'cp_reject_publication_candidate_mutation'),
            ('cp_effect','cp_effect_approval_immutable',19,'cp_reject_effect_approval_rewrite'),
            ('cp_effect','cp_effect_delete_immutable',11,'cp_reject_effect_authority_mutation'),
            ('cp_effect','cp_effect_projection',21,'cp_project_effect_change'),
            ('cp_effect','cp_effect_request_immutable',19,'cp_reject_effect_request_mutation'),
            ('cp_effect','cp_effect_state_transition',19,'cp_guard_effect_state_transition')))
          OR trigger_row.tgnargs<>0 OR trigger_row.tgqual IS NOT NULL
          OR function_row.pronamespace<>current_schema()::regnamespace))
      AND (SELECT count(*)=16 FROM pg_trigger trigger_row
        JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
        JOIN pg_namespace relation_namespace ON relation_namespace.oid=relation.relnamespace
        WHERE NOT trigger_row.tgisinternal AND trigger_row.tgenabled='O'
          AND relation_namespace.nspname=current_schema()
          AND relation.relname=ANY(ARRAY['cp_hosted_run','cp_permission_request',
            'cp_publication_candidate','cp_effect','cp_provider_delivery_intent',
            'cp_projection_event_cursor','cp_projection_delivery_watermark',
            'cp_projection_deferred_revision','cp_provider_delivery_truth_lock'])) AS ready,
      (SELECT jsonb_object_agg(proname,prosrc) FROM pg_proc
        WHERE pronamespace=current_schema()::regnamespace AND proname=ANY(ARRAY[
          'cp_hosted_run_projection_before','cp_hosted_run_projection_after',
          'cp_related_projection_after','cp_enqueue_team_relay_projection',
          'cp_delivery_projection_after','cp_insert_team_relay_v2_job','cp_project_effect_change',
          'cp_provider_delivery_guard','cp_provider_delivery_delete_guard'])) AS function_bodies`);
    const row=result.rows[0];
    const expectedBodies:Record<string,string>={
      cp_hosted_run_projection_before:"ce182dbbbc5b7e647d44cfc21743d251c9403617fffb4995add1f262ef3f0201",
      cp_hosted_run_projection_after:"db7cb6eeea57bdb6651d30c9f9076d34df40a2c3f0414507bab711ded77b2351",
      cp_related_projection_after:"45df6d507d1d6a13538b119a53ce564a7a4d14752400d0847c62436cf9fb5edc",
      cp_enqueue_team_relay_projection:"a3c97f7dd4eebbc2ccc938a2c872d12bb6334fa85dcd87c10f8d76b4c1ca28f5",
      cp_delivery_projection_after:"6b6728815b61052622498226f1942cd74be0917267a07377b4fefa915f0c7ae7",
      cp_insert_team_relay_v2_job:"a16b6ab0f3a0b730e46d866edabf1f2e354546f609ac7b96c8c682af2f28d0b2",
      cp_project_effect_change:"e85e2d9679ffcc665f2d125d3787d0cbb88425c9a708bda625c8fb9184eb5a0f",
      cp_provider_delivery_guard:"5c12474059a64ee2cbc07c94f317e59667a69cd31b52dcea817bc4feacc82477",
      cp_provider_delivery_delete_guard:"e81aff8787906c110cdb1f222824bbec8ba939b8d4d6b4448a5e3e48c8909e7a"};
    const exactBodies=row?.function_bodies!==null&&row?.function_bodies!==undefined
      &&Object.keys(row.function_bodies).length===Object.keys(expectedBodies).length
      &&Object.entries(expectedBodies).every(([name,digest])=>typeof row.function_bodies?.[name]==="string"
        &&createHash("sha256").update(row.function_bodies[name]!).digest("hex")===digest);
    return row?.ready && exactBodies ? { ready: true }
      : { ready: false, reason: "migrations_pending" };
  } catch { return { ready: false, reason: "migrations_pending" }; }
}
