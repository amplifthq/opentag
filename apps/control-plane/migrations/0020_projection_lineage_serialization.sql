LOCK TABLE cp_provider_delivery_intent IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO cp_projection_event_cursor(organization_id,run_id,current_sequence)
SELECT organization_id,run_id,max(event_sequence)
FROM cp_projection_delivery_watermark
GROUP BY organization_id,run_id
ON CONFLICT(organization_id,run_id) DO UPDATE
SET current_sequence=GREATEST(cp_projection_event_cursor.current_sequence,EXCLUDED.current_sequence);

DO $$
DECLARE missing record; repaired_sequence integer; repaired_job_id text;
BEGIN
  FOR missing IN
    SELECT delivery.organization_id,delivery.run_id,delivery.intent_id,
      delivery.state delivery_state,delivery.revision delivery_revision,
      run.projection_revision,delivery.outcome_recorded_at
    FROM cp_provider_delivery_intent delivery
    JOIN cp_hosted_run run ON run.organization_id=delivery.organization_id AND run.run_id=delivery.run_id
    WHERE delivery.projection_purpose='external'
      AND delivery.state IN ('accepted','rejected','outcome_unknown','attention')
      AND NOT EXISTS(SELECT 1 FROM cp_projection_delivery_watermark watermark
        WHERE watermark.intent_id=delivery.intent_id
          AND watermark.delivery_state=delivery.state AND watermark.delivery_revision=delivery.revision)
    ORDER BY delivery.organization_id,delivery.run_id,delivery.outcome_recorded_at,delivery.intent_id
  LOOP
    INSERT INTO cp_projection_event_cursor(organization_id,run_id,current_sequence)
      VALUES(missing.organization_id,missing.run_id,1)
      ON CONFLICT(organization_id,run_id) DO UPDATE
        SET current_sequence=cp_projection_event_cursor.current_sequence+1
      RETURNING current_sequence INTO repaired_sequence;
    INSERT INTO cp_projection_delivery_watermark(organization_id,run_id,intent_id,delivery_state,
      delivery_revision,projection_revision,event_sequence,created_at)
      VALUES(missing.organization_id,missing.run_id,missing.intent_id,missing.delivery_state,
        missing.delivery_revision,missing.projection_revision,repaired_sequence,
        COALESCE(missing.outcome_recorded_at,clock_timestamp()));
    repaired_job_id:='team-relay-delivery:'||missing.organization_id||':'||missing.run_id||':'||repaired_sequence;
    INSERT INTO cp_job(job_id,organization_id,job_kind,payload,request_digest,state,available_at,
      attempt_count,max_attempts,created_at,updated_at)
      VALUES(repaired_job_id,missing.organization_id,'team-relay.project',jsonb_build_object(
        'organizationId',missing.organization_id,'runId',missing.run_id,
        'projectionRevision',missing.projection_revision,'deliveryIntentId',missing.intent_id,
        'deliveryRevision',missing.delivery_revision,'eventSequence',repaired_sequence),
        md5(repaired_job_id),'pending',clock_timestamp(),0,20,clock_timestamp(),clock_timestamp())
      ON CONFLICT(job_id) DO NOTHING;
  END LOOP;
END $$;

UPDATE cp_job job SET payload=job.payload||jsonb_build_object('eventSequence',watermark.event_sequence),
  updated_at=clock_timestamp()
FROM cp_projection_delivery_watermark watermark
WHERE job.job_kind='team-relay.project' AND job.state IN ('pending','claimed')
  AND job.payload ? 'deliveryIntentId' AND job.payload ? 'deliveryRevision'
  AND NOT job.payload ? 'eventSequence'
  AND watermark.organization_id=job.organization_id
  AND watermark.organization_id=job.payload->>'organizationId'
  AND watermark.run_id=job.payload->>'runId'
  AND watermark.intent_id=job.payload->>'deliveryIntentId'
  AND watermark.delivery_revision=(job.payload->>'deliveryRevision')::integer;

CREATE TABLE cp_provider_delivery_truth_lock(
  current_truth_key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO cp_provider_delivery_truth_lock(current_truth_key,created_at)
SELECT DISTINCT current_truth_key,min(created_at) FROM cp_provider_delivery_intent
GROUP BY current_truth_key ON CONFLICT(current_truth_key) DO NOTHING;
