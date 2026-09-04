-- OpenTag Control Plane fresh schema baseline.
SET LOCAL check_function_bodies = false;



CREATE FUNCTION cp_cancel_unpermitted_effects_after_work_terminal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.terminal_kind IS NULL AND NEW.terminal_kind IS NOT NULL THEN
    UPDATE cp_effect SET state='cancelled_before_permit',
      reason_code='work.cancelled_before_permit',updated_at=NEW.updated_at
    WHERE organization_id=NEW.organization_id AND run_id=NEW.run_id
      AND current_attempt_number=0 AND state IN ('requested','authorized');
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION cp_delivery_projection_after() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE current_projection integer; event_job_id text; deferred_revision integer; event_sequence integer; event_payload jsonb;
BEGIN
  IF NEW.run_id IS NULL OR NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
  SELECT projection_revision INTO current_projection FROM cp_hosted_run
    WHERE organization_id=NEW.organization_id AND run_id=NEW.run_id;
  IF current_projection IS NULL THEN RETURN NEW; END IF;
  IF NEW.projection_purpose='anchor_update' THEN RETURN NEW; END IF;
  IF NEW.projection_purpose='anchor_create' THEN
    IF NEW.state='accepted' THEN
      WITH candidate AS (SELECT projection_revision FROM cp_projection_deferred_revision
        WHERE organization_id=NEW.organization_id AND run_id=NEW.run_id AND state='pending'
          AND anchor_intent_id=NEW.intent_id ORDER BY projection_revision DESC LIMIT 1 FOR UPDATE), woken AS (
        UPDATE cp_projection_deferred_revision deferred SET state='woken',woken_at=clock_timestamp()
        FROM candidate WHERE deferred.organization_id=NEW.organization_id AND deferred.run_id=NEW.run_id
          AND deferred.projection_revision=candidate.projection_revision RETURNING deferred.projection_revision)
      SELECT projection_revision INTO deferred_revision FROM woken;
      IF deferred_revision IS NOT NULL THEN
        event_job_id:='team-relay-anchor-wake:'||NEW.organization_id||':'||NEW.run_id||':'||deferred_revision;
        PERFORM cp_insert_team_relay_v2_job(event_job_id,NEW.organization_id,jsonb_build_object(
          'organizationId',NEW.organization_id,'runId',NEW.run_id,'projectionRevision',deferred_revision));
      END IF;
    END IF; RETURN NEW;
  END IF;
  IF NEW.state NOT IN ('accepted','rejected','outcome_unknown','attention') THEN RETURN NEW; END IF;
  INSERT INTO cp_projection_event_cursor(organization_id,run_id,current_sequence)
    VALUES(NEW.organization_id,NEW.run_id,1)
    ON CONFLICT(organization_id,run_id) DO UPDATE
      SET current_sequence=cp_projection_event_cursor.current_sequence+1
    RETURNING current_sequence INTO event_sequence;
  INSERT INTO cp_projection_delivery_watermark(organization_id,run_id,intent_id,delivery_state,
    delivery_revision,projection_revision,event_sequence,created_at)
  VALUES(NEW.organization_id,NEW.run_id,NEW.intent_id,NEW.state,NEW.revision,current_projection,
    event_sequence,clock_timestamp());
  event_job_id:='team-relay-delivery:'||NEW.organization_id||':'||NEW.run_id||':'||event_sequence;
  event_payload:=jsonb_build_object('organizationId',NEW.organization_id,'runId',NEW.run_id,
    'projectionRevision',current_projection,'deliveryIntentId',NEW.intent_id,
    'deliveryRevision',NEW.revision,'eventSequence',event_sequence,'deliveryState',NEW.state);
  PERFORM cp_insert_team_relay_v2_job(event_job_id,NEW.organization_id,event_payload);
  RETURN NEW;
END $$;

CREATE FUNCTION cp_enqueue_team_relay_projection(p_org text, p_run text, p_revision integer) RETURNS void
    LANGUAGE plpgsql
    AS $$ BEGIN
  PERFORM cp_insert_team_relay_v2_job('team-relay:'||p_org||':'||p_run||':'||p_revision,p_org,
    jsonb_build_object('organizationId',p_org,'runId',p_run,'projectionRevision',p_revision));
END $$;

CREATE FUNCTION cp_guard_effect_reconciliation_origin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION cp_guard_effect_state_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION cp_hosted_run_frozen_admission_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION cp_hosted_run_projection_after() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
  PERFORM cp_enqueue_team_relay_projection(NEW.organization_id,NEW.run_id,NEW.projection_revision); RETURN NEW;
END $$;

CREATE FUNCTION cp_hosted_run_projection_before() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
  IF TG_OP='UPDATE' AND NEW.projection_revision=OLD.projection_revision
    AND (to_jsonb(NEW)-'projection_revision') IS DISTINCT FROM (to_jsonb(OLD)-'projection_revision') THEN
    NEW.projection_revision:=OLD.projection_revision+1;
  END IF; RETURN NEW;
END $$;

CREATE FUNCTION cp_hosted_run_source_content_terminal_after() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.terminal_kind IS NULL AND NEW.terminal_kind IS NOT NULL THEN
    UPDATE cp_source_content content
    SET terminal_at=COALESCE(content.terminal_at,clock_timestamp())
    WHERE content.organization_id=NEW.organization_id
      AND content.content_id=ANY(NEW.source_content_ids);
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION cp_insert_team_relay_v2_job(p_job text, p_org text, p_payload jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  expected_digest text;
  existing cp_job%ROWTYPE;
BEGIN
  expected_digest := md5(p_job || ':' || p_payload::text);
  INSERT INTO cp_job(
    job_id, organization_id, job_kind, payload, request_digest, state,
    available_at, attempt_count, max_attempts, created_at, updated_at
  ) VALUES (
    p_job, p_org, 'team-relay.project.v2', p_payload, expected_digest,
    'pending', clock_timestamp(), 0, 20, clock_timestamp(), clock_timestamp()
  ) ON CONFLICT(job_id) DO NOTHING;
  IF FOUND THEN RETURN; END IF;

  SELECT * INTO existing FROM cp_job WHERE job_id = p_job FOR UPDATE;
  IF existing.organization_id IS DISTINCT FROM p_org
    OR existing.job_kind <> 'team-relay.project.v2'
    OR existing.payload <> p_payload
    OR existing.request_digest <> expected_digest THEN
    RAISE EXCEPTION 'projection_v2_job_identity_conflict';
  END IF;

  IF existing.state NOT IN ('pending', 'claimed', 'succeeded', 'failed')
    OR existing.max_attempts <= 0
    OR existing.attempt_count < 0
    OR (
      existing.state = 'pending'
      AND (
        existing.attempt_count >= existing.max_attempts
        OR existing.lease_owner IS NOT NULL
        OR existing.lease_token IS NOT NULL
        OR existing.lease_expires_at IS NOT NULL
        OR existing.settlement_lease_token IS NOT NULL
        OR existing.settlement_outcome IS NOT NULL
        OR existing.settled_at IS NOT NULL
        OR (existing.attempt_count = 0 AND existing.last_error_code IS NOT NULL)
        OR (
          existing.attempt_count > 0
          AND (
            existing.last_error_code IS NULL
            OR existing.available_at < existing.updated_at
          )
        )
      )
    )
    OR (
      existing.state = 'claimed'
      AND (
        existing.attempt_count = 0
        OR existing.attempt_count > existing.max_attempts
        OR existing.lease_owner IS NULL
        OR existing.lease_token IS NULL
        OR existing.lease_expires_at IS NULL
        OR existing.settlement_lease_token IS NOT NULL
        OR existing.settlement_outcome IS NOT NULL
        OR existing.settled_at IS NOT NULL
      )
    )
    OR (
      existing.state = 'succeeded'
      AND (
        existing.attempt_count = 0
        OR existing.attempt_count > existing.max_attempts
        OR existing.lease_owner IS NOT NULL
        OR existing.lease_token IS NOT NULL
        OR existing.lease_expires_at IS NOT NULL
        OR existing.last_error_code IS NOT NULL
        OR existing.settlement_lease_token IS NULL
        OR existing.settlement_lease_token = ''
        OR existing.settlement_outcome IS NULL
        OR existing.settled_at IS NULL
        OR jsonb_typeof(existing.settlement_outcome) <> 'object'
        OR existing.settlement_outcome ? 'errorCode'
      )
    )
    OR (
      existing.state = 'failed'
      AND (
        existing.attempt_count = 0
        OR existing.attempt_count > existing.max_attempts
        OR existing.lease_owner IS NOT NULL
        OR existing.lease_token IS NOT NULL
        OR existing.lease_expires_at IS NOT NULL
        OR existing.last_error_code IS NULL
        OR existing.settlement_lease_token IS NULL
        OR existing.settlement_lease_token = ''
        OR existing.settlement_outcome IS NULL
        OR existing.settled_at IS NULL
        OR jsonb_typeof(existing.settlement_outcome) <> 'object'
        OR existing.settlement_outcome->>'errorCode'
          IS DISTINCT FROM existing.last_error_code
      )
    ) THEN
    RAISE EXCEPTION 'projection_v2_job_state_conflict';
  END IF;
END;
$$;

CREATE FUNCTION cp_project_effect_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION cp_provider_delivery_delete_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'provider_delivery_immutable_delete'; END $$;

CREATE FUNCTION cp_provider_delivery_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.state IN ('accepted','rejected','outcome_unknown','attention','superseded')
     OR NEW.revision <> OLD.revision + 1
     OR NEW.intent_id <> OLD.intent_id OR NEW.organization_id <> OLD.organization_id OR NEW.journal_intent_digest <> OLD.journal_intent_digest
     OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.status_message_id IS DISTINCT FROM OLD.status_message_id
     OR NEW.intent <> OLD.intent OR NEW.payload <> OLD.payload OR NEW.payload_digest <> OLD.payload_digest
     OR NEW.presentation_phase <> OLD.presentation_phase OR NEW.current_truth_key <> OLD.current_truth_key
     OR NEW.scope_kind <> OLD.scope_kind OR NEW.scope_id <> OLD.scope_id OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.provider_id <> OLD.provider_id OR NEW.provider_instance_id <> OLD.provider_instance_id
     OR NEW.provider_binding_digest <> OLD.provider_binding_digest
     OR NEW.provider_config_generation <> OLD.provider_config_generation
     OR NEW.provider_config_generation_digest <> OLD.provider_config_generation_digest
     OR NEW.runtime_owner_id <> OLD.runtime_owner_id OR NEW.runtime_generation <> OLD.runtime_generation
     OR NEW.schema_generation <> OLD.schema_generation OR NEW.authority_snapshot_digest <> OLD.authority_snapshot_digest
     OR (OLD.installation_begin_marker_id IS NOT NULL AND NEW.installation_begin_marker_id IS DISTINCT FROM OLD.installation_begin_marker_id)
     OR (OLD.installation_begin_marker_digest IS NOT NULL AND NEW.installation_begin_marker_digest IS DISTINCT FROM OLD.installation_begin_marker_digest)
     OR (OLD.scope_begin_marker_id IS NOT NULL AND NEW.scope_begin_marker_id IS DISTINCT FROM OLD.scope_begin_marker_id)
     OR (OLD.scope_begin_marker_digest IS NOT NULL AND NEW.scope_begin_marker_digest IS DISTINCT FROM OLD.scope_begin_marker_digest)
     OR (OLD.begun_at IS NOT NULL AND NEW.begun_at IS DISTINCT FROM OLD.begun_at)
     OR (OLD.begun_at IS NOT NULL AND (NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
       OR NEW.lease_fence IS DISTINCT FROM OLD.lease_fence
       OR NEW.lease_fence_digest IS DISTINCT FROM OLD.lease_fence_digest))
     OR (OLD.state='leased' AND NEW.state='leased' AND
       (NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
        OR NEW.lease_fence IS DISTINCT FROM OLD.lease_fence
        OR NEW.lease_fence_digest IS DISTINCT FROM OLD.lease_fence_digest))
     OR NEW.created_at <> OLD.created_at OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
     OR NOT ((OLD.state='pending' AND NEW.state IN ('leased','superseded','attention'))
       OR (OLD.state='leased' AND NEW.state IN ('pending','leased','provider_io_begun','superseded','attention'))
       OR (OLD.state='provider_io_begun' AND NEW.state IN ('accepted','rejected','outcome_unknown','attention'))) THEN
    RAISE EXCEPTION 'provider_delivery_immutable_or_invalid_transition';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION cp_reject_effect_approval_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.approval_id IS NOT NULL AND
    ROW(NEW.approval_id,NEW.approval_digest,NEW.approval)
      IS DISTINCT FROM ROW(OLD.approval_id,OLD.approval_digest,OLD.approval) THEN
    RAISE EXCEPTION 'effect_approval_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION cp_reject_effect_authority_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'effect_authority_immutable'; END $$;

CREATE FUNCTION cp_reject_effect_request_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION cp_reject_hosted_attempt_claim_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'hosted_attempt_claim_immutable';
END;
$$;

CREATE FUNCTION cp_reject_publication_candidate_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'publication_candidate_immutable'; END $$;

CREATE FUNCTION cp_reject_terminal_job_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'terminal_job_immutable';
END;
$$;

CREATE FUNCTION cp_related_projection_after() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE org_id text; target_run text; BEGIN
  org_id:=COALESCE(NEW.organization_id,OLD.organization_id); target_run:=COALESCE(NEW.run_id,OLD.run_id);
  UPDATE cp_hosted_run SET projection_revision=projection_revision+1
    WHERE organization_id=org_id AND run_id=target_run; RETURN COALESCE(NEW,OLD);
END $$;

CREATE TABLE cp_api_key (
    api_key_id text NOT NULL,
    organization_id text NOT NULL,
    label text NOT NULL,
    token_hash text NOT NULL,
    scope text[] NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    revoked_at timestamp with time zone
);

CREATE TABLE cp_effect (
    organization_id text NOT NULL,
    effect_id text NOT NULL,
    idempotency_key text NOT NULL,
    effect_kind text NOT NULL,
    request_id text NOT NULL,
    request_digest text NOT NULL,
    runner_id text NOT NULL,
    runner_generation integer NOT NULL,
    run_id text NOT NULL,
    run_attempt_id text NOT NULL,
    run_attempt_number integer NOT NULL,
    fencing_token_digest text NOT NULL,
    candidate_id text NOT NULL,
    candidate_digest text NOT NULL,
    project_target_id text NOT NULL,
    target_binding_digest text NOT NULL,
    target_binding_generation integer NOT NULL,
    target_digest text NOT NULL,
    target jsonb NOT NULL,
    policy_snapshot_id text NOT NULL,
    policy_snapshot_digest text NOT NULL,
    approval_request_id text NOT NULL,
    approval_request_digest text NOT NULL,
    approval_expires_at timestamp with time zone NOT NULL,
    approval_id text,
    approval_digest text,
    approval jsonb,
    state text NOT NULL,
    current_attempt_number integer DEFAULT 0 NOT NULL,
    current_evidence_digest text,
    external_resource jsonb,
    reason_code text,
    requested_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_effect_approval_digest_check CHECK (((approval_digest IS NULL) OR (approval_digest ~ '^sha256:[a-f0-9]{64}$'::text))),
    CONSTRAINT cp_effect_approval_request_digest_check CHECK ((approval_request_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_effect_approval_shape_check CHECK ((((approval_id IS NULL) AND (approval_digest IS NULL) AND (approval IS NULL)) OR ((approval_id IS NOT NULL) AND (approval_digest IS NOT NULL) AND (approval IS NOT NULL)))),
    CONSTRAINT cp_effect_candidate_digest_check CHECK ((candidate_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_effect_current_attempt_number_check CHECK ((current_attempt_number >= 0)),
    CONSTRAINT cp_effect_current_evidence_digest_check CHECK (((current_evidence_digest IS NULL) OR (current_evidence_digest ~ '^sha256:[a-f0-9]{64}$'::text))),
    CONSTRAINT cp_effect_effect_kind_check CHECK ((effect_kind = 'github.create_draft_pull_request'::text)),
    CONSTRAINT cp_effect_fencing_token_digest_check CHECK ((fencing_token_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_effect_policy_snapshot_digest_check CHECK ((policy_snapshot_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_effect_projection_shape_check CHECK ((((state = 'requested'::text) AND (current_attempt_number = 0) AND (approval_id IS NULL) AND (current_evidence_digest IS NULL) AND (external_resource IS NULL) AND (reason_code IS NULL)) OR ((state = 'authorized'::text) AND (current_attempt_number = 0) AND (approval_id IS NOT NULL) AND (current_evidence_digest IS NULL) AND (external_resource IS NULL) AND (reason_code IS NULL)) OR ((state = 'permit_issued'::text) AND (current_attempt_number > 0) AND (approval_id IS NOT NULL) AND (current_evidence_digest IS NULL) AND (external_resource IS NULL) AND (reason_code IS NULL)) OR ((state = 'observing'::text) AND (current_attempt_number > 0) AND (approval_id IS NOT NULL) AND (current_evidence_digest IS NOT NULL) AND (external_resource IS NOT NULL) AND (reason_code IS NULL)) OR ((state = 'outcome_unknown'::text) AND (current_attempt_number > 0) AND (approval_id IS NOT NULL) AND (current_evidence_digest IS NOT NULL) AND (reason_code IS NOT NULL)) OR ((state = 'retry_eligible'::text) AND (current_attempt_number > 0) AND (approval_id IS NOT NULL) AND (current_evidence_digest IS NOT NULL) AND (external_resource IS NULL) AND (reason_code = 'local.provider_io_not_begun'::text)) OR ((state = 'succeeded'::text) AND (current_attempt_number > 0) AND (approval_id IS NOT NULL) AND (current_evidence_digest IS NOT NULL) AND (external_resource IS NOT NULL) AND (reason_code IS NULL)) OR ((state = 'attention'::text) AND (reason_code IS NOT NULL) AND ((current_attempt_number > 0) OR ((current_evidence_digest IS NULL) AND (external_resource IS NULL))) AND ((current_attempt_number = 0) OR (approval_id IS NOT NULL)) AND ((external_resource IS NULL) OR (current_evidence_digest IS NOT NULL))) OR ((state = 'cancelled_before_permit'::text) AND (current_attempt_number = 0) AND (current_evidence_digest IS NULL) AND (external_resource IS NULL) AND (reason_code IS NOT NULL)))),
    CONSTRAINT cp_effect_reason_code_check CHECK (((reason_code IS NULL) OR (reason_code ~ '^[a-z][a-z0-9_.-]{0,127}$'::text))),
    CONSTRAINT cp_effect_request_digest_check CHECK ((request_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_effect_run_attempt_number_check CHECK ((run_attempt_number > 0)),
    CONSTRAINT cp_effect_runner_generation_check CHECK ((runner_generation > 0)),
    CONSTRAINT cp_effect_state_check CHECK ((state = ANY (ARRAY['requested'::text, 'authorized'::text, 'permit_issued'::text, 'observing'::text, 'outcome_unknown'::text, 'retry_eligible'::text, 'succeeded'::text, 'attention'::text, 'cancelled_before_permit'::text]))),
    CONSTRAINT cp_effect_target_binding_digest_check CHECK ((target_binding_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_effect_target_binding_generation_check CHECK ((target_binding_generation > 0)),
    CONSTRAINT cp_effect_target_digest_check CHECK ((target_digest ~ '^sha256:[a-f0-9]{64}$'::text))
);

CREATE TABLE cp_effect_attempt (
    organization_id text NOT NULL,
    permit_id text NOT NULL,
    effect_id text NOT NULL,
    effect_attempt_number integer NOT NULL,
    permit_kind text NOT NULL,
    original_execute_permit_id text,
    acquire_request_id text NOT NULL,
    acquire_journal_digest text NOT NULL,
    runner_id text NOT NULL,
    runner_generation integer NOT NULL,
    request_digest text NOT NULL,
    target_digest text NOT NULL,
    approval_digest text NOT NULL,
    permit_digest text NOT NULL,
    permit jsonb NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_effect_attempt_acquire_journal_digest_check CHECK ((acquire_journal_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_effect_attempt_approval_digest_check CHECK ((approval_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_effect_attempt_effect_attempt_number_check CHECK ((effect_attempt_number > 0)),
    CONSTRAINT cp_effect_attempt_permit_digest_check CHECK ((permit_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_effect_attempt_permit_kind_check CHECK ((permit_kind = ANY (ARRAY['execute'::text, 'reconcile'::text]))),
    CONSTRAINT cp_effect_attempt_permit_shape_check CHECK ((((permit_kind = 'execute'::text) AND (original_execute_permit_id IS NULL)) OR ((permit_kind = 'reconcile'::text) AND (original_execute_permit_id IS NOT NULL)))),
    CONSTRAINT cp_effect_attempt_permit_window_check CHECK (((expires_at > issued_at) AND (expires_at <= (issued_at + '00:05:00'::interval)))),
    CONSTRAINT cp_effect_attempt_request_digest_check CHECK ((request_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_effect_attempt_runner_generation_check CHECK ((runner_generation > 0)),
    CONSTRAINT cp_effect_attempt_target_digest_check CHECK ((target_digest ~ '^sha256:[a-f0-9]{64}$'::text))
);

CREATE TABLE cp_effect_evidence (
    organization_id text NOT NULL,
    evidence_id text NOT NULL,
    effect_id text NOT NULL,
    permit_id text NOT NULL,
    effect_attempt_number integer NOT NULL,
    sequence integer NOT NULL,
    predecessor_evidence_digest text,
    payload_digest text NOT NULL,
    evidence_digest text NOT NULL,
    evidence jsonb NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_effect_evidence_effect_attempt_number_check CHECK ((effect_attempt_number > 0)),
    CONSTRAINT cp_effect_evidence_evidence_digest_check CHECK ((evidence_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_effect_evidence_payload_digest_check CHECK ((payload_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_effect_evidence_predecessor_evidence_digest_check CHECK (((predecessor_evidence_digest IS NULL) OR (predecessor_evidence_digest ~ '^sha256:[a-f0-9]{64}$'::text))),
    CONSTRAINT cp_effect_evidence_sequence_check CHECK ((sequence > 0))
);

CREATE TABLE cp_hosted_attempt (
    organization_id text NOT NULL,
    run_id text NOT NULL,
    attempt_number integer NOT NULL,
    attempt_id text NOT NULL,
    runner_id text NOT NULL,
    credential_id text NOT NULL,
    fencing_token_digest text NOT NULL,
    claim_operation_id text NOT NULL,
    claim_request_digest text NOT NULL,
    claim jsonb NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    state text NOT NULL,
    claimed_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    material_start_state text DEFAULT 'open'::text NOT NULL,
    blocked_permission_request_id text,
    blocked_action_descriptor_digest text,
    blocked_policy_snapshot_digest text,
    workspace_attestation jsonb,
    interruption_evidence jsonb,
    CONSTRAINT cp_hosted_attempt_attempt_number_check CHECK ((attempt_number > 0)),
    CONSTRAINT cp_hosted_attempt_blocked_permission_check CHECK ((((state = 'needs_approval'::text) AND (blocked_permission_request_id IS NOT NULL) AND (blocked_action_descriptor_digest IS NOT NULL) AND (blocked_policy_snapshot_digest IS NOT NULL)) OR ((state <> 'needs_approval'::text) AND (blocked_permission_request_id IS NULL) AND (blocked_action_descriptor_digest IS NULL) AND (blocked_policy_snapshot_digest IS NULL)))),
    CONSTRAINT cp_hosted_attempt_interruption_evidence_content_free_check CHECK (((interruption_evidence IS NULL) OR ((jsonb_typeof(interruption_evidence) = 'object'::text) AND (interruption_evidence ?& ARRAY['state'::text, 'runId'::text, 'attemptId'::text, 'attemptNumber'::text, 'workspaceId'::text, 'workspacePathDigest'::text, 'fencingTokenDigest'::text, 'reason'::text, 'observedAt'::text, 'processStop'::text, 'materialOutcome'::text]) AND (NOT (interruption_evidence ? 'workspacePath'::text))))),
    CONSTRAINT cp_hosted_attempt_material_start_state_check CHECK ((material_start_state = ANY (ARRAY['open'::text, 'started_or_ambiguous'::text]))),
    CONSTRAINT cp_hosted_attempt_state_check CHECK ((state = ANY (ARRAY['claimed'::text, 'running'::text, 'needs_approval'::text, 'succeeded'::text, 'failed'::text, 'rejected'::text, 'cancelled'::text, 'interrupted'::text, 'timed_out'::text, 'expired'::text]))),
    CONSTRAINT cp_hosted_attempt_workspace_attestation_content_free_check CHECK (((workspace_attestation IS NULL) OR ((jsonb_typeof(workspace_attestation) = 'object'::text) AND (workspace_attestation ?& ARRAY['workspaceId'::text, 'workspacePathDigest'::text, 'repositoryPathDigest'::text, 'worktreeIdentityDigest'::text, 'baseRevision'::text, 'currentRevision'::text, 'currentTree'::text, 'workspaceStateDigest'::text, 'attemptId'::text, 'attemptNumber'::text, 'fencingTokenDigest'::text, 'credentialId'::text, 'leaseExpiresAt'::text]) AND (NOT (workspace_attestation ? 'workspacePath'::text)))))
);

CREATE TABLE cp_hosted_audit_event (
    sequence_id bigint NOT NULL,
    organization_id text NOT NULL,
    run_id text NOT NULL,
    event_kind text NOT NULL,
    event jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL
);

ALTER TABLE cp_hosted_audit_event ALTER COLUMN sequence_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME cp_hosted_audit_event_sequence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE cp_hosted_lifecycle_receipt (
    organization_id text NOT NULL,
    operation_id text NOT NULL,
    request_id text NOT NULL,
    request_digest text NOT NULL,
    run_id text NOT NULL,
    attempt_id text NOT NULL,
    action text NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_hosted_lifecycle_receipt_action_check CHECK ((action = ANY (ARRAY['heartbeat'::text, 'running'::text, 'progress'::text, 'reject_start'::text, 'executor_result'::text, 'cancel'::text])))
);

CREATE TABLE cp_hosted_run (
    organization_id text NOT NULL,
    run_id text NOT NULL,
    admission_id text NOT NULL,
    admission_operation_id text NOT NULL,
    admission_digest text NOT NULL,
    source_identity_digest text NOT NULL,
    runner_id text NOT NULL,
    executor_id text NOT NULL,
    state text NOT NULL,
    current_attempt_number integer DEFAULT 0 NOT NULL,
    terminal_kind text,
    terminal_receipt jsonb,
    hosted_admission jsonb NOT NULL,
    admission_policy_snapshot jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    source_version_ref text NOT NULL,
    source_content_ids text[] NOT NULL,
    source_context_digest text NOT NULL,
    queue_claim_deadline timestamp with time zone NOT NULL,
    permission_ceiling_digest text NOT NULL,
    publication_mode text NOT NULL,
    publication_policy_digest text NOT NULL,
    completion_mode text NOT NULL,
    completion_contract_digest text NOT NULL,
    outcome_state text,
    reconciliation_identity text,
    terminal_reason text,
    projection_revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT cp_hosted_run_check CHECK (((terminal_kind IS NULL) = (terminal_receipt IS NULL))),
    CONSTRAINT cp_hosted_run_completion_mode_check CHECK ((completion_mode = ANY (ARRAY['proposal_ready'::text, 'pull_request_ready'::text]))),
    CONSTRAINT cp_hosted_run_current_attempt_number_check CHECK ((current_attempt_number >= 0)),
    CONSTRAINT cp_hosted_run_outcome_state_check CHECK (((outcome_state IS NULL) OR (outcome_state = 'outcome_unknown'::text))),
    CONSTRAINT cp_hosted_run_projection_revision_check CHECK ((projection_revision > 0)),
    CONSTRAINT cp_hosted_run_publication_completion_check CHECK ((((publication_mode = 'proposal_only'::text) AND (completion_mode = 'proposal_ready'::text)) OR ((publication_mode = 'pull_request'::text) AND (completion_mode = 'pull_request_ready'::text)))),
    CONSTRAINT cp_hosted_run_publication_mode_check CHECK ((publication_mode = ANY (ARRAY['proposal_only'::text, 'pull_request'::text]))),
    CONSTRAINT cp_hosted_run_queue_claim_deadline_check CHECK ((isfinite(queue_claim_deadline) AND (queue_claim_deadline > created_at))),
    CONSTRAINT cp_hosted_run_source_content_ids_check CHECK ((cardinality(source_content_ids) > 0)),
    CONSTRAINT cp_hosted_run_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'assigned'::text, 'running'::text, 'needs_approval'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'interrupted'::text, 'timed_out'::text]))),
    CONSTRAINT cp_hosted_run_terminal_kind_check CHECK ((terminal_kind = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text, 'interrupted'::text, 'timed_out'::text])))
);

CREATE TABLE cp_ingress_reservation (
    reservation_id text NOT NULL,
    organization_id text NOT NULL,
    installation_id text NOT NULL,
    binding_id text NOT NULL,
    source_app_id text NOT NULL,
    source_delivery_id text NOT NULL,
    source_message_id text NOT NULL,
    source_version_ref text NOT NULL,
    raw_digest text NOT NULL,
    content_id text NOT NULL,
    content_aad_digest text NOT NULL,
    content_key_version text NOT NULL,
    resolution_request_digest text,
    resolution_run_id text,
    resolution jsonb,
    resolved_at timestamp with time zone,
    state text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    content_payload_digest text NOT NULL,
    CONSTRAINT cp_ingress_reservation_check CHECK (((resolution_request_digest IS NULL) = (resolution_run_id IS NULL))),
    CONSTRAINT cp_ingress_reservation_check1 CHECK ((((state = 'pending'::text) AND (resolution IS NULL) AND (resolved_at IS NULL)) OR ((state = 'resolved'::text) AND (resolution IS NOT NULL) AND (resolved_at IS NOT NULL)))),
    CONSTRAINT cp_ingress_reservation_resolution_check CHECK (((resolution IS NULL) OR ((resolution ->> 'kind'::text) = ANY (ARRAY['accepted'::text, 'waiting_for_runner'::text, 'setup_required'::text, 'not_authorized'::text, 'invalid_request'::text, 'rate_limited'::text, 'queue_full'::text, 'storage_quota_exceeded'::text, 'source_content_deleted'::text, 'temporarily_unavailable'::text]))))
);

CREATE TABLE cp_job (
    job_id text NOT NULL,
    organization_id text,
    job_kind text NOT NULL,
    payload jsonb NOT NULL,
    request_digest text NOT NULL,
    state text NOT NULL,
    available_at timestamp with time zone NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer NOT NULL,
    lease_owner text,
    lease_token text,
    lease_expires_at timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    settlement_lease_token text,
    settlement_outcome jsonb,
    settled_at timestamp with time zone,
    CONSTRAINT cp_job_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT cp_job_check CHECK ((((state = 'claimed'::text) AND (lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR (state <> 'claimed'::text))),
    CONSTRAINT cp_job_max_attempts_check CHECK ((max_attempts > 0)),
    CONSTRAINT cp_job_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'claimed'::text, 'succeeded'::text, 'failed'::text]))),
    CONSTRAINT cp_job_state_shape_check CHECK ((((state = 'pending'::text) AND (lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL) AND (settlement_lease_token IS NULL) AND (settlement_outcome IS NULL) AND (settled_at IS NULL)) OR ((state = 'claimed'::text) AND (lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (settlement_lease_token IS NULL) AND (settlement_outcome IS NULL) AND (settled_at IS NULL)) OR ((state = ANY (ARRAY['succeeded'::text, 'failed'::text])) AND (lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL) AND (settlement_lease_token IS NOT NULL) AND (settlement_outcome IS NOT NULL) AND (settled_at IS NOT NULL))))
);

CREATE TABLE cp_login_throttle (
    throttle_key text NOT NULL,
    failure_count integer NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    locked_until timestamp with time zone,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_login_throttle_failure_count_check CHECK ((failure_count > 0))
);

CREATE TABLE cp_management_audit_event (
    sequence_id bigint NOT NULL,
    organization_id text NOT NULL,
    actor_kind text NOT NULL,
    actor_id text NOT NULL,
    operation_kind text NOT NULL,
    resource_kind text NOT NULL,
    resource_id text NOT NULL,
    outcome text NOT NULL,
    event jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL
);

ALTER TABLE cp_management_audit_event ALTER COLUMN sequence_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME cp_management_audit_event_sequence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE cp_material_action_begin_intent (
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
    authority_kind text NOT NULL,
    authority_reference_id text NOT NULL,
    authority_reference_digest text NOT NULL,
    idempotency_key text NOT NULL,
    begun_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_material_action_begin_intent_authority_kind_check CHECK ((authority_kind = 'permission_resolution'::text))
);

CREATE TABLE cp_material_action_current (
    organization_id text NOT NULL,
    run_id text NOT NULL,
    attempt_id text NOT NULL,
    attempt_number integer NOT NULL,
    action_id text NOT NULL,
    receipt_id text NOT NULL,
    receipt_digest text NOT NULL,
    outcome text NOT NULL,
    receipt jsonb NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_material_action_current_attempt_number_check CHECK ((attempt_number > 0)),
    CONSTRAINT cp_material_action_current_outcome_check CHECK ((outcome = ANY (ARRAY['succeeded'::text, 'failed'::text, 'outcome_unknown'::text])))
);

CREATE TABLE cp_material_action_receipt (
    organization_id text NOT NULL,
    receipt_id text NOT NULL,
    operation_id text NOT NULL,
    run_id text NOT NULL,
    runner_id text NOT NULL,
    attempt_id text NOT NULL,
    attempt_number integer NOT NULL,
    action_id text NOT NULL,
    receipt_digest text NOT NULL,
    outcome text NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_material_action_receipt_attempt_number_check CHECK ((attempt_number > 0)),
    CONSTRAINT cp_material_action_receipt_outcome_check CHECK ((outcome = ANY (ARRAY['succeeded'::text, 'failed'::text, 'outcome_unknown'::text])))
);

CREATE TABLE cp_membership (
    organization_id text NOT NULL,
    operator_id text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT cp_membership_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'operator'::text, 'viewer'::text])))
);

CREATE TABLE cp_operator (
    operator_id text NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    password_hash text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    disabled_at timestamp with time zone
);

CREATE TABLE cp_organization (
    organization_id text NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE cp_permission_operation (
    organization_id text NOT NULL,
    operation_id text NOT NULL,
    request_digest text NOT NULL,
    permission_request_id text NOT NULL,
    operation_kind text NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_permission_operation_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['request'::text, 'decision'::text])))
);

CREATE TABLE cp_permission_request (
    organization_id text NOT NULL,
    permission_request_id text NOT NULL,
    run_id text NOT NULL,
    runner_id text NOT NULL,
    attempt_id text NOT NULL,
    attempt_number integer NOT NULL,
    action_id text NOT NULL,
    resolution_id text NOT NULL,
    permission_request_digest text NOT NULL,
    policy_snapshot_digest text NOT NULL,
    state text NOT NULL,
    request jsonb NOT NULL,
    current_receipt jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_permission_request_attempt_number_check CHECK ((attempt_number > 0)),
    CONSTRAINT cp_permission_request_state_check CHECK ((state = ANY (ARRAY['waiting'::text, 'authorized'::text, 'denied'::text, 'revoked'::text])))
);

CREATE TABLE cp_project_target (
    organization_id text NOT NULL,
    project_target_id text NOT NULL,
    runner_id text NOT NULL,
    binding_digest text NOT NULL,
    provider text NOT NULL,
    owner text NOT NULL,
    repo text NOT NULL,
    default_executor text NOT NULL,
    default_branch text,
    updated_at timestamp with time zone NOT NULL,
    binding_generation integer NOT NULL,
    CONSTRAINT cp_project_target_binding_generation_check CHECK ((binding_generation > 0))
);

CREATE TABLE cp_projection_deferred_revision (
    organization_id text NOT NULL,
    run_id text NOT NULL,
    projection_revision integer NOT NULL,
    anchor_intent_id text NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    woken_at timestamp with time zone,
    CONSTRAINT cp_projection_deferred_revision_check CHECK ((((state = 'pending'::text) AND (woken_at IS NULL)) OR ((state = 'woken'::text) AND (woken_at IS NOT NULL)))),
    CONSTRAINT cp_projection_deferred_revision_projection_revision_check CHECK ((projection_revision > 0)),
    CONSTRAINT cp_projection_deferred_revision_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'woken'::text])))
);

CREATE TABLE cp_projection_delivery_watermark (
    organization_id text NOT NULL,
    run_id text NOT NULL,
    intent_id text NOT NULL,
    delivery_state text NOT NULL,
    delivery_revision integer NOT NULL,
    projection_revision integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    event_sequence integer NOT NULL,
    CONSTRAINT cp_projection_delivery_watermark_check CHECK (((delivery_revision > 0) AND (projection_revision > 0))),
    CONSTRAINT cp_projection_delivery_watermark_event_sequence_check CHECK ((event_sequence > 0))
);

CREATE TABLE cp_projection_event_cursor (
    organization_id text NOT NULL,
    run_id text NOT NULL,
    current_sequence integer DEFAULT 0 NOT NULL,
    CONSTRAINT cp_projection_event_cursor_current_sequence_check CHECK ((current_sequence >= 0))
);

CREATE TABLE cp_provider_delivery_intent (
    intent_id text NOT NULL,
    organization_id text NOT NULL,
    journal_intent_digest text NOT NULL,
    intent jsonb NOT NULL,
    payload jsonb NOT NULL,
    payload_digest text NOT NULL,
    presentation_phase text NOT NULL,
    current_truth_key text NOT NULL,
    state text NOT NULL,
    revision integer NOT NULL,
    sequence integer NOT NULL,
    scope_kind text NOT NULL,
    scope_id text NOT NULL,
    idempotency_key text NOT NULL,
    provider_id text NOT NULL,
    provider_instance_id text NOT NULL,
    provider_binding_digest text NOT NULL,
    provider_config_generation integer NOT NULL,
    provider_config_generation_digest text NOT NULL,
    runtime_owner_id text NOT NULL,
    runtime_generation integer NOT NULL,
    schema_generation integer NOT NULL,
    authority_snapshot_digest text NOT NULL,
    status_message_id text,
    run_id text,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    lease_fence text,
    lease_fence_digest text,
    installation_begin_marker_id text,
    installation_begin_marker_digest text,
    scope_begin_marker_id text,
    scope_begin_marker_digest text,
    begun_at timestamp with time zone,
    evidence_digest text,
    error_code text,
    external_resource_digest text,
    external_resource_id text,
    outcome_recorded_at timestamp with time zone,
    deadline_at timestamp with time zone NOT NULL,
    superseded_by_intent_id text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    projection_revision integer DEFAULT 1 NOT NULL,
    projection_purpose text DEFAULT 'external'::text NOT NULL,
    projection_event_sequence integer DEFAULT 0 NOT NULL,
    CONSTRAINT cp_provider_delivery_error_code_check CHECK (((error_code IS NULL) OR (error_code = ANY (ARRAY['provider_adapter_not_registered'::text, 'delivery_request_preparation_failed'::text, 'delivery_request_digest_mismatch'::text, 'delivery_payload_custody_unavailable'::text, 'provider_binding_mismatch'::text, 'invalid_delivery_shape'::text, 'provider_5xx'::text, 'malformed_response'::text, 'slack_rejected'::text, 'ambiguous_response'::text, 'deadline_exceeded'::text, 'transport_error'::text, 'provider_delivery_timeout'::text, 'provider_delivery_exception'::text, 'provider_result_invalid'::text, 'delivery_settlement_stale'::text, 'delivery_restart_after_begin'::text, 'delivery_deadline_exceeded'::text, 'delivery_superseded'::text])))),
    CONSTRAINT cp_provider_delivery_intent_phase_check CHECK ((presentation_phase = ANY (ARRAY['received'::text, 'running'::text, 'terminal'::text]))),
    CONSTRAINT cp_provider_delivery_intent_revision_check CHECK (((revision > 0) AND (sequence > 0) AND (provider_config_generation > 0) AND (runtime_generation > 0) AND (schema_generation > 0))),
    CONSTRAINT cp_provider_delivery_intent_shape_check CHECK ((((state = 'pending'::text) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL) AND (lease_fence IS NULL) AND (lease_fence_digest IS NULL) AND (installation_begin_marker_id IS NULL) AND (installation_begin_marker_digest IS NULL) AND (scope_begin_marker_id IS NULL) AND (scope_begin_marker_digest IS NULL) AND (begun_at IS NULL) AND (evidence_digest IS NULL) AND (error_code IS NULL) AND (external_resource_id IS NULL) AND (external_resource_digest IS NULL) AND (superseded_by_intent_id IS NULL) AND (outcome_recorded_at IS NULL)) OR ((state = 'leased'::text) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_fence IS NOT NULL) AND (lease_fence_digest IS NOT NULL) AND (installation_begin_marker_id IS NULL) AND (installation_begin_marker_digest IS NULL) AND (scope_begin_marker_id IS NULL) AND (scope_begin_marker_digest IS NULL) AND (begun_at IS NULL) AND (evidence_digest IS NULL) AND (error_code IS NULL) AND (external_resource_id IS NULL) AND (external_resource_digest IS NULL) AND (superseded_by_intent_id IS NULL) AND (outcome_recorded_at IS NULL)) OR ((state = 'provider_io_begun'::text) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_fence IS NOT NULL) AND (lease_fence_digest IS NOT NULL) AND (begun_at IS NOT NULL) AND (installation_begin_marker_id IS NOT NULL) AND (installation_begin_marker_digest IS NOT NULL) AND (scope_begin_marker_id IS NOT NULL) AND (scope_begin_marker_digest IS NOT NULL) AND (evidence_digest IS NULL) AND (error_code IS NULL) AND (external_resource_id IS NULL) AND (external_resource_digest IS NULL) AND (superseded_by_intent_id IS NULL) AND (outcome_recorded_at IS NULL)) OR ((state = ANY (ARRAY['accepted'::text, 'rejected'::text, 'outcome_unknown'::text, 'attention'::text])) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_fence IS NOT NULL) AND (lease_fence_digest IS NOT NULL) AND (installation_begin_marker_id IS NOT NULL) AND (installation_begin_marker_digest IS NOT NULL) AND (scope_begin_marker_id IS NOT NULL) AND (scope_begin_marker_digest IS NOT NULL) AND (begun_at IS NOT NULL) AND (evidence_digest IS NOT NULL) AND (outcome_recorded_at IS NOT NULL) AND (superseded_by_intent_id IS NULL) AND (((state = 'accepted'::text) AND (error_code IS NULL)) OR ((state <> 'accepted'::text) AND (error_code IS NOT NULL))) AND (((external_resource_id IS NULL) AND (external_resource_digest IS NULL)) OR ((state = 'accepted'::text) AND (external_resource_id IS NOT NULL) AND (external_resource_digest IS NOT NULL)))) OR ((state = 'attention'::text) AND (begun_at IS NULL) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL) AND (lease_fence IS NULL) AND (lease_fence_digest IS NULL) AND (installation_begin_marker_id IS NULL) AND (installation_begin_marker_digest IS NULL) AND (scope_begin_marker_id IS NULL) AND (scope_begin_marker_digest IS NULL) AND (external_resource_id IS NULL) AND (external_resource_digest IS NULL) AND (superseded_by_intent_id IS NULL) AND (evidence_digest IS NOT NULL) AND (error_code = 'delivery_deadline_exceeded'::text) AND (outcome_recorded_at IS NOT NULL)) OR ((state = 'superseded'::text) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL) AND (lease_fence IS NULL) AND (lease_fence_digest IS NULL) AND (begun_at IS NULL) AND (installation_begin_marker_id IS NULL) AND (installation_begin_marker_digest IS NULL) AND (scope_begin_marker_id IS NULL) AND (scope_begin_marker_digest IS NULL) AND (external_resource_id IS NULL) AND (external_resource_digest IS NULL) AND (evidence_digest IS NOT NULL) AND (error_code = 'delivery_superseded'::text) AND (outcome_recorded_at IS NOT NULL) AND (superseded_by_intent_id IS NOT NULL)))),
    CONSTRAINT cp_provider_delivery_intent_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'leased'::text, 'provider_io_begun'::text, 'accepted'::text, 'rejected'::text, 'outcome_unknown'::text, 'attention'::text, 'superseded'::text]))),
    CONSTRAINT cp_provider_delivery_projection_event_sequence_check CHECK ((projection_event_sequence >= 0)),
    CONSTRAINT cp_provider_delivery_projection_purpose_check CHECK ((projection_purpose = ANY (ARRAY['external'::text, 'anchor_create'::text, 'anchor_update'::text]))),
    CONSTRAINT cp_provider_delivery_projection_revision_check CHECK ((projection_revision > 0))
);

CREATE TABLE cp_provider_delivery_truth_lock (
    current_truth_key text NOT NULL
);

CREATE TABLE cp_publication_candidate (
    organization_id text NOT NULL,
    candidate_id text NOT NULL,
    run_id text NOT NULL,
    attempt_id text NOT NULL,
    attempt_number integer NOT NULL,
    project_target_id text NOT NULL,
    frozen_base_revision text NOT NULL,
    workspace_tree_digest text NOT NULL,
    patch_digest text NOT NULL,
    changed_files text[] NOT NULL,
    verification_evidence_ids text[] NOT NULL,
    publication_policy_digest text NOT NULL,
    candidate jsonb NOT NULL,
    completion_assessment jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_publication_candidate_base_revision_check CHECK ((frozen_base_revision ~ '^[a-f0-9]{40,64}$'::text)),
    CONSTRAINT cp_publication_candidate_changed_files_check CHECK ((cardinality(changed_files) > 0)),
    CONSTRAINT cp_publication_candidate_content_free_check CHECK (((jsonb_typeof(candidate) = 'object'::text) AND (NOT (candidate ?| ARRAY['baseToFinalBinaryDiff'::text, 'limitations'::text, 'workspacePath'::text, 'logs'::text, 'output'::text, 'secret'::text])))),
    CONSTRAINT cp_publication_candidate_patch_digest_check CHECK ((patch_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_publication_candidate_policy_digest_check CHECK ((publication_policy_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_publication_candidate_tree_digest_check CHECK ((workspace_tree_digest ~ '^[a-f0-9]{40,64}$'::text)),
    CONSTRAINT cp_publication_candidate_verification_check CHECK ((cardinality(verification_evidence_ids) > 0))
);

CREATE TABLE cp_runner (
    organization_id text NOT NULL,
    runner_id text NOT NULL,
    registration_generation integer NOT NULL,
    credential_generation integer NOT NULL,
    current_credential_id text NOT NULL,
    capabilities jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_runner_credential_generation_check CHECK ((credential_generation > 0)),
    CONSTRAINT cp_runner_registration_generation_check CHECK ((registration_generation > 0))
);

CREATE TABLE cp_runner_credential (
    organization_id text NOT NULL,
    runner_id text NOT NULL,
    credential_id text NOT NULL,
    credential_generation integer NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT cp_runner_credential_credential_generation_check CHECK ((credential_generation > 0))
);

CREATE TABLE cp_runner_operation (
    organization_id text NOT NULL,
    operation_id text NOT NULL,
    request_id text NOT NULL,
    request_digest text NOT NULL,
    operation_kind text NOT NULL,
    runner_id text NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL
);

CREATE TABLE cp_runner_readiness (
    organization_id text NOT NULL,
    runner_id text NOT NULL,
    receipt_id text NOT NULL,
    receipt_digest text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE cp_session (
    session_id text NOT NULL,
    operator_id text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    revoked_at timestamp with time zone,
    organization_id text NOT NULL
);

CREATE TABLE cp_slack_action_authority (
    organization_id text NOT NULL,
    action_id text NOT NULL,
    action_token_hash text NOT NULL,
    installation_id text NOT NULL,
    binding_id text NOT NULL,
    team_id text NOT NULL,
    app_id text NOT NULL,
    channel_id text NOT NULL,
    thread_root_message_id text NOT NULL,
    run_id text NOT NULL,
    pending_request_id text NOT NULL,
    action_kind text NOT NULL,
    action_descriptor jsonb NOT NULL,
    approval_epoch text NOT NULL,
    frozen_ceiling jsonb NOT NULL,
    allowed_decisions text[] NOT NULL,
    requester_user_id text,
    member_user_ids text[] NOT NULL,
    operator_user_ids text[] NOT NULL,
    approver_user_id text,
    admin_user_ids text[] NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    action_descriptor_digest text NOT NULL,
    frozen_ceiling_digest text NOT NULL,
    policy_digest text NOT NULL,
    runner_id text NOT NULL,
    attempt_id text NOT NULL,
    attempt_number integer NOT NULL,
    attempt_epoch integer NOT NULL,
    fencing_token_digest text NOT NULL,
    permission_request_digest text NOT NULL,
    pending_action_id text NOT NULL,
    projection_generation integer NOT NULL,
    effect_approval jsonb,
    authority_family_id text NOT NULL,
    authority_epoch integer NOT NULL,
    claim_state text NOT NULL,
    claimed_at timestamp with time zone,
    CONSTRAINT cp_slack_action_authority_attempt_number_check CHECK ((attempt_number > 0)),
    CONSTRAINT cp_slack_action_authority_claim_shape_check CHECK ((((claim_state = 'available'::text) AND (claimed_at IS NULL) AND (consumed_at IS NULL)) OR ((claim_state = 'claimed'::text) AND (claimed_at IS NOT NULL) AND (consumed_at IS NULL)) OR ((claim_state = 'consumed'::text) AND (consumed_at IS NOT NULL)))),
    CONSTRAINT cp_slack_action_authority_claim_state_check CHECK ((claim_state = ANY (ARRAY['available'::text, 'claimed'::text, 'consumed'::text]))),
    CONSTRAINT cp_slack_action_authority_decisions_check CHECK (((cardinality(allowed_decisions) > 0) AND (allowed_decisions <@ ARRAY['status'::text, 'cancel'::text, 'allow_once'::text, 'allow_run'::text, 'deny'::text, 'effect_approve'::text, 'bind'::text, 'unbind'::text]))),
    CONSTRAINT cp_slack_action_authority_effect_shape_check CHECK (((action_kind = 'effect'::text) = (effect_approval IS NOT NULL))),
    CONSTRAINT cp_slack_action_authority_epoch_check CHECK ((authority_epoch > 0)),
    CONSTRAINT cp_slack_action_authority_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT cp_slack_action_authority_kind_check CHECK ((action_kind = ANY (ARRAY['status'::text, 'cancel'::text, 'approval'::text, 'effect'::text, 'bind'::text, 'unbind'::text]))),
    CONSTRAINT cp_slack_action_authority_members_check CHECK ((cardinality(member_user_ids) > 0)),
    CONSTRAINT cp_slack_action_authority_projection_generation_check CHECK ((projection_generation > 0))
);

CREATE TABLE cp_slack_binding (
    organization_id text NOT NULL,
    binding_id text NOT NULL,
    installation_id text NOT NULL,
    binding_digest text NOT NULL,
    state text NOT NULL,
    credential_generation integer NOT NULL,
    credential_generation_digest text NOT NULL,
    route_identity text NOT NULL,
    team_id text NOT NULL,
    app_id text NOT NULL,
    channel_id text NOT NULL,
    bot_user_id text NOT NULL,
    member_user_ids text[] NOT NULL,
    operator_user_ids text[] DEFAULT '{}'::text[] NOT NULL,
    approver_user_id text,
    admin_user_ids text[] DEFAULT '{}'::text[] NOT NULL,
    signing_secret_ref text NOT NULL,
    bot_token_ref text NOT NULL,
    project_target_id text,
    publication_mode text DEFAULT 'proposal_only'::text NOT NULL,
    display_name text DEFAULT 'OpenTag'::text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_slack_binding_binding_digest_check CHECK ((binding_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_slack_binding_credential_generation_check CHECK ((credential_generation > 0)),
    CONSTRAINT cp_slack_binding_credential_generation_digest_check CHECK ((credential_generation_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT cp_slack_binding_identity_check CHECK (((binding_id <> ''::text) AND (installation_id <> ''::text) AND (route_identity <> ''::text) AND (team_id <> ''::text) AND (app_id <> ''::text) AND (channel_id <> ''::text) AND (bot_user_id <> ''::text))),
    CONSTRAINT cp_slack_binding_members_check CHECK ((cardinality(member_user_ids) > 0)),
    CONSTRAINT cp_slack_binding_publication_mode_check CHECK ((publication_mode = ANY (ARRAY['proposal_only'::text, 'pull_request'::text]))),
    CONSTRAINT cp_slack_binding_roles_check CHECK (((operator_user_ids <@ member_user_ids) AND (admin_user_ids <@ member_user_ids) AND ((approver_user_id IS NULL) OR (approver_user_id = ANY (member_user_ids))))),
    CONSTRAINT cp_slack_binding_secret_refs_check CHECK (((signing_secret_ref <> ''::text) AND (bot_token_ref <> ''::text))),
    CONSTRAINT cp_slack_binding_state_check CHECK ((state = ANY (ARRAY['active'::text, 'disabled'::text])))
);

CREATE TABLE cp_source_content (
    organization_id text NOT NULL,
    content_id text NOT NULL,
    installation_id text NOT NULL,
    source_app_id text NOT NULL,
    source_delivery_id text NOT NULL,
    source_message_id text NOT NULL,
    source_version_ref text NOT NULL,
    purpose text NOT NULL,
    ciphertext bytea,
    content_nonce bytea,
    content_tag bytea,
    wrapped_dek bytea,
    wrapping_nonce bytea,
    wrapping_tag bytea,
    aad_digest text NOT NULL,
    key_version text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    terminal_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    payload_digest text NOT NULL,
    CONSTRAINT cp_source_content_check CHECK ((((deleted_at IS NULL) AND (ciphertext IS NOT NULL) AND (content_nonce IS NOT NULL) AND (content_tag IS NOT NULL) AND (wrapped_dek IS NOT NULL) AND (wrapping_nonce IS NOT NULL) AND (wrapping_tag IS NOT NULL)) OR ((deleted_at IS NOT NULL) AND (ciphertext IS NULL) AND (content_nonce IS NULL) AND (content_tag IS NULL) AND (wrapped_dek IS NULL) AND (wrapping_nonce IS NULL) AND (wrapping_tag IS NULL)))),
    CONSTRAINT cp_source_content_payload_digest_check CHECK ((payload_digest ~ '^sha256:[a-f0-9]{64}$'::text))
);

CREATE TABLE cp_source_content_invalidation_receipt (
    organization_id text NOT NULL,
    command_id text NOT NULL,
    request_digest text NOT NULL,
    source_version_ref text NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_source_content_invalidation_receipt_receipt_check CHECK (((receipt ->> 'reason'::text) = 'source_content_deleted'::text))
);

CREATE TABLE cp_source_content_read_grant (
    grant_id text NOT NULL,
    organization_id text NOT NULL,
    token_hash text NOT NULL,
    run_id text NOT NULL,
    attempt_id text NOT NULL,
    fence_digest text NOT NULL,
    content_ids text[] NOT NULL,
    purpose text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    key_version text NOT NULL,
    CONSTRAINT cp_source_content_read_grant_content_ids_check CHECK ((cardinality(content_ids) > 0))
);

CREATE TABLE cp_source_replay_tombstone (
    organization_id text NOT NULL,
    replay_identity_digest text NOT NULL,
    source_version_digest text NOT NULL,
    command_id text,
    request_digest text,
    invalidation_receipt jsonb,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT cp_source_replay_tombstone_invalidation_receipt_check CHECK (((invalidation_receipt IS NULL) OR ((jsonb_typeof(invalidation_receipt) = 'object'::text) AND (invalidation_receipt ?& ARRAY['commandId'::text, 'organizationId'::text, 'sourceVersionRef'::text, 'reason'::text, 'recordedAt'::text, 'authorityReceiptDigest'::text]) AND ((invalidation_receipt - ARRAY['commandId'::text, 'organizationId'::text, 'sourceVersionRef'::text, 'reason'::text, 'recordedAt'::text, 'authorityReceiptDigest'::text]) = '{}'::jsonb) AND ((invalidation_receipt ->> 'reason'::text) = 'source_content_deleted'::text) AND ((invalidation_receipt ->> 'authorityReceiptDigest'::text) ~ '^sha256:[a-f0-9]{64}$'::text) AND ((length((invalidation_receipt ->> 'commandId'::text)) >= 1) AND (length((invalidation_receipt ->> 'commandId'::text)) <= 512)) AND ((length((invalidation_receipt ->> 'organizationId'::text)) >= 1) AND (length((invalidation_receipt ->> 'organizationId'::text)) <= 512)) AND ((length((invalidation_receipt ->> 'sourceVersionRef'::text)) >= 1) AND (length((invalidation_receipt ->> 'sourceVersionRef'::text)) <= 512)) AND ((length((invalidation_receipt ->> 'recordedAt'::text)) >= 1) AND (length((invalidation_receipt ->> 'recordedAt'::text)) <= 64)))))
);

ALTER TABLE ONLY cp_api_key
    ADD CONSTRAINT cp_api_key_pkey PRIMARY KEY (api_key_id);

ALTER TABLE ONLY cp_api_key
    ADD CONSTRAINT cp_api_key_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY cp_effect_attempt
    ADD CONSTRAINT cp_effect_attempt_organization_id_effect_id_permit_id_effec_key UNIQUE (organization_id, effect_id, permit_id, effect_attempt_number);

ALTER TABLE ONLY cp_effect_attempt
    ADD CONSTRAINT cp_effect_attempt_organization_id_effect_id_permit_id_key UNIQUE (organization_id, effect_id, permit_id);

ALTER TABLE ONLY cp_effect_attempt
    ADD CONSTRAINT cp_effect_attempt_organization_id_runner_id_acquire_request_key UNIQUE (organization_id, runner_id, acquire_request_id);

ALTER TABLE ONLY cp_effect_attempt
    ADD CONSTRAINT cp_effect_attempt_pkey PRIMARY KEY (organization_id, permit_id);

ALTER TABLE ONLY cp_effect_evidence
    ADD CONSTRAINT cp_effect_evidence_organization_id_effect_id_sequence_key UNIQUE (organization_id, effect_id, sequence);

ALTER TABLE ONLY cp_effect_evidence
    ADD CONSTRAINT cp_effect_evidence_organization_id_evidence_digest_key UNIQUE (organization_id, evidence_digest);

ALTER TABLE ONLY cp_effect_evidence
    ADD CONSTRAINT cp_effect_evidence_pkey PRIMARY KEY (organization_id, evidence_id);

ALTER TABLE ONLY cp_effect
    ADD CONSTRAINT cp_effect_logical_key UNIQUE (organization_id, effect_kind, candidate_id);

ALTER TABLE ONLY cp_effect
    ADD CONSTRAINT cp_effect_organization_id_approval_id_key UNIQUE (organization_id, approval_id);

ALTER TABLE ONLY cp_effect
    ADD CONSTRAINT cp_effect_organization_id_approval_request_id_key UNIQUE (organization_id, approval_request_id);

ALTER TABLE ONLY cp_effect
    ADD CONSTRAINT cp_effect_organization_id_runner_id_idempotency_key_key UNIQUE (organization_id, runner_id, idempotency_key);

ALTER TABLE ONLY cp_effect
    ADD CONSTRAINT cp_effect_pkey PRIMARY KEY (organization_id, effect_id);

ALTER TABLE ONLY cp_hosted_attempt
    ADD CONSTRAINT cp_hosted_attempt_exact_identity_key UNIQUE (organization_id, run_id, attempt_number, attempt_id);

ALTER TABLE ONLY cp_hosted_attempt
    ADD CONSTRAINT cp_hosted_attempt_organization_id_attempt_id_key UNIQUE (organization_id, attempt_id);

ALTER TABLE ONLY cp_hosted_attempt
    ADD CONSTRAINT cp_hosted_attempt_organization_id_claim_operation_id_key UNIQUE (organization_id, claim_operation_id);

ALTER TABLE ONLY cp_hosted_attempt
    ADD CONSTRAINT cp_hosted_attempt_pkey PRIMARY KEY (organization_id, run_id, attempt_number);

ALTER TABLE ONLY cp_hosted_audit_event
    ADD CONSTRAINT cp_hosted_audit_event_pkey PRIMARY KEY (sequence_id);

ALTER TABLE ONLY cp_hosted_lifecycle_receipt
    ADD CONSTRAINT cp_hosted_lifecycle_receipt_pkey PRIMARY KEY (organization_id, operation_id);

ALTER TABLE ONLY cp_hosted_run
    ADD CONSTRAINT cp_hosted_run_organization_id_admission_id_key UNIQUE (organization_id, admission_id);

ALTER TABLE ONLY cp_hosted_run
    ADD CONSTRAINT cp_hosted_run_organization_id_source_identity_digest_key UNIQUE (organization_id, source_identity_digest);

ALTER TABLE ONLY cp_hosted_run
    ADD CONSTRAINT cp_hosted_run_pkey PRIMARY KEY (organization_id, run_id);

ALTER TABLE ONLY cp_ingress_reservation
    ADD CONSTRAINT cp_ingress_reservation_organization_id_installation_id_sour_key UNIQUE (organization_id, installation_id, source_delivery_id);

ALTER TABLE ONLY cp_ingress_reservation
    ADD CONSTRAINT cp_ingress_reservation_organization_id_reservation_id_key UNIQUE (organization_id, reservation_id);

ALTER TABLE ONLY cp_ingress_reservation
    ADD CONSTRAINT cp_ingress_reservation_pkey PRIMARY KEY (reservation_id);

ALTER TABLE ONLY cp_job
    ADD CONSTRAINT cp_job_pkey PRIMARY KEY (job_id);

ALTER TABLE ONLY cp_login_throttle
    ADD CONSTRAINT cp_login_throttle_pkey PRIMARY KEY (throttle_key);

ALTER TABLE ONLY cp_management_audit_event
    ADD CONSTRAINT cp_management_audit_event_pkey PRIMARY KEY (sequence_id);

ALTER TABLE ONLY cp_material_action_begin_intent
    ADD CONSTRAINT cp_material_action_begin_inte_organization_id_idempotency_k_key UNIQUE (organization_id, idempotency_key);

ALTER TABLE ONLY cp_material_action_begin_intent
    ADD CONSTRAINT cp_material_action_begin_intent_pkey PRIMARY KEY (organization_id, run_id, attempt_id, action_id);

ALTER TABLE ONLY cp_material_action_current
    ADD CONSTRAINT cp_material_action_current_pkey PRIMARY KEY (organization_id, run_id, attempt_id, action_id);

ALTER TABLE ONLY cp_material_action_receipt
    ADD CONSTRAINT cp_material_action_receipt_organization_id_operation_id_key UNIQUE (organization_id, operation_id);

ALTER TABLE ONLY cp_material_action_receipt
    ADD CONSTRAINT cp_material_action_receipt_organization_id_receipt_digest_key UNIQUE (organization_id, receipt_digest);

ALTER TABLE ONLY cp_material_action_receipt
    ADD CONSTRAINT cp_material_action_receipt_pkey PRIMARY KEY (organization_id, receipt_id);

ALTER TABLE ONLY cp_membership
    ADD CONSTRAINT cp_membership_pkey PRIMARY KEY (organization_id, operator_id);

ALTER TABLE ONLY cp_operator
    ADD CONSTRAINT cp_operator_email_key UNIQUE (email);

ALTER TABLE ONLY cp_operator
    ADD CONSTRAINT cp_operator_pkey PRIMARY KEY (operator_id);

ALTER TABLE ONLY cp_organization
    ADD CONSTRAINT cp_organization_pkey PRIMARY KEY (organization_id);

ALTER TABLE ONLY cp_permission_operation
    ADD CONSTRAINT cp_permission_operation_pkey PRIMARY KEY (organization_id, operation_id);

ALTER TABLE ONLY cp_permission_request
    ADD CONSTRAINT cp_permission_request_organization_id_run_id_attempt_id_act_key UNIQUE (organization_id, run_id, attempt_id, action_id);

ALTER TABLE ONLY cp_permission_request
    ADD CONSTRAINT cp_permission_request_pkey PRIMARY KEY (organization_id, permission_request_id);

ALTER TABLE ONLY cp_project_target
    ADD CONSTRAINT cp_project_target_pkey PRIMARY KEY (organization_id, project_target_id);

ALTER TABLE ONLY cp_projection_deferred_revision
    ADD CONSTRAINT cp_projection_deferred_revision_pkey PRIMARY KEY (organization_id, run_id, projection_revision);

ALTER TABLE ONLY cp_projection_delivery_watermark
    ADD CONSTRAINT cp_projection_delivery_watermark_pkey PRIMARY KEY (intent_id, delivery_state, delivery_revision);

ALTER TABLE ONLY cp_projection_delivery_watermark
    ADD CONSTRAINT cp_projection_delivery_watermark_run_event_key UNIQUE (organization_id, run_id, event_sequence);

ALTER TABLE ONLY cp_projection_event_cursor
    ADD CONSTRAINT cp_projection_event_cursor_pkey PRIMARY KEY (organization_id, run_id);

ALTER TABLE ONLY cp_provider_delivery_intent
    ADD CONSTRAINT cp_provider_delivery_intent_idempotency_key UNIQUE (organization_id, scope_kind, scope_id, provider_id, provider_instance_id, idempotency_key);

ALTER TABLE ONLY cp_provider_delivery_intent
    ADD CONSTRAINT cp_provider_delivery_intent_journal_digest_key UNIQUE (journal_intent_digest);

ALTER TABLE ONLY cp_provider_delivery_intent
    ADD CONSTRAINT cp_provider_delivery_intent_pkey PRIMARY KEY (intent_id);

ALTER TABLE ONLY cp_provider_delivery_truth_lock
    ADD CONSTRAINT cp_provider_delivery_truth_lock_pkey PRIMARY KEY (current_truth_key);

ALTER TABLE ONLY cp_publication_candidate
    ADD CONSTRAINT cp_publication_candidate_organization_run_attempt_key UNIQUE (organization_id, run_id, attempt_id);

ALTER TABLE ONLY cp_publication_candidate
    ADD CONSTRAINT cp_publication_candidate_pkey PRIMARY KEY (organization_id, candidate_id);

ALTER TABLE ONLY cp_runner_credential
    ADD CONSTRAINT cp_runner_credential_organization_id_runner_id_credential_g_key UNIQUE (organization_id, runner_id, credential_generation);

ALTER TABLE ONLY cp_runner_credential
    ADD CONSTRAINT cp_runner_credential_pkey PRIMARY KEY (organization_id, credential_id);

ALTER TABLE ONLY cp_runner_credential
    ADD CONSTRAINT cp_runner_credential_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY cp_runner_operation
    ADD CONSTRAINT cp_runner_operation_pkey PRIMARY KEY (organization_id, operation_id);

ALTER TABLE ONLY cp_runner
    ADD CONSTRAINT cp_runner_organization_id_current_credential_id_key UNIQUE (organization_id, current_credential_id);

ALTER TABLE ONLY cp_runner
    ADD CONSTRAINT cp_runner_organization_id_key UNIQUE (organization_id);

ALTER TABLE ONLY cp_runner
    ADD CONSTRAINT cp_runner_pkey PRIMARY KEY (organization_id, runner_id);

ALTER TABLE ONLY cp_runner_readiness
    ADD CONSTRAINT cp_runner_readiness_organization_id_runner_id_receipt_diges_key UNIQUE (organization_id, runner_id, receipt_digest);

ALTER TABLE ONLY cp_runner_readiness
    ADD CONSTRAINT cp_runner_readiness_pkey PRIMARY KEY (organization_id, receipt_id);

ALTER TABLE ONLY cp_session
    ADD CONSTRAINT cp_session_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY cp_session
    ADD CONSTRAINT cp_session_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY cp_slack_action_authority
    ADD CONSTRAINT cp_slack_action_authority_action_token_hash_key UNIQUE (action_token_hash);

ALTER TABLE ONLY cp_slack_action_authority
    ADD CONSTRAINT cp_slack_action_authority_pkey PRIMARY KEY (organization_id, action_id);

ALTER TABLE ONLY cp_slack_binding
    ADD CONSTRAINT cp_slack_binding_organization_id_binding_id_installation_id_key UNIQUE (organization_id, binding_id, installation_id);

ALTER TABLE ONLY cp_slack_binding
    ADD CONSTRAINT cp_slack_binding_organization_id_installation_id_key UNIQUE (organization_id, installation_id);

ALTER TABLE ONLY cp_slack_binding
    ADD CONSTRAINT cp_slack_binding_pkey PRIMARY KEY (organization_id, binding_id);

ALTER TABLE ONLY cp_slack_binding
    ADD CONSTRAINT cp_slack_binding_route_identity_key UNIQUE (route_identity);

ALTER TABLE ONLY cp_slack_binding
    ADD CONSTRAINT cp_slack_binding_team_id_app_id_channel_id_key UNIQUE (team_id, app_id, channel_id);

ALTER TABLE ONLY cp_source_content_invalidation_receipt
    ADD CONSTRAINT cp_source_content_invalidation_receipt_pkey PRIMARY KEY (organization_id, command_id);

ALTER TABLE ONLY cp_source_content
    ADD CONSTRAINT cp_source_content_pkey PRIMARY KEY (organization_id, content_id);

ALTER TABLE ONLY cp_source_content_read_grant
    ADD CONSTRAINT cp_source_content_read_grant_pkey PRIMARY KEY (grant_id);

ALTER TABLE ONLY cp_source_content_read_grant
    ADD CONSTRAINT cp_source_content_read_grant_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY cp_source_replay_tombstone
    ADD CONSTRAINT cp_source_replay_tombstone_pkey PRIMARY KEY (organization_id, replay_identity_digest);

CREATE INDEX cp_effect_dispatch_idx ON cp_effect USING btree (organization_id, runner_id, state, requested_at, effect_id);

CREATE INDEX cp_effect_evidence_chain_idx ON cp_effect_evidence USING btree (organization_id, effect_id, sequence DESC);

CREATE UNIQUE INDEX cp_effect_execute_attempt_key ON cp_effect_attempt USING btree (organization_id, effect_id, effect_attempt_number) WHERE (permit_kind = 'execute'::text);

CREATE INDEX cp_hosted_audit_run_idx ON cp_hosted_audit_event USING btree (organization_id, run_id, sequence_id);

CREATE INDEX cp_hosted_run_claim_idx ON cp_hosted_run USING btree (organization_id, runner_id, state, created_at);

CREATE INDEX cp_hosted_run_queue_deadline_idx ON cp_hosted_run USING btree (queue_claim_deadline, organization_id) WHERE (state = 'queued'::text);

CREATE INDEX cp_hosted_run_source_version_idx ON cp_hosted_run USING btree (organization_id, source_version_ref, state);

CREATE INDEX cp_ingress_reservation_pending_idx ON cp_ingress_reservation USING btree (state, created_at);

CREATE INDEX cp_job_claim_idx ON cp_job USING btree (state, available_at, created_at);

CREATE INDEX cp_job_terminal_retention_idx ON cp_job USING btree (job_kind, state, settled_at, job_id) WHERE (state = ANY (ARRAY['succeeded'::text, 'failed'::text]));

CREATE INDEX cp_login_throttle_locked_until_idx ON cp_login_throttle USING btree (locked_until) WHERE (locked_until IS NOT NULL);

CREATE INDEX cp_login_throttle_updated_at_idx ON cp_login_throttle USING btree (updated_at);

CREATE INDEX cp_management_audit_tenant_idx ON cp_management_audit_event USING btree (organization_id, sequence_id);

CREATE INDEX cp_material_action_run_idx ON cp_material_action_receipt USING btree (organization_id, run_id, created_at, receipt_id);

CREATE INDEX cp_permission_current_idx ON cp_permission_request USING btree (organization_id, run_id, state, updated_at DESC);

CREATE INDEX cp_provider_delivery_claim_idx ON cp_provider_delivery_intent USING btree (state, lease_expires_at, created_at, intent_id);

CREATE INDEX cp_provider_delivery_external_resource_idx ON cp_provider_delivery_intent USING btree (run_id, status_message_id, provider_id, provider_instance_id, external_resource_id);

CREATE UNIQUE INDEX cp_provider_delivery_one_terminal_idx ON cp_provider_delivery_intent USING btree (current_truth_key) WHERE (presentation_phase = 'terminal'::text);

CREATE INDEX cp_publication_candidate_run_idx ON cp_publication_candidate USING btree (organization_id, run_id);

CREATE INDEX cp_runner_readiness_current_idx ON cp_runner_readiness USING btree (organization_id, runner_id, observed_at DESC);

CREATE INDEX cp_slack_action_authority_family_idx ON cp_slack_action_authority USING btree (organization_id, authority_family_id, claim_state);

CREATE INDEX cp_slack_action_authority_lookup_idx ON cp_slack_action_authority USING btree (organization_id, installation_id, channel_id, thread_root_message_id);

CREATE UNIQUE INDEX cp_source_content_grant_attempt_key ON cp_source_content_read_grant USING btree (organization_id, run_id, attempt_id);

CREATE INDEX cp_source_content_purge_idx ON cp_source_content USING btree (terminal_at, expires_at);

CREATE INDEX cp_source_content_read_grant_active_idx ON cp_source_content_read_grant USING btree (organization_id, expires_at) WHERE ((consumed_at IS NULL) AND (revoked_at IS NULL));

CREATE INDEX cp_source_content_source_version_idx ON cp_source_content USING btree (organization_id, source_version_ref, content_id);

CREATE UNIQUE INDEX cp_source_replay_tombstone_command_idx ON cp_source_replay_tombstone USING btree (organization_id, command_id) WHERE (command_id IS NOT NULL);

CREATE INDEX cp_source_replay_tombstone_expiry_idx ON cp_source_replay_tombstone USING btree (expires_at);

CREATE TRIGGER cp_candidate_projection_trigger AFTER INSERT OR UPDATE ON cp_publication_candidate FOR EACH ROW EXECUTE FUNCTION cp_related_projection_after();

CREATE TRIGGER cp_delivery_projection_trigger AFTER UPDATE ON cp_provider_delivery_intent FOR EACH ROW EXECUTE FUNCTION cp_delivery_projection_after();

CREATE TRIGGER cp_effect_approval_immutable BEFORE UPDATE ON cp_effect FOR EACH ROW EXECUTE FUNCTION cp_reject_effect_approval_rewrite();

CREATE TRIGGER cp_effect_attempt_immutable BEFORE DELETE OR UPDATE ON cp_effect_attempt FOR EACH ROW EXECUTE FUNCTION cp_reject_effect_authority_mutation();

CREATE TRIGGER cp_effect_delete_immutable BEFORE DELETE ON cp_effect FOR EACH ROW EXECUTE FUNCTION cp_reject_effect_authority_mutation();

CREATE TRIGGER cp_effect_evidence_immutable BEFORE DELETE OR UPDATE ON cp_effect_evidence FOR EACH ROW EXECUTE FUNCTION cp_reject_effect_authority_mutation();

CREATE TRIGGER cp_effect_projection AFTER INSERT OR UPDATE OF state, current_attempt_number, current_evidence_digest, external_resource, reason_code ON cp_effect FOR EACH ROW EXECUTE FUNCTION cp_project_effect_change();

CREATE TRIGGER cp_effect_reconciliation_origin BEFORE INSERT ON cp_effect_attempt FOR EACH ROW EXECUTE FUNCTION cp_guard_effect_reconciliation_origin();

CREATE TRIGGER cp_effect_request_immutable BEFORE UPDATE ON cp_effect FOR EACH ROW EXECUTE FUNCTION cp_reject_effect_request_mutation();

CREATE TRIGGER cp_effect_state_transition BEFORE UPDATE ON cp_effect FOR EACH ROW EXECUTE FUNCTION cp_guard_effect_state_transition();

CREATE TRIGGER cp_hosted_attempt_claim_immutable BEFORE UPDATE OF claim_operation_id, claim_request_digest, claim ON cp_hosted_attempt FOR EACH ROW EXECUTE FUNCTION cp_reject_hosted_attempt_claim_mutation();

CREATE TRIGGER cp_hosted_run_cancel_unpermitted_effects AFTER UPDATE OF terminal_kind ON cp_hosted_run FOR EACH ROW EXECUTE FUNCTION cp_cancel_unpermitted_effects_after_work_terminal();

CREATE TRIGGER cp_hosted_run_frozen_admission_guard BEFORE UPDATE ON cp_hosted_run FOR EACH ROW EXECUTE FUNCTION cp_hosted_run_frozen_admission_guard();

CREATE TRIGGER cp_hosted_run_projection_after_trigger AFTER INSERT OR UPDATE ON cp_hosted_run FOR EACH ROW EXECUTE FUNCTION cp_hosted_run_projection_after();

CREATE TRIGGER cp_hosted_run_projection_before_trigger BEFORE UPDATE ON cp_hosted_run FOR EACH ROW EXECUTE FUNCTION cp_hosted_run_projection_before();

CREATE TRIGGER cp_hosted_run_source_content_terminal_after AFTER UPDATE OF terminal_kind ON cp_hosted_run FOR EACH ROW EXECUTE FUNCTION cp_hosted_run_source_content_terminal_after();

CREATE TRIGGER cp_job_terminal_immutable BEFORE UPDATE ON cp_job FOR EACH ROW WHEN ((old.state = ANY (ARRAY['succeeded'::text, 'failed'::text]))) EXECUTE FUNCTION cp_reject_terminal_job_mutation();

CREATE TRIGGER cp_permission_projection_trigger AFTER INSERT OR UPDATE ON cp_permission_request FOR EACH ROW EXECUTE FUNCTION cp_related_projection_after();

CREATE TRIGGER cp_provider_delivery_delete_guard BEFORE DELETE ON cp_provider_delivery_intent FOR EACH ROW EXECUTE FUNCTION cp_provider_delivery_delete_guard();

CREATE TRIGGER cp_provider_delivery_guard BEFORE UPDATE ON cp_provider_delivery_intent FOR EACH ROW EXECUTE FUNCTION cp_provider_delivery_guard();

CREATE TRIGGER cp_publication_candidate_immutable BEFORE DELETE OR UPDATE ON cp_publication_candidate FOR EACH ROW EXECUTE FUNCTION cp_reject_publication_candidate_mutation();

ALTER TABLE ONLY cp_api_key
    ADD CONSTRAINT cp_api_key_created_by_fkey FOREIGN KEY (created_by) REFERENCES cp_operator(operator_id);

ALTER TABLE ONLY cp_api_key
    ADD CONSTRAINT cp_api_key_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);

ALTER TABLE ONLY cp_effect_attempt
    ADD CONSTRAINT cp_effect_attempt_organization_id_effect_id_fkey FOREIGN KEY (organization_id, effect_id) REFERENCES cp_effect(organization_id, effect_id);

ALTER TABLE ONLY cp_effect_attempt
    ADD CONSTRAINT cp_effect_attempt_organization_id_effect_id_original_execu_fkey FOREIGN KEY (organization_id, effect_id, original_execute_permit_id) REFERENCES cp_effect_attempt(organization_id, effect_id, permit_id);

ALTER TABLE ONLY cp_effect_evidence
    ADD CONSTRAINT cp_effect_evidence_organization_id_effect_id_fkey FOREIGN KEY (organization_id, effect_id) REFERENCES cp_effect(organization_id, effect_id);

ALTER TABLE ONLY cp_effect_evidence
    ADD CONSTRAINT cp_effect_evidence_organization_id_effect_id_permit_id_eff_fkey FOREIGN KEY (organization_id, effect_id, permit_id, effect_attempt_number) REFERENCES cp_effect_attempt(organization_id, effect_id, permit_id, effect_attempt_number);

ALTER TABLE ONLY cp_effect
    ADD CONSTRAINT cp_effect_organization_id_candidate_id_fkey FOREIGN KEY (organization_id, candidate_id) REFERENCES cp_publication_candidate(organization_id, candidate_id);

ALTER TABLE ONLY cp_effect
    ADD CONSTRAINT cp_effect_organization_id_project_target_id_fkey FOREIGN KEY (organization_id, project_target_id) REFERENCES cp_project_target(organization_id, project_target_id);

ALTER TABLE ONLY cp_effect
    ADD CONSTRAINT cp_effect_organization_id_run_id_run_attempt_number_run_at_fkey FOREIGN KEY (organization_id, run_id, run_attempt_number, run_attempt_id) REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number, attempt_id);

ALTER TABLE ONLY cp_effect
    ADD CONSTRAINT cp_effect_organization_id_runner_id_fkey FOREIGN KEY (organization_id, runner_id) REFERENCES cp_runner(organization_id, runner_id);

ALTER TABLE ONLY cp_hosted_attempt
    ADD CONSTRAINT cp_hosted_attempt_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES cp_hosted_run(organization_id, run_id);

ALTER TABLE ONLY cp_hosted_audit_event
    ADD CONSTRAINT cp_hosted_audit_event_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES cp_hosted_run(organization_id, run_id);

ALTER TABLE ONLY cp_hosted_lifecycle_receipt
    ADD CONSTRAINT cp_hosted_lifecycle_receipt_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES cp_hosted_run(organization_id, run_id);

ALTER TABLE ONLY cp_hosted_run
    ADD CONSTRAINT cp_hosted_run_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);

ALTER TABLE ONLY cp_hosted_run
    ADD CONSTRAINT cp_hosted_run_organization_id_runner_id_fkey FOREIGN KEY (organization_id, runner_id) REFERENCES cp_runner(organization_id, runner_id);

ALTER TABLE ONLY cp_ingress_reservation
    ADD CONSTRAINT cp_ingress_reservation_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);

ALTER TABLE ONLY cp_ingress_reservation
    ADD CONSTRAINT cp_ingress_reservation_slack_binding_fkey FOREIGN KEY (organization_id, binding_id, installation_id) REFERENCES cp_slack_binding(organization_id, binding_id, installation_id);

ALTER TABLE ONLY cp_job
    ADD CONSTRAINT cp_job_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);

ALTER TABLE ONLY cp_management_audit_event
    ADD CONSTRAINT cp_management_audit_event_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);

ALTER TABLE ONLY cp_material_action_begin_intent
    ADD CONSTRAINT cp_material_action_begin_inte_organization_id_run_id_attem_fkey FOREIGN KEY (organization_id, run_id, attempt_number) REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number);

ALTER TABLE ONLY cp_material_action_current
    ADD CONSTRAINT cp_material_action_current_organization_id_receipt_id_fkey FOREIGN KEY (organization_id, receipt_id) REFERENCES cp_material_action_receipt(organization_id, receipt_id);

ALTER TABLE ONLY cp_material_action_receipt
    ADD CONSTRAINT cp_material_action_receipt_organization_id_run_id_attempt__fkey FOREIGN KEY (organization_id, run_id, attempt_number) REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number);

ALTER TABLE ONLY cp_material_action_receipt
    ADD CONSTRAINT cp_material_action_receipt_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES cp_hosted_run(organization_id, run_id);

ALTER TABLE ONLY cp_membership
    ADD CONSTRAINT cp_membership_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES cp_operator(operator_id);

ALTER TABLE ONLY cp_membership
    ADD CONSTRAINT cp_membership_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);

ALTER TABLE ONLY cp_permission_operation
    ADD CONSTRAINT cp_permission_operation_organization_id_permission_request_fkey FOREIGN KEY (organization_id, permission_request_id) REFERENCES cp_permission_request(organization_id, permission_request_id);

ALTER TABLE ONLY cp_permission_request
    ADD CONSTRAINT cp_permission_request_organization_id_run_id_attempt_numbe_fkey FOREIGN KEY (organization_id, run_id, attempt_number) REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number);

ALTER TABLE ONLY cp_permission_request
    ADD CONSTRAINT cp_permission_request_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES cp_hosted_run(organization_id, run_id);

ALTER TABLE ONLY cp_project_target
    ADD CONSTRAINT cp_project_target_organization_id_runner_id_fkey FOREIGN KEY (organization_id, runner_id) REFERENCES cp_runner(organization_id, runner_id);

ALTER TABLE ONLY cp_projection_deferred_revision
    ADD CONSTRAINT cp_projection_deferred_revision_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES cp_hosted_run(organization_id, run_id);

ALTER TABLE ONLY cp_projection_delivery_watermark
    ADD CONSTRAINT cp_projection_delivery_watermark_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES cp_hosted_run(organization_id, run_id);

ALTER TABLE ONLY cp_projection_event_cursor
    ADD CONSTRAINT cp_projection_event_cursor_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES cp_hosted_run(organization_id, run_id);

ALTER TABLE ONLY cp_publication_candidate
    ADD CONSTRAINT cp_publication_candidate_attempt_fk FOREIGN KEY (organization_id, run_id, attempt_number, attempt_id) REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number, attempt_id);

ALTER TABLE ONLY cp_publication_candidate
    ADD CONSTRAINT cp_publication_candidate_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);

ALTER TABLE ONLY cp_runner_credential
    ADD CONSTRAINT cp_runner_credential_organization_id_runner_id_fkey FOREIGN KEY (organization_id, runner_id) REFERENCES cp_runner(organization_id, runner_id);

ALTER TABLE ONLY cp_runner_operation
    ADD CONSTRAINT cp_runner_operation_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);

ALTER TABLE ONLY cp_runner
    ADD CONSTRAINT cp_runner_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);

ALTER TABLE ONLY cp_runner_readiness
    ADD CONSTRAINT cp_runner_readiness_organization_id_runner_id_fkey FOREIGN KEY (organization_id, runner_id) REFERENCES cp_runner(organization_id, runner_id);

ALTER TABLE ONLY cp_session
    ADD CONSTRAINT cp_session_membership_fk FOREIGN KEY (organization_id, operator_id) REFERENCES cp_membership(organization_id, operator_id);

ALTER TABLE ONLY cp_session
    ADD CONSTRAINT cp_session_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES cp_operator(operator_id);

ALTER TABLE ONLY cp_slack_action_authority
    ADD CONSTRAINT cp_slack_action_authority_slack_binding_fkey FOREIGN KEY (organization_id, binding_id, installation_id) REFERENCES cp_slack_binding(organization_id, binding_id, installation_id) ON DELETE CASCADE;

ALTER TABLE ONLY cp_slack_binding
    ADD CONSTRAINT cp_slack_binding_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);

ALTER TABLE ONLY cp_source_content_invalidation_receipt
    ADD CONSTRAINT cp_source_content_invalidation_receipt_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);

ALTER TABLE ONLY cp_source_content
    ADD CONSTRAINT cp_source_content_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);

ALTER TABLE ONLY cp_source_content_read_grant
    ADD CONSTRAINT cp_source_content_read_grant_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);

ALTER TABLE ONLY cp_source_replay_tombstone
    ADD CONSTRAINT cp_source_replay_tombstone_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id);
