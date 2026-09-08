-- Retain the original ambiguous outcome alongside a fenced, immutable read observation.
ALTER TABLE cp_provider_delivery_intent ADD COLUMN reconciliation_receipt jsonb;

CREATE OR REPLACE FUNCTION cp_provider_delivery_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.state = 'outcome_unknown' AND NEW.state = 'accepted' THEN
    IF NEW.reconciliation_receipt IS NULL OR OLD.reconciliation_receipt IS NOT NULL
      OR NEW.provider_id <> 'slack' OR NEW.revision <> OLD.revision + 1
      OR NEW.reconciliation_receipt->>'kind' IS DISTINCT FROM 'slack_message_observation_v1'
      OR NEW.reconciliation_receipt->>'intentDigest' IS DISTINCT FROM OLD.journal_intent_digest
      OR NEW.reconciliation_receipt->'original'->>'evidenceDigest' IS DISTINCT FROM OLD.evidence_digest
      OR NEW.reconciliation_receipt->'original'->>'errorCode' IS DISTINCT FROM OLD.error_code
      OR NEW.reconciliation_receipt->'observation'->>'outcome' IS DISTINCT FROM 'accepted'
      OR NEW.evidence_digest IS DISTINCT FROM NEW.reconciliation_receipt->'observation'->>'evidenceDigest'
      OR NEW.external_resource_id IS DISTINCT FROM NEW.reconciliation_receipt->'observation'->>'externalResourceId'
      OR NEW.external_resource_digest IS DISTINCT FROM NEW.reconciliation_receipt->'observation'->>'externalResourceDigest'
      OR (to_jsonb(NEW) - ARRAY['state','revision','evidence_digest','error_code',
          'external_resource_id','external_resource_digest','outcome_recorded_at','updated_at','reconciliation_receipt'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['state','revision','evidence_digest','error_code',
          'external_resource_id','external_resource_digest','outcome_recorded_at','updated_at','reconciliation_receipt'])
      OR NOT EXISTS (
        SELECT 1 FROM cp_job job WHERE job.job_id=NEW.reconciliation_receipt->>'jobId'
          AND job.organization_id=NEW.organization_id AND job.job_kind='provider-delivery.reconcile'
          AND job.payload->>'intentId'=NEW.intent_id
          AND job.payload->>'intentDigest'=NEW.journal_intent_digest
          AND job.state='claimed' AND job.lease_expires_at>clock_timestamp()
          AND NEW.reconciliation_receipt->>'jobLeaseDigest'
            = 'sha256:' || encode(sha256(convert_to(job.lease_token,'UTF8')),'hex')
      ) THEN RAISE EXCEPTION 'delivery_observation_authority_invalid'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.reconciliation_receipt IS DISTINCT FROM OLD.reconciliation_receipt THEN
    RAISE EXCEPTION 'delivery_observation_immutable';
  END IF;
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
