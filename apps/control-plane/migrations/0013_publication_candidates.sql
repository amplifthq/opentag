CREATE TABLE IF NOT EXISTS cp_publication_candidate (
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  candidate_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  attempt_number integer,
  project_target_id text NOT NULL,
  frozen_base_revision text NOT NULL,
  workspace_tree_digest text NOT NULL,
  patch_digest text NOT NULL,
  changed_files text[] NOT NULL,
  verification_evidence_ids text[] NOT NULL,
  publication_policy_digest text NOT NULL,
  candidate jsonb NOT NULL,
  completion_assessment jsonb,
  created_at timestamptz NOT NULL,
  CONSTRAINT cp_publication_candidate_pkey PRIMARY KEY (organization_id, candidate_id),
  CONSTRAINT cp_publication_candidate_organization_run_attempt_key
    UNIQUE (organization_id, run_id, attempt_id)
);

DROP TRIGGER IF EXISTS cp_publication_candidate_immutable ON cp_publication_candidate;

ALTER TABLE cp_publication_candidate
  ADD COLUMN IF NOT EXISTS attempt_number integer,
  ADD COLUMN IF NOT EXISTS completion_assessment jsonb;

UPDATE cp_publication_candidate candidate
SET attempt_number = attempt.attempt_number
FROM cp_hosted_attempt attempt
WHERE candidate.organization_id = attempt.organization_id
  AND candidate.run_id = attempt.run_id
  AND candidate.attempt_id = attempt.attempt_id
  AND candidate.attempt_number IS NULL;

CREATE OR REPLACE FUNCTION cp_is_canonical_utc_millis(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF value !~ '^(000[1-9]|00[1-9][0-9]|0[1-9][0-9]{2}|[1-9][0-9]{3})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' THEN
    RETURN false;
  END IF;
  RETURN to_char(value::timestamptz AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = value;
EXCEPTION WHEN others THEN
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION cp_is_strict_historical_identity_array(
  value jsonb, require_digest boolean
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  item jsonb;
  item_text text;
  previous text;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array' OR jsonb_array_length(value) = 0 THEN
    RETURN false;
  END IF;
  FOR item IN SELECT element FROM jsonb_array_elements(value) AS elements(element) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    item_text := item #>> '{}';
    IF item_text = ''
      OR (require_digest AND item_text !~ '^sha256:[a-f0-9]{64}$')
      OR (previous IS NOT NULL AND previous COLLATE "C" >= item_text COLLATE "C") THEN
      RETURN false;
    END IF;
    previous := item_text;
  END LOOP;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION cp_is_strict_historical_candidate(
  value jsonb, durable_candidate_id text, durable_run_id text, durable_attempt_id text,
  durable_project_target_id text, durable_frozen_base_revision text,
  durable_workspace_tree_digest text, durable_patch_digest text,
  durable_changed_files text[], durable_verification_evidence_ids text[],
  durable_publication_policy_digest text, durable_created_at timestamptz
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  exact_keys boolean;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  SELECT count(*) = 11
      AND bool_and(key = ANY(ARRAY['candidateId','runId','attemptId','projectTargetId',
        'frozenBaseRevision','workspaceTreeDigest','patchDigest','changedFiles',
        'verificationEvidenceIds','publicationPolicyDigest','createdAt']))
    INTO exact_keys
    FROM jsonb_object_keys(value) AS keys(key);
  IF exact_keys IS DISTINCT FROM true
    OR jsonb_typeof(value->'candidateId') IS DISTINCT FROM 'string'
    OR value->>'candidateId' = '' OR value->>'candidateId' <> durable_candidate_id
    OR jsonb_typeof(value->'runId') IS DISTINCT FROM 'string'
    OR value->>'runId' = '' OR value->>'runId' <> durable_run_id
    OR jsonb_typeof(value->'attemptId') IS DISTINCT FROM 'string'
    OR value->>'attemptId' = '' OR value->>'attemptId' <> durable_attempt_id
    OR jsonb_typeof(value->'projectTargetId') IS DISTINCT FROM 'string'
    OR value->>'projectTargetId' = '' OR value->>'projectTargetId' <> durable_project_target_id
    OR jsonb_typeof(value->'frozenBaseRevision') IS DISTINCT FROM 'string'
    OR value->>'frozenBaseRevision' !~ '^[a-f0-9]{40,64}$'
    OR value->>'frozenBaseRevision' <> durable_frozen_base_revision
    OR jsonb_typeof(value->'workspaceTreeDigest') IS DISTINCT FROM 'string'
    OR value->>'workspaceTreeDigest' !~ '^[a-f0-9]{40,64}$'
    OR value->>'workspaceTreeDigest' <> durable_workspace_tree_digest
    OR jsonb_typeof(value->'patchDigest') IS DISTINCT FROM 'string'
    OR value->>'patchDigest' !~ '^sha256:[a-f0-9]{64}$'
    OR value->>'patchDigest' <> durable_patch_digest
    OR NOT cp_is_strict_historical_identity_array(value->'changedFiles', false)
    OR value->'changedFiles' <> to_jsonb(durable_changed_files)
    OR NOT cp_is_strict_historical_identity_array(value->'verificationEvidenceIds', true)
    OR value->'verificationEvidenceIds' <> to_jsonb(durable_verification_evidence_ids)
    OR jsonb_typeof(value->'publicationPolicyDigest') IS DISTINCT FROM 'string'
    OR value->>'publicationPolicyDigest' !~ '^sha256:[a-f0-9]{64}$'
    OR value->>'publicationPolicyDigest' <> durable_publication_policy_digest
    OR jsonb_typeof(value->'createdAt') IS DISTINCT FROM 'string'
    OR NOT cp_is_canonical_utc_millis(value->>'createdAt')
    OR value->>'createdAt' <> to_char(durable_created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION cp_is_strict_historical_proposal_assessment(
  value jsonb, durable_candidate_id text
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  exact_keys boolean;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  SELECT count(*) = 5
      AND bool_and(key = ANY(ARRAY['state','accepted','candidateId','reasonCodes','assessedAt']))
    INTO exact_keys
    FROM jsonb_object_keys(value) AS keys(key);
  RETURN exact_keys IS TRUE
    AND jsonb_typeof(value->'state') = 'string'
    AND value->>'state' = 'proposal_ready'
    AND jsonb_typeof(value->'accepted') = 'boolean'
    AND value->'accepted' = 'true'::jsonb
    AND jsonb_typeof(value->'candidateId') = 'string'
    AND value->>'candidateId' = durable_candidate_id
    AND jsonb_typeof(value->'reasonCodes') = 'array'
    AND value->'reasonCodes' = '["proposal_ready"]'::jsonb
    AND jsonb_typeof(value->'assessedAt') = 'string'
    AND cp_is_canonical_utc_millis(value->>'assessedAt');
EXCEPTION WHEN others THEN
  RETURN false;
END $$;

UPDATE cp_publication_candidate candidate
SET completion_assessment = run.terminal_receipt->'assessment'
FROM cp_hosted_run run
WHERE candidate.organization_id = run.organization_id
  AND candidate.run_id = run.run_id
  AND candidate.completion_assessment IS NULL
  AND run.publication_mode = 'proposal_only'
  AND run.completion_mode = 'proposal_ready'
  AND run.publication_policy_digest = candidate.publication_policy_digest
  AND run.state = 'succeeded'
  AND run.terminal_kind = 'succeeded'
  AND run.terminal_receipt->>'kind' = 'proposal_ready'
  AND run.terminal_receipt->>'candidateId' = candidate.candidate_id
  AND cp_is_strict_historical_proposal_assessment(
    run.terminal_receipt->'assessment', candidate.candidate_id)
  AND cp_is_strict_historical_candidate(candidate.candidate, candidate.candidate_id,
    candidate.run_id, candidate.attempt_id, candidate.project_target_id,
    candidate.frozen_base_revision, candidate.workspace_tree_digest, candidate.patch_digest,
    candidate.changed_files, candidate.verification_evidence_ids,
    candidate.publication_policy_digest, candidate.created_at);

DROP FUNCTION cp_is_strict_historical_proposal_assessment(jsonb, text);
DROP FUNCTION cp_is_strict_historical_candidate(jsonb, text, text, text, text, text, text,
  text, text[], text[], text, timestamptz);
DROP FUNCTION cp_is_strict_historical_identity_array(jsonb, boolean);
DROP FUNCTION cp_is_canonical_utc_millis(text);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cp_publication_candidate
    WHERE attempt_number IS NULL OR completion_assessment IS NULL) THEN
    RAISE EXCEPTION 'publication_candidate_upgrade_reconciliation_required';
  END IF;
END $$;

ALTER TABLE cp_publication_candidate
  ALTER COLUMN attempt_number SET NOT NULL,
  ALTER COLUMN completion_assessment SET NOT NULL;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'cp_publication_candidate_organization_id_run_id_attempt_id_key'
      AND conrelid = 'cp_publication_candidate'::regclass)
    AND NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'cp_publication_candidate_organization_run_attempt_key'
        AND conrelid = 'cp_publication_candidate'::regclass) THEN
    ALTER TABLE cp_publication_candidate
      DROP CONSTRAINT cp_publication_candidate_organization_id_run_id_attempt_id_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'cp_publication_candidate_organization_run_attempt_key'
      AND conrelid = 'cp_publication_candidate'::regclass) THEN
    ALTER TABLE cp_publication_candidate
      ADD CONSTRAINT cp_publication_candidate_organization_run_attempt_key
      UNIQUE (organization_id, run_id, attempt_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'cp_hosted_attempt_exact_identity_key'
      AND conrelid = 'cp_hosted_attempt'::regclass) THEN
    ALTER TABLE cp_hosted_attempt ADD CONSTRAINT cp_hosted_attempt_exact_identity_key
      UNIQUE (organization_id, run_id, attempt_number, attempt_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'cp_publication_candidate_attempt_fk'
      AND conrelid = 'cp_publication_candidate'::regclass) THEN
    ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_attempt_fk
      FOREIGN KEY (organization_id, run_id, attempt_number, attempt_id)
      REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number, attempt_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'cp_publication_candidate_changed_files_check'
      AND conrelid = 'cp_publication_candidate'::regclass) THEN
    ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_changed_files_check
      CHECK (cardinality(changed_files) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'cp_publication_candidate_verification_check'
      AND conrelid = 'cp_publication_candidate'::regclass) THEN
    ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_verification_check
      CHECK (cardinality(verification_evidence_ids) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'cp_publication_candidate_base_revision_check'
      AND conrelid = 'cp_publication_candidate'::regclass) THEN
    ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_base_revision_check
      CHECK (frozen_base_revision ~ '^[a-f0-9]{40,64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'cp_publication_candidate_tree_digest_check'
      AND conrelid = 'cp_publication_candidate'::regclass) THEN
    ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_tree_digest_check
      CHECK (workspace_tree_digest ~ '^[a-f0-9]{40,64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'cp_publication_candidate_patch_digest_check'
      AND conrelid = 'cp_publication_candidate'::regclass) THEN
    ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_patch_digest_check
      CHECK (patch_digest ~ '^sha256:[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'cp_publication_candidate_policy_digest_check'
      AND conrelid = 'cp_publication_candidate'::regclass) THEN
    ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_policy_digest_check
      CHECK (publication_policy_digest ~ '^sha256:[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'cp_publication_candidate_content_free_check'
      AND conrelid = 'cp_publication_candidate'::regclass) THEN
    ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_content_free_check
      CHECK (jsonb_typeof(candidate) = 'object'
        AND NOT candidate ?| ARRAY[
          'baseToFinalBinaryDiff','limitations','workspacePath','logs','output','secret'
        ]);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS cp_publication_candidate_run_idx
  ON cp_publication_candidate(organization_id, run_id);

CREATE OR REPLACE FUNCTION cp_reject_publication_candidate_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'publication_candidate_immutable'; END $$;

DROP TRIGGER IF EXISTS cp_publication_candidate_immutable ON cp_publication_candidate;
CREATE TRIGGER cp_publication_candidate_immutable
BEFORE UPDATE OR DELETE ON cp_publication_candidate
FOR EACH ROW EXECUTE FUNCTION cp_reject_publication_candidate_mutation();
