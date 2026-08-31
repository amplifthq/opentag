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
  AND run.terminal_receipt->'assessment'->>'candidateId' = candidate.candidate_id
  AND run.terminal_receipt->'assessment'->>'state' = 'proposal_ready'
  AND run.terminal_receipt->'assessment'->>'accepted' = 'true'
  AND run.terminal_receipt->'assessment'->'reasonCodes' = '["proposal_ready"]'::jsonb;

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
