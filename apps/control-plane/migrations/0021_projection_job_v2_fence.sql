LOCK TABLE cp_job IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM cp_job WHERE job_kind='team-relay.project' AND state='claimed') THEN
    RAISE EXCEPTION 'projection_v2_legacy_job_claimed';
  END IF;
END $$;

CREATE TABLE cp_projection_job_v2_authority(
  authority_version integer PRIMARY KEY CHECK(authority_version=2),
  activated_at timestamptz NOT NULL
);
INSERT INTO cp_projection_job_v2_authority VALUES(2,clock_timestamp());

WITH quarantined AS (
  UPDATE cp_job job SET state='failed',last_error_code='projection_v2_nonterminal_legacy_quarantined',
    updated_at=clock_timestamp()
  WHERE job.job_kind='team-relay.project' AND job.state='pending'
    AND job.payload ?& ARRAY['deliveryIntentId','deliveryRevision','eventSequence']
    AND EXISTS(SELECT 1 FROM cp_projection_delivery_watermark watermark
      WHERE watermark.organization_id=job.payload->>'organizationId'
        AND watermark.run_id=job.payload->>'runId'
        AND watermark.intent_id=job.payload->>'deliveryIntentId'
        AND watermark.delivery_revision=(job.payload->>'deliveryRevision')::integer
        AND watermark.projection_revision=(job.payload->>'projectionRevision')::integer
        AND watermark.event_sequence=(job.payload->>'eventSequence')::integer
        AND watermark.delivery_state NOT IN ('accepted','rejected','outcome_unknown','attention'))
    AND NOT EXISTS(SELECT 1 FROM cp_projection_delivery_watermark watermark
      WHERE watermark.organization_id=job.payload->>'organizationId'
        AND watermark.run_id=job.payload->>'runId'
        AND watermark.intent_id=job.payload->>'deliveryIntentId'
        AND watermark.delivery_revision=(job.payload->>'deliveryRevision')::integer
        AND watermark.projection_revision=(job.payload->>'projectionRevision')::integer
        AND watermark.event_sequence=(job.payload->>'eventSequence')::integer
        AND watermark.delivery_state IN ('accepted','rejected','outcome_unknown','attention'))
  RETURNING job_id)
INSERT INTO cp_job_settlement(job_id,lease_token,outcome,settled_at)
SELECT job_id,'migration:0021',jsonb_build_object(
  'errorCode','projection_v2_nonterminal_legacy_quarantined'),clock_timestamp() FROM quarantined;

DO $$
DECLARE legacy record; matches integer; durable_state text; upgraded_payload jsonb;
BEGIN
  FOR legacy IN SELECT * FROM cp_job
    WHERE job_kind='team-relay.project' AND state='pending' ORDER BY job_id FOR UPDATE
  LOOP
    IF jsonb_typeof(legacy.payload)<>'object'
      OR NOT (legacy.payload ?& ARRAY['organizationId','runId','projectionRevision'])
      OR jsonb_typeof(legacy.payload->'organizationId')<>'string'
      OR jsonb_typeof(legacy.payload->'runId')<>'string'
      OR jsonb_typeof(legacy.payload->'projectionRevision')<>'number'
      OR (legacy.payload->>'projectionRevision')::integer<=0
      OR legacy.organization_id IS DISTINCT FROM legacy.payload->>'organizationId' THEN
      RAISE EXCEPTION 'projection_v2_legacy_payload_invalid';
    END IF;
    IF legacy.payload ?| ARRAY['deliveryIntentId','deliveryRevision','eventSequence','deliveryState'] THEN
      IF NOT (legacy.payload ?& ARRAY['deliveryIntentId','deliveryRevision','eventSequence'])
        OR legacy.payload ? 'deliveryState'
        OR (SELECT count(*) FROM jsonb_object_keys(legacy.payload))<>6 THEN
        RAISE EXCEPTION 'projection_v2_legacy_payload_invalid';
      END IF;
      SELECT count(*),min(delivery_state) INTO matches,durable_state
      FROM cp_projection_delivery_watermark
      WHERE organization_id=legacy.payload->>'organizationId'
        AND run_id=legacy.payload->>'runId'
        AND intent_id=legacy.payload->>'deliveryIntentId'
        AND delivery_revision=(legacy.payload->>'deliveryRevision')::integer
        AND projection_revision=(legacy.payload->>'projectionRevision')::integer
        AND event_sequence=(legacy.payload->>'eventSequence')::integer
        AND delivery_state IN ('accepted','rejected','outcome_unknown','attention');
      IF matches<>1 THEN RAISE EXCEPTION 'projection_v2_legacy_event_ambiguous'; END IF;
      upgraded_payload:=legacy.payload||jsonb_build_object('deliveryState',durable_state);
    ELSE
      IF (SELECT count(*) FROM jsonb_object_keys(legacy.payload))<>3 THEN
        RAISE EXCEPTION 'projection_v2_legacy_payload_invalid';
      END IF;
      upgraded_payload:=legacy.payload;
    END IF;
    UPDATE cp_job SET job_kind='team-relay.project.v2',payload=upgraded_payload,
      request_digest=md5(job_id||':'||upgraded_payload::text),updated_at=clock_timestamp()
      WHERE job_id=legacy.job_id;
  END LOOP;
END $$;

CREATE FUNCTION cp_insert_team_relay_v2_job(p_job text,p_org text,p_payload jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE expected_digest text; existing cp_job%ROWTYPE; settlement_count integer;
BEGIN
  expected_digest:=md5(p_job||':'||p_payload::text);
  INSERT INTO cp_job(job_id,organization_id,job_kind,payload,request_digest,state,available_at,
    attempt_count,max_attempts,created_at,updated_at)
  VALUES(p_job,p_org,'team-relay.project.v2',p_payload,expected_digest,'pending',clock_timestamp(),
    0,20,clock_timestamp(),clock_timestamp()) ON CONFLICT(job_id) DO NOTHING;
  IF FOUND THEN RETURN; END IF;
  SELECT * INTO existing FROM cp_job WHERE job_id=p_job FOR UPDATE;
  IF existing.organization_id IS DISTINCT FROM p_org
    OR existing.job_kind<>'team-relay.project.v2' OR existing.payload<>p_payload
    OR existing.request_digest<>expected_digest THEN
    RAISE EXCEPTION 'projection_v2_job_identity_conflict';
  END IF;
  SELECT count(*) INTO settlement_count FROM cp_job_settlement WHERE job_id=p_job;
  IF (existing.state='pending' AND (existing.lease_owner IS NOT NULL OR existing.lease_token IS NOT NULL
        OR existing.lease_expires_at IS NOT NULL OR settlement_count<>0))
    OR (existing.state='claimed' AND (existing.lease_owner IS NULL OR existing.lease_token IS NULL
        OR existing.lease_expires_at IS NULL OR settlement_count<>0))
    OR (existing.state IN ('succeeded','failed') AND (existing.lease_owner IS NOT NULL
        OR existing.lease_token IS NOT NULL OR existing.lease_expires_at IS NOT NULL OR settlement_count<>1)) THEN
    RAISE EXCEPTION 'projection_v2_job_state_conflict';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION cp_enqueue_team_relay_projection(p_org text,p_run text,p_revision integer)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  PERFORM cp_insert_team_relay_v2_job('team-relay:'||p_org||':'||p_run||':'||p_revision,p_org,
    jsonb_build_object('organizationId',p_org,'runId',p_run,'projectionRevision',p_revision));
END $$;

CREATE OR REPLACE FUNCTION cp_delivery_projection_after() RETURNS trigger LANGUAGE plpgsql AS $$
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
