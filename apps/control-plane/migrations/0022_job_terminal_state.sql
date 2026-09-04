ALTER TABLE cp_job
  ADD COLUMN settlement_lease_token text,
  ADD COLUMN settlement_outcome jsonb,
  ADD COLUMN settled_at timestamptz;

UPDATE cp_job job
SET settlement_lease_token = settlement.lease_token,
    settlement_outcome = settlement.outcome,
    settled_at = settlement.settled_at
FROM cp_job_settlement settlement
WHERE settlement.job_id = job.job_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cp_job job
    WHERE (
      job.state IN ('succeeded', 'failed')
      AND (
        job.settlement_lease_token IS NULL
        OR job.settlement_outcome IS NULL
        OR job.settled_at IS NULL
      )
    ) OR (
      job.state IN ('pending', 'claimed')
      AND (
        job.settlement_lease_token IS NOT NULL
        OR job.settlement_outcome IS NOT NULL
        OR job.settled_at IS NOT NULL
      )
    )
  ) THEN
    RAISE EXCEPTION 'job_terminal_state_upgrade_invalid';
  END IF;
END;
$$;

DROP TABLE cp_job_settlement;

ALTER TABLE cp_job
  ADD CONSTRAINT cp_job_state_shape_check CHECK (
    (
      state = 'pending'
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND settlement_lease_token IS NULL
      AND settlement_outcome IS NULL
      AND settled_at IS NULL
    )
    OR (
      state = 'claimed'
      AND lease_owner IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND settlement_lease_token IS NULL
      AND settlement_outcome IS NULL
      AND settled_at IS NULL
    )
    OR (
      state IN ('succeeded', 'failed')
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND settlement_lease_token IS NOT NULL
      AND settlement_outcome IS NOT NULL
      AND settled_at IS NOT NULL
    )
  );

CREATE FUNCTION cp_reject_terminal_job_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'terminal_job_immutable';
END;
$$;

CREATE TRIGGER cp_job_terminal_immutable
BEFORE UPDATE ON cp_job
FOR EACH ROW
WHEN (OLD.state IN ('succeeded', 'failed'))
EXECUTE FUNCTION cp_reject_terminal_job_mutation();

CREATE OR REPLACE FUNCTION cp_insert_team_relay_v2_job(
  p_job text,
  p_org text,
  p_payload jsonb
) RETURNS void LANGUAGE plpgsql AS $$
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
