ALTER TABLE cp_hosted_run ADD COLUMN projection_revision integer NOT NULL DEFAULT 1;
ALTER TABLE cp_provider_delivery_intent ADD COLUMN projection_revision integer;
ALTER TABLE cp_slack_action_authority ADD COLUMN authority_family_id text,
  ADD COLUMN authority_epoch integer, ADD COLUMN claim_state text,
  ADD COLUMN claimed_at timestamptz;
UPDATE cp_slack_action_authority SET authority_family_id=action_id,
  authority_epoch=projection_generation,
  claim_state=CASE WHEN consumed_at IS NULL THEN 'available' ELSE 'consumed' END;
ALTER TABLE cp_slack_action_authority ALTER COLUMN authority_family_id SET NOT NULL,
  ALTER COLUMN authority_epoch SET NOT NULL, ALTER COLUMN claim_state SET NOT NULL,
  ADD CONSTRAINT cp_slack_action_authority_epoch_check CHECK(authority_epoch>0),
  ADD CONSTRAINT cp_slack_action_authority_claim_state_check CHECK(claim_state IN ('available','claimed','consumed')),
  ADD CONSTRAINT cp_slack_action_authority_claim_shape_check CHECK(
    (claim_state='available' AND claimed_at IS NULL AND consumed_at IS NULL)
    OR (claim_state='claimed' AND claimed_at IS NOT NULL AND consumed_at IS NULL)
    OR (claim_state='consumed' AND consumed_at IS NOT NULL));
CREATE INDEX cp_slack_action_authority_family_idx
  ON cp_slack_action_authority(organization_id,authority_family_id,claim_state);
CREATE FUNCTION cp_enqueue_team_relay_projection(p_org text,p_run text,p_revision integer)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO cp_job(job_id,organization_id,job_kind,payload,request_digest,state,
    available_at,attempt_count,max_attempts,created_at,updated_at)
  VALUES('team-relay:'||p_org||':'||p_run||':'||p_revision,p_org,'team-relay.project',
    jsonb_build_object('organizationId',p_org,'runId',p_run,'projectionRevision',p_revision),
    md5(p_org||':'||p_run||':'||p_revision),'pending',clock_timestamp(),0,20,clock_timestamp(),clock_timestamp())
  ON CONFLICT(job_id) DO NOTHING;
END $$;
CREATE FUNCTION cp_hosted_run_projection_before() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND NEW.projection_revision=OLD.projection_revision
    AND (to_jsonb(NEW)-'projection_revision') IS DISTINCT FROM (to_jsonb(OLD)-'projection_revision') THEN
    NEW.projection_revision:=OLD.projection_revision+1;
  END IF; RETURN NEW;
END $$;
CREATE FUNCTION cp_hosted_run_projection_after() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  PERFORM cp_enqueue_team_relay_projection(NEW.organization_id,NEW.run_id,NEW.projection_revision); RETURN NEW;
END $$;
CREATE TRIGGER cp_hosted_run_projection_before_trigger BEFORE UPDATE ON cp_hosted_run
FOR EACH ROW EXECUTE FUNCTION cp_hosted_run_projection_before();
CREATE TRIGGER cp_hosted_run_projection_after_trigger AFTER INSERT OR UPDATE ON cp_hosted_run
FOR EACH ROW EXECUTE FUNCTION cp_hosted_run_projection_after();
CREATE FUNCTION cp_related_projection_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org_id text; target_run text; BEGIN
  org_id:=COALESCE(NEW.organization_id,OLD.organization_id); target_run:=COALESCE(NEW.run_id,OLD.run_id);
  UPDATE cp_hosted_run SET projection_revision=projection_revision+1
    WHERE organization_id=org_id AND run_id=target_run; RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER cp_permission_projection_trigger AFTER INSERT OR UPDATE ON cp_permission_request
FOR EACH ROW EXECUTE FUNCTION cp_related_projection_after();
CREATE TRIGGER cp_candidate_projection_trigger AFTER INSERT OR UPDATE ON cp_publication_candidate
FOR EACH ROW EXECUTE FUNCTION cp_related_projection_after();
CREATE TRIGGER cp_publication_intent_projection_trigger AFTER INSERT OR UPDATE ON cp_publication_intent
FOR EACH ROW EXECUTE FUNCTION cp_related_projection_after();
CREATE FUNCTION cp_delivery_projection_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision integer; BEGIN
  IF NEW.run_id IS NOT NULL AND NEW.state IS DISTINCT FROM OLD.state THEN
    SELECT projection_revision INTO revision FROM cp_hosted_run
      WHERE organization_id=NEW.organization_id AND run_id=NEW.run_id;
    IF revision IS NOT NULL THEN PERFORM cp_enqueue_team_relay_projection(NEW.organization_id,NEW.run_id,revision); END IF;
  END IF; RETURN NEW;
END $$;
CREATE TRIGGER cp_delivery_projection_trigger AFTER UPDATE ON cp_provider_delivery_intent
FOR EACH ROW EXECUTE FUNCTION cp_delivery_projection_after();
