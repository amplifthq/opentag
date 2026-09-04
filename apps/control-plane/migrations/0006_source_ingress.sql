CREATE TABLE cp_source_app_installation (
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  installation_id text NOT NULL, source_app_id text NOT NULL, app_instance_id text NOT NULL,
  binding_digest text NOT NULL, credential_generation integer NOT NULL,
  credential_generation_digest text NOT NULL, state text NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, installation_id),
  UNIQUE (organization_id, source_app_id, app_instance_id),
  CHECK (state IN ('active', 'disabled')),
  CHECK (credential_generation > 0)
);

CREATE TABLE cp_source_binding (
  organization_id text NOT NULL, binding_id text NOT NULL, installation_id text NOT NULL,
  binding_digest text NOT NULL, state text NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, binding_id),
  FOREIGN KEY (organization_id, installation_id)
    REFERENCES cp_source_app_installation(organization_id, installation_id) ON DELETE CASCADE,
  CHECK (state IN ('active', 'disabled'))
);
CREATE INDEX cp_source_binding_installation_idx
  ON cp_source_binding(organization_id, installation_id);

CREATE TABLE cp_ingress_reservation (
  reservation_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  installation_id text NOT NULL, binding_id text NOT NULL, source_app_id text NOT NULL,
  source_delivery_id text NOT NULL, source_message_id text NOT NULL,
  source_version_ref text NOT NULL, raw_digest text NOT NULL, content_id text NOT NULL,
  content_aad_digest text NOT NULL, content_key_version text NOT NULL,
  resolution_request_digest text, resolution_run_id text, resolution jsonb,
  resolved_at timestamptz, state text NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  FOREIGN KEY (organization_id, binding_id)
    REFERENCES cp_source_binding(organization_id, binding_id),
  UNIQUE (organization_id, installation_id, source_delivery_id),
  UNIQUE (organization_id, reservation_id),
  CHECK ((resolution_request_digest IS NULL) = (resolution_run_id IS NULL)),
  CHECK (
    (state = 'pending' AND resolution IS NULL AND resolved_at IS NULL)
    OR (state = 'resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CHECK (resolution IS NULL OR resolution->>'kind' IN (
    'accepted','waiting_for_runner','setup_required','not_authorized',
    'invalid_request','rate_limited','queue_full','storage_quota_exceeded',
    'source_content_deleted','temporarily_unavailable'
  ))
);
CREATE INDEX cp_ingress_reservation_pending_idx
  ON cp_ingress_reservation(state, created_at);
