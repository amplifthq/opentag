ALTER TABLE cp_provider_delivery_intent ADD COLUMN projection_purpose text NOT NULL DEFAULT 'external',
  ADD CONSTRAINT cp_provider_delivery_projection_purpose_check
    CHECK(projection_purpose IN ('external','anchor_create','anchor_update'));

CREATE TABLE cp_projection_deferred_revision(
  organization_id text NOT NULL,run_id text NOT NULL,projection_revision integer NOT NULL,
  anchor_intent_id text NOT NULL,state text NOT NULL,created_at timestamptz NOT NULL,woken_at timestamptz,
  PRIMARY KEY(organization_id,run_id,projection_revision),
  FOREIGN KEY(organization_id,run_id) REFERENCES cp_hosted_run(organization_id,run_id),
  CHECK(projection_revision>0),CHECK(state IN ('pending','woken')),
  CHECK((state='pending' AND woken_at IS NULL) OR (state='woken' AND woken_at IS NOT NULL)));

CREATE OR REPLACE FUNCTION cp_delivery_projection_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_projection integer; event_job_id text; deferred_revision integer; BEGIN
  IF NEW.run_id IS NULL OR NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
  SELECT projection_revision INTO current_projection FROM cp_hosted_run
    WHERE organization_id=NEW.organization_id AND run_id=NEW.run_id;
  IF current_projection IS NULL THEN RETURN NEW; END IF;
  IF NEW.projection_purpose='anchor_update' THEN RETURN NEW; END IF;
  IF NEW.projection_purpose='anchor_create' THEN
    IF NEW.state='accepted' THEN
      WITH candidate AS (SELECT projection_revision FROM cp_projection_deferred_revision
        WHERE organization_id=NEW.organization_id AND run_id=NEW.run_id AND state='pending'
        ORDER BY projection_revision DESC LIMIT 1 FOR UPDATE), woken AS (
        UPDATE cp_projection_deferred_revision deferred SET state='woken',woken_at=clock_timestamp()
        FROM candidate WHERE deferred.organization_id=NEW.organization_id
          AND deferred.run_id=NEW.run_id AND deferred.projection_revision=candidate.projection_revision
        RETURNING deferred.projection_revision)
      SELECT projection_revision INTO deferred_revision FROM woken;
      IF deferred_revision IS NOT NULL THEN
        event_job_id:='team-relay-anchor-wake:'||NEW.organization_id||':'||NEW.run_id||':'||deferred_revision;
        INSERT INTO cp_job(job_id,organization_id,job_kind,payload,request_digest,state,available_at,
          attempt_count,max_attempts,created_at,updated_at)
        VALUES(event_job_id,NEW.organization_id,'team-relay.project',jsonb_build_object(
          'organizationId',NEW.organization_id,'runId',NEW.run_id,'projectionRevision',deferred_revision),
          md5(event_job_id),'pending',clock_timestamp(),0,20,clock_timestamp(),clock_timestamp())
        ON CONFLICT(job_id) DO NOTHING;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  INSERT INTO cp_projection_delivery_watermark(organization_id,run_id,intent_id,delivery_state,
    delivery_revision,projection_revision,created_at)
  VALUES(NEW.organization_id,NEW.run_id,NEW.intent_id,NEW.state,NEW.revision,current_projection,clock_timestamp())
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN NEW; END IF;
  event_job_id:='team-relay-delivery:'||NEW.organization_id||':'||NEW.run_id||':'||NEW.intent_id||':'||NEW.revision;
  INSERT INTO cp_job(job_id,organization_id,job_kind,payload,request_digest,state,available_at,
    attempt_count,max_attempts,created_at,updated_at)
  VALUES(event_job_id,NEW.organization_id,'team-relay.project',jsonb_build_object(
    'organizationId',NEW.organization_id,'runId',NEW.run_id,'projectionRevision',current_projection,
    'deliveryIntentId',NEW.intent_id,'deliveryRevision',NEW.revision),md5(event_job_id),'pending',
    clock_timestamp(),0,20,clock_timestamp(),clock_timestamp()) ON CONFLICT(job_id) DO NOTHING;
  RETURN NEW;
END $$;
