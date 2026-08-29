CREATE TABLE cp_provider_delivery_intent (
  intent_id text PRIMARY KEY,
  journal_intent_digest text NOT NULL,
  intent jsonb NOT NULL,
  payload jsonb NOT NULL,
  payload_custody_ref text NOT NULL,
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
  lease_expires_at timestamptz,
  lease_fence_digest text,
  installation_begin_marker_id text,
  installation_begin_marker_digest text,
  scope_begin_marker_id text,
  scope_begin_marker_digest text,
  begun_at timestamptz,
  evidence_digest text,
  error_code text,
  external_resource_digest text,
  external_resource_id text,
  outcome_recorded_at timestamptz,
  deadline_at timestamptz,
  superseded_by_intent_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT cp_provider_delivery_intent_journal_digest_key UNIQUE(journal_intent_digest),
  CONSTRAINT cp_provider_delivery_intent_idempotency_key UNIQUE(scope_kind, scope_id, provider_id, provider_instance_id, idempotency_key),
  CONSTRAINT cp_provider_delivery_intent_revision_check CHECK(revision > 0 AND sequence > 0 AND provider_config_generation > 0 AND runtime_generation > 0 AND schema_generation > 0),
  CONSTRAINT cp_provider_delivery_intent_state_check CHECK(state IN ('pending','leased','provider_io_begun','accepted','rejected','outcome_unknown','attention','superseded'))
);
CREATE INDEX cp_provider_delivery_claim_idx ON cp_provider_delivery_intent(state, lease_expires_at, created_at, intent_id);
CREATE INDEX cp_provider_delivery_external_resource_idx ON cp_provider_delivery_intent(run_id, status_message_id, provider_id, provider_instance_id, external_resource_id);

CREATE FUNCTION cp_provider_delivery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('accepted','rejected','outcome_unknown','attention','superseded')
     OR NEW.revision <> OLD.revision + 1
     OR NEW.intent_id <> OLD.intent_id OR NEW.journal_intent_digest <> OLD.journal_intent_digest
     OR NEW.intent <> OLD.intent OR NEW.payload <> OLD.payload OR NEW.payload_custody_ref <> OLD.payload_custody_ref
     OR NEW.scope_kind <> OLD.scope_kind OR NEW.scope_id <> OLD.scope_id OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.provider_id <> OLD.provider_id OR NEW.provider_instance_id <> OLD.provider_instance_id
     OR NEW.provider_binding_digest <> OLD.provider_binding_digest
     OR NEW.provider_config_generation <> OLD.provider_config_generation
     OR NEW.provider_config_generation_digest <> OLD.provider_config_generation_digest
     OR NEW.runtime_owner_id <> OLD.runtime_owner_id OR NEW.runtime_generation <> OLD.runtime_generation
     OR NEW.schema_generation <> OLD.schema_generation OR NEW.authority_snapshot_digest <> OLD.authority_snapshot_digest
     OR NEW.created_at <> OLD.created_at OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at THEN
    RAISE EXCEPTION 'provider_delivery_immutable_or_invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cp_provider_delivery_guard BEFORE UPDATE ON cp_provider_delivery_intent
FOR EACH ROW EXECUTE FUNCTION cp_provider_delivery_guard();
