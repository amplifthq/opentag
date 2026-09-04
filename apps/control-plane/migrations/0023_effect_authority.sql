ALTER TABLE cp_project_target ADD COLUMN binding_generation integer;
UPDATE cp_project_target SET binding_generation = 1 WHERE binding_generation IS NULL;
ALTER TABLE cp_project_target
  ALTER COLUMN binding_generation SET NOT NULL,
  ADD CONSTRAINT cp_project_target_binding_generation_check
    CHECK (binding_generation > 0);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cp_publication_capability) THEN
    RAISE EXCEPTION 'effect_authority_cutover_reconciliation_required';
  END IF;
END $$;

DELETE FROM cp_slack_action_authority WHERE action_kind = 'publication';
ALTER TABLE cp_slack_action_authority
  DROP CONSTRAINT cp_slack_action_authority_kind_check,
  DROP CONSTRAINT cp_slack_action_authority_decisions_check,
  DROP CONSTRAINT cp_slack_action_authority_publication_shape_check;
ALTER TABLE cp_slack_action_authority
  RENAME COLUMN publication_approval TO effect_approval;
ALTER TABLE cp_slack_action_authority
  ADD CONSTRAINT cp_slack_action_authority_kind_check
    CHECK (action_kind IN ('status','cancel','approval','effect','bind','unbind')),
  ADD CONSTRAINT cp_slack_action_authority_decisions_check
    CHECK (cardinality(allowed_decisions)>0 AND allowed_decisions <@
      ARRAY['status','cancel','allow_once','allow_run','deny','effect_approve','bind','unbind']::text[]),
  ADD CONSTRAINT cp_slack_action_authority_effect_shape_check
    CHECK ((action_kind = 'effect') = (effect_approval IS NOT NULL));

CREATE TABLE cp_effect (
  organization_id text NOT NULL,
  effect_id text NOT NULL,
  idempotency_key text NOT NULL,
  effect_kind text NOT NULL CHECK (effect_kind = 'github.create_draft_pull_request'),
  request_id text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  runner_id text NOT NULL,
  runner_generation integer NOT NULL CHECK (runner_generation > 0),
  run_id text NOT NULL,
  run_attempt_id text NOT NULL,
  run_attempt_number integer NOT NULL CHECK (run_attempt_number > 0),
  fencing_token_digest text NOT NULL CHECK (fencing_token_digest ~ '^sha256:[a-f0-9]{64}$'),
  candidate_id text NOT NULL,
  candidate_digest text NOT NULL CHECK (candidate_digest ~ '^sha256:[a-f0-9]{64}$'),
  project_target_id text NOT NULL,
  target_binding_digest text NOT NULL CHECK (target_binding_digest ~ '^sha256:[a-f0-9]{64}$'),
  target_binding_generation integer NOT NULL CHECK (target_binding_generation > 0),
  target_digest text NOT NULL CHECK (target_digest ~ '^sha256:[a-f0-9]{64}$'),
  target jsonb NOT NULL,
  policy_snapshot_id text NOT NULL,
  policy_snapshot_digest text NOT NULL CHECK (policy_snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  approval_request_id text NOT NULL,
  approval_request_digest text NOT NULL CHECK (approval_request_digest ~ '^sha256:[a-f0-9]{64}$'),
  approval_expires_at timestamptz NOT NULL,
  approval_id text,
  approval_digest text CHECK (approval_digest IS NULL OR approval_digest ~ '^sha256:[a-f0-9]{64}$'),
  approval jsonb,
  state text NOT NULL CHECK (state IN (
    'requested','authorized','permit_issued','observing','outcome_unknown',
    'retry_eligible','succeeded','attention','cancelled_before_permit'
  )),
  current_attempt_number integer NOT NULL DEFAULT 0 CHECK (current_attempt_number >= 0),
  current_evidence_digest text CHECK (
    current_evidence_digest IS NULL OR current_evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  external_resource jsonb,
  reason_code text CHECK (
    reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  requested_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, effect_id),
  UNIQUE (organization_id, runner_id, idempotency_key),
  CONSTRAINT cp_effect_logical_key
    UNIQUE (organization_id, effect_kind, candidate_id),
  UNIQUE (organization_id, approval_request_id),
  UNIQUE (organization_id, approval_id),
  FOREIGN KEY (organization_id, runner_id)
    REFERENCES cp_runner(organization_id, runner_id),
  FOREIGN KEY (organization_id, run_id, run_attempt_number, run_attempt_id)
    REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number, attempt_id),
  FOREIGN KEY (organization_id, candidate_id)
    REFERENCES cp_publication_candidate(organization_id, candidate_id),
  FOREIGN KEY (organization_id, project_target_id)
    REFERENCES cp_project_target(organization_id, project_target_id),
  CONSTRAINT cp_effect_approval_shape_check CHECK (
    (approval_id IS NULL AND approval_digest IS NULL AND approval IS NULL)
    OR (approval_id IS NOT NULL AND approval_digest IS NOT NULL AND approval IS NOT NULL)
  ),
  CONSTRAINT cp_effect_projection_shape_check CHECK (
    (state = 'requested' AND current_attempt_number = 0
      AND approval_id IS NULL AND current_evidence_digest IS NULL
      AND external_resource IS NULL AND reason_code IS NULL)
    OR (state = 'authorized' AND current_attempt_number = 0
      AND approval_id IS NOT NULL AND current_evidence_digest IS NULL
      AND external_resource IS NULL AND reason_code IS NULL)
    OR (state = 'permit_issued' AND current_attempt_number > 0
      AND approval_id IS NOT NULL AND current_evidence_digest IS NULL
      AND external_resource IS NULL AND reason_code IS NULL)
    OR (state = 'observing' AND current_attempt_number > 0
      AND approval_id IS NOT NULL AND current_evidence_digest IS NOT NULL
      AND external_resource IS NOT NULL AND reason_code IS NULL)
    OR (state = 'outcome_unknown' AND current_attempt_number > 0
      AND approval_id IS NOT NULL AND current_evidence_digest IS NOT NULL
      AND reason_code IS NOT NULL)
    OR (state = 'retry_eligible' AND current_attempt_number > 0
      AND approval_id IS NOT NULL AND current_evidence_digest IS NOT NULL
      AND external_resource IS NULL AND reason_code = 'local.provider_io_not_begun')
    OR (state = 'succeeded' AND current_attempt_number > 0
      AND approval_id IS NOT NULL AND current_evidence_digest IS NOT NULL
      AND external_resource IS NOT NULL AND reason_code IS NULL)
    OR (state = 'attention' AND reason_code IS NOT NULL
      AND (current_attempt_number > 0
        OR (current_evidence_digest IS NULL AND external_resource IS NULL))
      AND (current_attempt_number = 0 OR approval_id IS NOT NULL)
      AND (external_resource IS NULL OR current_evidence_digest IS NOT NULL))
    OR (state = 'cancelled_before_permit' AND current_attempt_number = 0
      AND current_evidence_digest IS NULL AND external_resource IS NULL
      AND reason_code IS NOT NULL)
  )
);

CREATE INDEX cp_effect_dispatch_idx
  ON cp_effect(organization_id, runner_id, state, requested_at, effect_id);

CREATE TABLE cp_effect_attempt (
  organization_id text NOT NULL,
  permit_id text NOT NULL,
  effect_id text NOT NULL,
  effect_attempt_number integer NOT NULL CHECK (effect_attempt_number > 0),
  permit_kind text NOT NULL CHECK (permit_kind IN ('execute','reconcile')),
  original_execute_permit_id text,
  acquire_request_id text NOT NULL,
  acquire_journal_digest text NOT NULL CHECK (acquire_journal_digest ~ '^sha256:[a-f0-9]{64}$'),
  runner_id text NOT NULL,
  runner_generation integer NOT NULL CHECK (runner_generation > 0),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  target_digest text NOT NULL CHECK (target_digest ~ '^sha256:[a-f0-9]{64}$'),
  approval_digest text NOT NULL CHECK (approval_digest ~ '^sha256:[a-f0-9]{64}$'),
  permit_digest text NOT NULL CHECK (permit_digest ~ '^sha256:[a-f0-9]{64}$'),
  permit jsonb NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, permit_id),
  UNIQUE (organization_id, runner_id, acquire_request_id),
  UNIQUE (organization_id, effect_id, permit_id),
  UNIQUE (organization_id, effect_id, permit_id, effect_attempt_number),
  FOREIGN KEY (organization_id, effect_id)
    REFERENCES cp_effect(organization_id, effect_id),
  FOREIGN KEY (organization_id, effect_id, original_execute_permit_id)
    REFERENCES cp_effect_attempt(organization_id, effect_id, permit_id),
  CONSTRAINT cp_effect_attempt_permit_shape_check CHECK (
    (permit_kind = 'execute' AND original_execute_permit_id IS NULL)
    OR (permit_kind = 'reconcile' AND original_execute_permit_id IS NOT NULL)
  ),
  CONSTRAINT cp_effect_attempt_permit_window_check CHECK (
    expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes'
  )
);

CREATE UNIQUE INDEX cp_effect_execute_attempt_key
  ON cp_effect_attempt(organization_id, effect_id, effect_attempt_number)
  WHERE permit_kind = 'execute';

CREATE FUNCTION cp_guard_effect_reconciliation_origin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.permit_kind = 'reconcile' AND NOT EXISTS (
    SELECT 1 FROM cp_effect_attempt origin
    WHERE origin.organization_id=NEW.organization_id
      AND origin.effect_id=NEW.effect_id
      AND origin.permit_id=NEW.original_execute_permit_id
      AND origin.permit_kind='execute'
  ) THEN
    RAISE EXCEPTION 'effect_reconciliation_origin_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cp_effect_reconciliation_origin
BEFORE INSERT ON cp_effect_attempt
FOR EACH ROW EXECUTE FUNCTION cp_guard_effect_reconciliation_origin();

CREATE TABLE cp_effect_evidence (
  organization_id text NOT NULL,
  evidence_id text NOT NULL,
  effect_id text NOT NULL,
  permit_id text NOT NULL,
  effect_attempt_number integer NOT NULL CHECK (effect_attempt_number > 0),
  sequence integer NOT NULL CHECK (sequence > 0),
  predecessor_evidence_digest text CHECK (
    predecessor_evidence_digest IS NULL
    OR predecessor_evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  evidence jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, evidence_id),
  UNIQUE (organization_id, evidence_digest),
  UNIQUE (organization_id, effect_id, sequence),
  FOREIGN KEY (organization_id, effect_id)
    REFERENCES cp_effect(organization_id, effect_id),
  FOREIGN KEY (organization_id, effect_id, permit_id, effect_attempt_number)
    REFERENCES cp_effect_attempt(organization_id, effect_id, permit_id, effect_attempt_number)
);

CREATE INDEX cp_effect_evidence_chain_idx
  ON cp_effect_evidence(organization_id, effect_id, sequence DESC);

CREATE FUNCTION cp_reject_effect_authority_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'effect_authority_immutable'; END $$;

CREATE TRIGGER cp_effect_attempt_immutable
BEFORE UPDATE OR DELETE ON cp_effect_attempt
FOR EACH ROW EXECUTE FUNCTION cp_reject_effect_authority_mutation();

CREATE TRIGGER cp_effect_evidence_immutable
BEFORE UPDATE OR DELETE ON cp_effect_evidence
FOR EACH ROW EXECUTE FUNCTION cp_reject_effect_authority_mutation();

CREATE FUNCTION cp_reject_effect_request_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.effect_id,NEW.idempotency_key,NEW.effect_kind,NEW.request_id,
      NEW.request_digest,NEW.runner_id,NEW.runner_generation,
      NEW.run_id,NEW.run_attempt_id,NEW.run_attempt_number,NEW.fencing_token_digest,
      NEW.candidate_id,NEW.candidate_digest,NEW.project_target_id,
      NEW.target_binding_digest,NEW.target_binding_generation,NEW.target_digest,
      NEW.target,NEW.policy_snapshot_id,NEW.policy_snapshot_digest,
      NEW.approval_request_id,NEW.approval_request_digest,
      NEW.approval_expires_at,NEW.requested_at,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.effect_id,OLD.idempotency_key,OLD.effect_kind,OLD.request_id,
      OLD.request_digest,OLD.runner_id,OLD.runner_generation,
      OLD.run_id,OLD.run_attempt_id,OLD.run_attempt_number,OLD.fencing_token_digest,
      OLD.candidate_id,OLD.candidate_digest,OLD.project_target_id,
      OLD.target_binding_digest,OLD.target_binding_generation,OLD.target_digest,
      OLD.target,OLD.policy_snapshot_id,OLD.policy_snapshot_digest,
      OLD.approval_request_id,OLD.approval_request_digest,
      OLD.approval_expires_at,OLD.requested_at,OLD.created_at) THEN
    RAISE EXCEPTION 'effect_request_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cp_effect_request_immutable
BEFORE UPDATE ON cp_effect
FOR EACH ROW EXECUTE FUNCTION cp_reject_effect_request_mutation();

CREATE FUNCTION cp_reject_effect_approval_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approval_id IS NOT NULL AND
    ROW(NEW.approval_id,NEW.approval_digest,NEW.approval)
      IS DISTINCT FROM ROW(OLD.approval_id,OLD.approval_digest,OLD.approval) THEN
    RAISE EXCEPTION 'effect_approval_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cp_effect_approval_immutable
BEFORE UPDATE ON cp_effect
FOR EACH ROW EXECUTE FUNCTION cp_reject_effect_approval_rewrite();

CREATE FUNCTION cp_guard_effect_state_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('succeeded','cancelled_before_permit') AND
    ROW(NEW.state,NEW.current_attempt_number,NEW.current_evidence_digest,
      NEW.external_resource,NEW.reason_code)
      IS DISTINCT FROM
      ROW(OLD.state,OLD.current_attempt_number,OLD.current_evidence_digest,
        OLD.external_resource,OLD.reason_code) THEN
    RAISE EXCEPTION 'effect_terminal_projection_immutable';
  END IF;
  IF NEW.current_attempt_number < OLD.current_attempt_number THEN
    RAISE EXCEPTION 'effect_attempt_regression';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state = 'requested' AND NEW.state IN ('authorized','attention','cancelled_before_permit'))
    OR (OLD.state = 'authorized' AND NEW.state IN ('permit_issued','attention','cancelled_before_permit'))
    OR (OLD.state = 'permit_issued' AND NEW.state IN (
      'observing','outcome_unknown','retry_eligible','succeeded','attention'))
    OR (OLD.state = 'observing' AND NEW.state IN (
      'outcome_unknown','succeeded','attention'))
    OR (OLD.state = 'outcome_unknown' AND NEW.state IN (
      'observing','succeeded','attention'))
    OR (OLD.state = 'retry_eligible' AND NEW.state IN ('permit_issued','attention'))
    OR (OLD.state = 'attention' AND NEW.state IN (
      'observing','outcome_unknown','succeeded'))
  ) THEN
    RAISE EXCEPTION 'effect_state_transition_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cp_effect_state_transition
BEFORE UPDATE ON cp_effect
FOR EACH ROW EXECUTE FUNCTION cp_guard_effect_state_transition();

CREATE TRIGGER cp_effect_delete_immutable
BEFORE DELETE ON cp_effect
FOR EACH ROW EXECUTE FUNCTION cp_reject_effect_authority_mutation();

CREATE FUNCTION cp_project_effect_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
    OR ROW(NEW.state,NEW.current_attempt_number,NEW.current_evidence_digest,
      NEW.external_resource,NEW.reason_code)
      IS DISTINCT FROM
      ROW(OLD.state,OLD.current_attempt_number,OLD.current_evidence_digest,
        OLD.external_resource,OLD.reason_code) THEN
    UPDATE cp_hosted_run
      SET projection_revision = projection_revision + 1,
          updated_at = GREATEST(updated_at, NEW.updated_at)
      WHERE organization_id = NEW.organization_id AND run_id = NEW.run_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cp_effect_projection
AFTER INSERT OR UPDATE OF state,current_attempt_number,current_evidence_digest,
  external_resource,reason_code ON cp_effect
FOR EACH ROW EXECUTE FUNCTION cp_project_effect_change();

CREATE FUNCTION cp_cancel_unpermitted_effects_after_work_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.terminal_kind IS NULL AND NEW.terminal_kind IS NOT NULL THEN
    UPDATE cp_effect SET state='cancelled_before_permit',
      reason_code='work.cancelled_before_permit',updated_at=NEW.updated_at
    WHERE organization_id=NEW.organization_id AND run_id=NEW.run_id
      AND current_attempt_number=0 AND state IN ('requested','authorized');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cp_hosted_run_cancel_unpermitted_effects
AFTER UPDATE OF terminal_kind ON cp_hosted_run
FOR EACH ROW EXECUTE FUNCTION cp_cancel_unpermitted_effects_after_work_terminal();

DROP TABLE cp_publication_completion;
DROP TABLE cp_publication_receipt;
DROP TABLE cp_publication_reconciliation;
DROP TABLE cp_publication_begin;
DROP TABLE cp_publication_capability;
DROP TABLE cp_publication_intent;
DROP TABLE cp_publication_branch_ownership;
DROP FUNCTION cp_reject_publication_authority_mutation();
