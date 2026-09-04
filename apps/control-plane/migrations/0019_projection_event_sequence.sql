ALTER TABLE cp_provider_delivery_intent ADD COLUMN projection_event_sequence integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT cp_provider_delivery_projection_event_sequence_check CHECK(projection_event_sequence>=0);
ALTER TABLE cp_projection_delivery_watermark ADD COLUMN event_sequence integer;
WITH ordered AS (SELECT intent_id,delivery_state,delivery_revision,
  row_number() OVER(PARTITION BY organization_id,run_id ORDER BY created_at,intent_id,delivery_state,delivery_revision) seq
  FROM cp_projection_delivery_watermark)
UPDATE cp_projection_delivery_watermark watermark SET event_sequence=ordered.seq
FROM ordered WHERE watermark.intent_id=ordered.intent_id AND watermark.delivery_state=ordered.delivery_state
  AND watermark.delivery_revision=ordered.delivery_revision;
ALTER TABLE cp_projection_delivery_watermark ALTER COLUMN event_sequence SET NOT NULL,
  ADD CONSTRAINT cp_projection_delivery_watermark_event_sequence_check CHECK(event_sequence>0),
  ADD CONSTRAINT cp_projection_delivery_watermark_run_event_key UNIQUE(organization_id,run_id,event_sequence);
CREATE TABLE cp_projection_event_cursor(organization_id text NOT NULL,run_id text NOT NULL,
  current_sequence integer NOT NULL DEFAULT 0,PRIMARY KEY(organization_id,run_id),
  FOREIGN KEY(organization_id,run_id) REFERENCES cp_hosted_run(organization_id,run_id),
  CHECK(current_sequence>=0));

DROP TRIGGER cp_provider_delivery_guard ON cp_provider_delivery_intent;
UPDATE cp_provider_delivery_intent SET projection_purpose=CASE
  WHEN intent->>'operation'='create' THEN 'anchor_create' ELSE 'anchor_update' END
WHERE projection_purpose='external' AND status_message_id=run_id||':status'
  AND intent->'provenance'->>'kind'='business' AND intent->>'deliveryKind'='message';
CREATE TRIGGER cp_provider_delivery_guard BEFORE UPDATE ON cp_provider_delivery_intent
FOR EACH ROW EXECUTE FUNCTION cp_provider_delivery_guard();

CREATE OR REPLACE FUNCTION cp_delivery_projection_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_projection integer; event_job_id text; deferred_revision integer; event_sequence integer; BEGIN
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
        INSERT INTO cp_job(job_id,organization_id,job_kind,payload,request_digest,state,available_at,
          attempt_count,max_attempts,created_at,updated_at)
        VALUES(event_job_id,NEW.organization_id,'team-relay.project',jsonb_build_object(
          'organizationId',NEW.organization_id,'runId',NEW.run_id,'projectionRevision',deferred_revision),
          md5(event_job_id),'pending',clock_timestamp(),0,20,clock_timestamp(),clock_timestamp())
        ON CONFLICT(job_id) DO NOTHING;
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
    event_sequence,clock_timestamp()) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN NEW; END IF;
  event_job_id:='team-relay-delivery:'||NEW.organization_id||':'||NEW.run_id||':'||event_sequence;
  INSERT INTO cp_job(job_id,organization_id,job_kind,payload,request_digest,state,available_at,
    attempt_count,max_attempts,created_at,updated_at)
  VALUES(event_job_id,NEW.organization_id,'team-relay.project',jsonb_build_object(
    'organizationId',NEW.organization_id,'runId',NEW.run_id,'projectionRevision',current_projection,
    'deliveryIntentId',NEW.intent_id,'deliveryRevision',NEW.revision,'eventSequence',event_sequence),
    md5(event_job_id),'pending',clock_timestamp(),0,20,clock_timestamp(),clock_timestamp())
  ON CONFLICT(job_id) DO NOTHING;
  RETURN NEW;
END $$;
