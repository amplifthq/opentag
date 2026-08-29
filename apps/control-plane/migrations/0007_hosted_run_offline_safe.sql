ALTER TABLE cp_hosted_run DROP CONSTRAINT cp_hosted_run_state_check;
ALTER TABLE cp_hosted_run DROP CONSTRAINT cp_hosted_run_terminal_kind_check;

UPDATE cp_hosted_run SET state = CASE state
  WHEN 'pending' THEN 'queued'
  WHEN 'claimed' THEN 'assigned'
  WHEN 'completed' THEN 'succeeded'
  WHEN 'rejected' THEN 'failed'
  ELSE state
END;
UPDATE cp_hosted_run SET terminal_kind = CASE terminal_kind
  WHEN 'completed' THEN 'succeeded'
  WHEN 'rejected' THEN 'failed'
  ELSE terminal_kind
END;

ALTER TABLE cp_hosted_run
  ADD COLUMN source_version_ref text,
  ADD COLUMN source_content_ids text[],
  ADD COLUMN source_context_digest text,
  ADD COLUMN queue_claim_deadline timestamptz,
  ADD COLUMN permission_ceiling_digest text,
  ADD COLUMN publication_mode text,
  ADD COLUMN publication_policy_digest text,
  ADD COLUMN completion_mode text,
  ADD COLUMN completion_contract_digest text,
  ADD COLUMN outcome_state text,
  ADD COLUMN reconciliation_identity text,
  ADD COLUMN terminal_reason text;

UPDATE cp_hosted_run SET
  source_version_ref = COALESCE(source_version_ref, 'legacy:' || source_identity_digest),
  source_content_ids = COALESCE(source_content_ids, ARRAY['legacy:' || run_id]),
  source_context_digest = COALESCE(source_context_digest, admission_digest),
  queue_claim_deadline = COALESCE(queue_claim_deadline, created_at + interval '1 microsecond'),
  permission_ceiling_digest = COALESCE(permission_ceiling_digest, admission_digest),
  publication_mode = COALESCE(publication_mode, 'proposal_only'),
  publication_policy_digest = COALESCE(publication_policy_digest, admission_digest),
  completion_mode = COALESCE(completion_mode, 'proposal_ready'),
  completion_contract_digest = COALESCE(completion_contract_digest, admission_digest);

ALTER TABLE cp_hosted_run
  ALTER COLUMN source_version_ref SET NOT NULL,
  ALTER COLUMN source_content_ids SET NOT NULL,
  ALTER COLUMN source_context_digest SET NOT NULL,
  ALTER COLUMN queue_claim_deadline SET NOT NULL,
  ALTER COLUMN permission_ceiling_digest SET NOT NULL,
  ALTER COLUMN publication_mode SET NOT NULL,
  ALTER COLUMN publication_policy_digest SET NOT NULL,
  ALTER COLUMN completion_mode SET NOT NULL,
  ALTER COLUMN completion_contract_digest SET NOT NULL;

ALTER TABLE cp_hosted_run
  ADD CONSTRAINT cp_hosted_run_state_check CHECK (state IN (
    'queued','assigned','running','needs_approval','succeeded','failed',
    'cancelled','interrupted','timed_out'
  )),
  ADD CONSTRAINT cp_hosted_run_terminal_kind_check CHECK (terminal_kind IN (
    'succeeded','failed','cancelled','interrupted','timed_out'
  )),
  ADD CONSTRAINT cp_hosted_run_source_content_ids_check
    CHECK (cardinality(source_content_ids) > 0),
  ADD CONSTRAINT cp_hosted_run_queue_claim_deadline_check
    CHECK (isfinite(queue_claim_deadline) AND queue_claim_deadline > created_at),
  ADD CONSTRAINT cp_hosted_run_publication_mode_check
    CHECK (publication_mode IN ('proposal_only','pull_request')),
  ADD CONSTRAINT cp_hosted_run_completion_mode_check
    CHECK (completion_mode IN ('proposal_ready','pull_request_ready')),
  ADD CONSTRAINT cp_hosted_run_publication_completion_check CHECK (
    (publication_mode = 'proposal_only' AND completion_mode = 'proposal_ready') OR
    (publication_mode = 'pull_request' AND completion_mode = 'pull_request_ready')
  ),
  ADD CONSTRAINT cp_hosted_run_outcome_state_check
    CHECK (outcome_state IS NULL OR outcome_state = 'outcome_unknown');

CREATE INDEX cp_hosted_run_source_version_idx
  ON cp_hosted_run(organization_id, source_version_ref, state);
CREATE INDEX cp_hosted_run_queue_deadline_idx
  ON cp_hosted_run(queue_claim_deadline, organization_id)
  WHERE state = 'queued';

CREATE TABLE cp_source_content_invalidation_receipt (
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  command_id text NOT NULL,
  request_digest text NOT NULL,
  source_version_ref text NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, command_id),
  CHECK (receipt->>'reason' = 'source_content_deleted')
);

CREATE UNIQUE INDEX cp_source_content_grant_attempt_key
  ON cp_source_content_read_grant(organization_id, run_id, attempt_id);

ALTER TABLE cp_source_content_read_grant ADD COLUMN key_version text;
UPDATE cp_source_content_read_grant SET key_version = 'legacy' WHERE key_version IS NULL;
ALTER TABLE cp_source_content_read_grant ALTER COLUMN key_version SET NOT NULL;

ALTER TABLE cp_hosted_attempt DROP CONSTRAINT cp_hosted_attempt_state_check;
ALTER TABLE cp_hosted_attempt ADD CONSTRAINT cp_hosted_attempt_state_check
  CHECK (state IN ('claimed','running','needs_approval','succeeded','failed',
    'rejected','cancelled','interrupted','timed_out','expired'));
ALTER TABLE cp_hosted_attempt ADD COLUMN material_start_state text
  NOT NULL DEFAULT 'open' CHECK (material_start_state IN
    ('open','proven_not_started','started_or_ambiguous'));
ALTER TABLE cp_hosted_attempt
  ADD COLUMN blocked_permission_request_id text,
  ADD COLUMN blocked_action_descriptor_digest text,
  ADD COLUMN blocked_policy_snapshot_digest text,
  ADD CONSTRAINT cp_hosted_attempt_blocked_permission_check CHECK (
    (state = 'needs_approval' AND blocked_permission_request_id IS NOT NULL
      AND blocked_action_descriptor_digest IS NOT NULL
      AND blocked_policy_snapshot_digest IS NOT NULL)
    OR (state <> 'needs_approval' AND blocked_permission_request_id IS NULL
      AND blocked_action_descriptor_digest IS NULL
      AND blocked_policy_snapshot_digest IS NULL)
  );

CREATE TABLE IF NOT EXISTS cp_material_action_non_start_proof (
  organization_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  fencing_token_digest text NOT NULL,
  proof_id text NOT NULL,
  proof_digest text NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, run_id, attempt_id),
  UNIQUE (organization_id, proof_id),
  FOREIGN KEY (organization_id, run_id, attempt_number)
    REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS cp_material_action_begin_intent (
  organization_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  attempt_number integer NOT NULL,
  fencing_token_digest text NOT NULL,
  action_id text NOT NULL,
  action_descriptor text NOT NULL,
  action_descriptor_digest text NOT NULL,
  target_fingerprint text NOT NULL,
  policy_snapshot_digest text NOT NULL,
  authority_kind text NOT NULL CHECK (authority_kind IN
    ('permission_resolution','admission_preauthorization')),
  authority_reference_id text NOT NULL,
  authority_reference_digest text NOT NULL,
  idempotency_key text NOT NULL,
  begun_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, run_id, attempt_id, action_id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, run_id, attempt_number)
    REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number)
);

UPDATE cp_hosted_attempt attempt SET material_start_state = CASE
  WHEN EXISTS (SELECT 1 FROM cp_material_action_receipt receipt
    WHERE receipt.organization_id = attempt.organization_id
      AND receipt.run_id = attempt.run_id AND receipt.attempt_id = attempt.attempt_id)
    OR EXISTS (SELECT 1 FROM cp_material_action_begin_intent begin_intent
    WHERE begin_intent.organization_id = attempt.organization_id
      AND begin_intent.run_id = attempt.run_id
      AND begin_intent.attempt_id = attempt.attempt_id)
    THEN 'started_or_ambiguous'
  WHEN EXISTS (SELECT 1 FROM cp_material_action_non_start_proof proof
    WHERE proof.organization_id = attempt.organization_id
      AND proof.run_id = attempt.run_id AND proof.attempt_id = attempt.attempt_id
      AND proof.attempt_number = attempt.attempt_number
      AND proof.fencing_token_digest = attempt.fencing_token_digest)
    THEN 'proven_not_started'
  ELSE 'open'
END;

ALTER TABLE cp_permission_request DROP CONSTRAINT cp_permission_request_state_check;
ALTER TABLE cp_permission_request ADD CONSTRAINT cp_permission_request_state_check
  CHECK (state IN ('waiting','authorized','denied','revoked'));

UPDATE cp_hosted_attempt attempt SET state = 'expired',
  lease_expires_at = LEAST(attempt.lease_expires_at, proof.recorded_at),
  blocked_permission_request_id = NULL,
  blocked_action_descriptor_digest = NULL,
  blocked_policy_snapshot_digest = NULL,
  updated_at = proof.recorded_at
 FROM cp_material_action_non_start_proof proof
 WHERE attempt.organization_id = proof.organization_id
   AND attempt.run_id = proof.run_id AND attempt.attempt_id = proof.attempt_id
   AND attempt.attempt_number = proof.attempt_number
   AND attempt.fencing_token_digest = proof.fencing_token_digest
   AND attempt.material_start_state = 'proven_not_started';
UPDATE cp_hosted_run run SET state = 'assigned', updated_at = attempt.updated_at
 FROM cp_hosted_attempt attempt
 WHERE run.organization_id = attempt.organization_id AND run.run_id = attempt.run_id
   AND run.current_attempt_number = attempt.attempt_number
   AND attempt.material_start_state = 'proven_not_started'
   AND run.terminal_kind IS NULL;
UPDATE cp_source_content_read_grant grant_record
 SET revoked_at = COALESCE(grant_record.revoked_at, attempt.updated_at)
 FROM cp_hosted_attempt attempt
 WHERE grant_record.organization_id = attempt.organization_id
   AND grant_record.run_id = attempt.run_id
   AND grant_record.attempt_id = attempt.attempt_id
   AND attempt.material_start_state = 'proven_not_started'
   AND grant_record.consumed_at IS NULL;
UPDATE cp_permission_request permission SET state = 'revoked',
  updated_at = attempt.updated_at
 FROM cp_hosted_attempt attempt
 WHERE permission.organization_id = attempt.organization_id
   AND permission.run_id = attempt.run_id
   AND permission.attempt_id = attempt.attempt_id
   AND attempt.material_start_state = 'proven_not_started'
   AND permission.state = 'waiting';

CREATE FUNCTION cp_material_non_start_proof_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE current_state text;
BEGIN
  SELECT material_start_state INTO current_state FROM cp_hosted_attempt
   WHERE organization_id = NEW.organization_id AND run_id = NEW.run_id
     AND attempt_id = NEW.attempt_id AND attempt_number = NEW.attempt_number
     AND fencing_token_digest = NEW.fencing_token_digest FOR UPDATE;
  IF current_state IS DISTINCT FROM 'open'
    OR EXISTS (SELECT 1 FROM cp_material_action_receipt receipt
      WHERE receipt.organization_id = NEW.organization_id
        AND receipt.run_id = NEW.run_id AND receipt.attempt_id = NEW.attempt_id)
    OR EXISTS (SELECT 1 FROM cp_material_action_begin_intent begin_intent
      WHERE begin_intent.organization_id = NEW.organization_id
        AND begin_intent.run_id = NEW.run_id AND begin_intent.attempt_id = NEW.attempt_id)
  THEN RAISE EXCEPTION 'material_non_start_proof_conflict';
  END IF;
  UPDATE cp_hosted_attempt SET material_start_state = 'proven_not_started',
    state = 'expired', lease_expires_at = LEAST(lease_expires_at, NEW.recorded_at),
    blocked_permission_request_id = NULL, blocked_action_descriptor_digest = NULL,
    blocked_policy_snapshot_digest = NULL, updated_at = NEW.recorded_at
   WHERE organization_id = NEW.organization_id AND run_id = NEW.run_id
     AND attempt_id = NEW.attempt_id;
  UPDATE cp_hosted_run SET state = 'assigned', updated_at = NEW.recorded_at
   WHERE organization_id = NEW.organization_id AND run_id = NEW.run_id
     AND terminal_kind IS NULL;
  UPDATE cp_source_content_read_grant SET revoked_at = COALESCE(revoked_at, NEW.recorded_at)
   WHERE organization_id = NEW.organization_id AND run_id = NEW.run_id
     AND attempt_id = NEW.attempt_id AND consumed_at IS NULL;
  UPDATE cp_permission_request SET state = 'revoked', updated_at = NEW.recorded_at
   WHERE organization_id = NEW.organization_id AND run_id = NEW.run_id
     AND attempt_id = NEW.attempt_id AND state = 'waiting';
  RETURN NEW;
END;
$$;
CREATE TRIGGER cp_material_non_start_proof_guard
BEFORE INSERT ON cp_material_action_non_start_proof
FOR EACH ROW EXECUTE FUNCTION cp_material_non_start_proof_guard();

CREATE TABLE cp_source_resolution_admission (
  idempotency_key text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  request_digest text NOT NULL,
  run_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','decided')),
  resolution jsonb,
  created_at timestamptz NOT NULL,
  CHECK ((state = 'pending' AND resolution IS NULL) OR
    (state = 'decided' AND resolution->>'kind' IN ('accepted','waiting_for_runner')))
);

ALTER TABLE cp_hosted_claim ADD COLUMN claim_version integer NOT NULL DEFAULT 1
  CHECK (claim_version IN (1, 2));

UPDATE cp_hosted_attempt attempt SET state = 'interrupted',
  material_start_state = 'started_or_ambiguous',
  lease_expires_at = LEAST(attempt.lease_expires_at, clock_timestamp()),
  blocked_permission_request_id = NULL,
  blocked_action_descriptor_digest = NULL,
  blocked_policy_snapshot_digest = NULL,
  updated_at = clock_timestamp()
 WHERE EXISTS (SELECT 1 FROM cp_hosted_claim legacy
   WHERE legacy.organization_id = attempt.organization_id
     AND legacy.run_id = attempt.run_id AND legacy.claim_version = 1
     AND legacy.claim->'attempt'->>'id' = attempt.attempt_id
     AND CASE WHEN legacy.claim->'attempt'->>'number' ~ '^[1-9][0-9]*$'
       THEN (legacy.claim->'attempt'->>'number')::integer = attempt.attempt_number
       ELSE false END);
UPDATE cp_source_content_read_grant grant_record
 SET revoked_at = COALESCE(revoked_at, clock_timestamp())
 WHERE EXISTS (SELECT 1 FROM cp_hosted_claim legacy
   WHERE legacy.organization_id = grant_record.organization_id
     AND legacy.run_id = grant_record.run_id AND legacy.claim_version = 1
     AND legacy.claim->'attempt'->>'id' = grant_record.attempt_id);
UPDATE cp_permission_request permission SET state = 'revoked',
  updated_at = clock_timestamp()
 WHERE permission.state = 'waiting' AND EXISTS (
   SELECT 1 FROM cp_hosted_claim legacy
   WHERE legacy.organization_id = permission.organization_id
     AND legacy.run_id = permission.run_id AND legacy.claim_version = 1
     AND legacy.claim->'attempt'->>'id' = permission.attempt_id
     AND CASE WHEN legacy.claim->'attempt'->>'number' ~ '^[1-9][0-9]*$'
       THEN (legacy.claim->'attempt'->>'number')::integer = permission.attempt_number
       ELSE false END);
UPDATE cp_hosted_run run SET state = 'interrupted', terminal_kind = 'interrupted',
  terminal_reason = 'legacy_claim_authority_unrecoverable',
  outcome_state = 'outcome_unknown',
  reconciliation_identity = run.organization_id || ':' || run.run_id || ':' ||
    (SELECT legacy.operation_id FROM cp_hosted_claim legacy
     WHERE legacy.organization_id = run.organization_id AND legacy.run_id = run.run_id
       AND legacy.claim_version = 1 ORDER BY legacy.operation_id LIMIT 1) || ':legacy_claim',
  terminal_receipt = jsonb_build_object('kind','legacy_claim_interrupted',
    'outcome','outcome_unknown','source','migration'), updated_at = clock_timestamp()
 WHERE run.terminal_kind IS NULL AND EXISTS (SELECT 1 FROM cp_hosted_claim legacy
   WHERE legacy.organization_id = run.organization_id AND legacy.run_id = run.run_id
     AND legacy.claim_version = 1
     AND (CASE WHEN legacy.claim->'attempt'->>'number' ~ '^[1-9][0-9]*$'
       THEN run.current_attempt_number <= (legacy.claim->'attempt'->>'number')::integer
       ELSE true END));

CREATE FUNCTION cp_hosted_run_frozen_admission_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.admission_id, NEW.admission_operation_id, NEW.admission_digest,
      NEW.source_identity_digest, NEW.runner_id, NEW.executor_id,
      NEW.source_version_ref, NEW.source_content_ids, NEW.source_context_digest,
      NEW.queue_claim_deadline, NEW.permission_ceiling_digest,
      NEW.publication_mode, NEW.publication_policy_digest,
      NEW.completion_mode, NEW.completion_contract_digest,
      NEW.hosted_admission, NEW.admission_policy_snapshot)
    IS DISTINCT FROM
    ROW(OLD.admission_id, OLD.admission_operation_id, OLD.admission_digest,
      OLD.source_identity_digest, OLD.runner_id, OLD.executor_id,
      OLD.source_version_ref, OLD.source_content_ids, OLD.source_context_digest,
      OLD.queue_claim_deadline, OLD.permission_ceiling_digest,
      OLD.publication_mode, OLD.publication_policy_digest,
      OLD.completion_mode, OLD.completion_contract_digest,
      OLD.hosted_admission, OLD.admission_policy_snapshot) THEN
    RAISE EXCEPTION 'hosted_run_admission_frozen';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cp_hosted_run_frozen_admission_guard
BEFORE UPDATE ON cp_hosted_run
FOR EACH ROW EXECUTE FUNCTION cp_hosted_run_frozen_admission_guard();
