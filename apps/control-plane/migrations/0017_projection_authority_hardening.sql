ALTER TABLE cp_slack_action_authority DROP CONSTRAINT cp_slack_action_authority_decisions_check;
UPDATE cp_slack_action_authority SET
  claim_state='consumed',claimed_at=COALESCE(claimed_at,clock_timestamp()),
  consumed_at=COALESCE(consumed_at,clock_timestamp()),allowed_decisions=ARRAY['publication_approve']::text[]
  WHERE allowed_decisions <@ ARRAY['publication_reject']::text[];
UPDATE cp_slack_action_authority SET allowed_decisions=array_remove(allowed_decisions,'publication_reject')
  WHERE allowed_decisions @> ARRAY['publication_reject']::text[];
ALTER TABLE cp_slack_action_authority ADD CONSTRAINT cp_slack_action_authority_decisions_check
  CHECK(cardinality(allowed_decisions)>0 AND allowed_decisions <@
    ARRAY['status','cancel','allow_once','allow_run','deny','publication_approve','bind','unbind']::text[]);

ALTER TABLE cp_hosted_run ADD CONSTRAINT cp_hosted_run_projection_revision_check CHECK(projection_revision>0);
UPDATE cp_provider_delivery_intent SET projection_revision=1 WHERE projection_revision IS NULL;
ALTER TABLE cp_provider_delivery_intent ALTER COLUMN projection_revision SET DEFAULT 1,
  ALTER COLUMN projection_revision SET NOT NULL,
  ADD CONSTRAINT cp_provider_delivery_projection_revision_check CHECK(projection_revision>0);

CREATE TABLE cp_projection_delivery_watermark(
  organization_id text NOT NULL,run_id text NOT NULL,intent_id text NOT NULL,
  delivery_state text NOT NULL,delivery_revision integer NOT NULL,projection_revision integer NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(intent_id,delivery_state,delivery_revision),
  FOREIGN KEY(organization_id,run_id) REFERENCES cp_hosted_run(organization_id,run_id),
  CHECK(delivery_revision>0 AND projection_revision>0));

CREATE OR REPLACE FUNCTION cp_delivery_projection_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_projection integer; event_job_id text; BEGIN
  IF NEW.run_id IS NULL OR NEW.state IS NOT DISTINCT FROM OLD.state
    OR NEW.intent_id LIKE 'intent_projection_%' THEN RETURN NEW; END IF;
  SELECT projection_revision INTO current_projection FROM cp_hosted_run
    WHERE organization_id=NEW.organization_id AND run_id=NEW.run_id;
  IF current_projection IS NULL THEN RETURN NEW; END IF;
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
    'deliveryEventId',NEW.intent_id||':'||NEW.revision),md5(event_job_id),'pending',clock_timestamp(),
    0,20,clock_timestamp(),clock_timestamp()) ON CONFLICT(job_id) DO NOTHING;
  RETURN NEW;
END $$;
