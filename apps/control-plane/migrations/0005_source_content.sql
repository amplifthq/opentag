CREATE TABLE cp_source_content (
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  content_id text NOT NULL,
  installation_id text NOT NULL,
  source_app_id text NOT NULL,
  source_delivery_id text NOT NULL,
  source_message_id text NOT NULL,
  source_version_ref text NOT NULL,
  purpose text NOT NULL,
  ciphertext bytea,
  content_nonce bytea,
  content_tag bytea,
  wrapped_dek bytea,
  wrapping_nonce bytea,
  wrapping_tag bytea,
  aad_digest text NOT NULL,
  key_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  terminal_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, content_id),
  CHECK (
    (deleted_at IS NULL AND ciphertext IS NOT NULL AND content_nonce IS NOT NULL
      AND content_tag IS NOT NULL AND wrapped_dek IS NOT NULL
      AND wrapping_nonce IS NOT NULL AND wrapping_tag IS NOT NULL)
    OR
    (deleted_at IS NOT NULL AND ciphertext IS NULL AND content_nonce IS NULL
      AND content_tag IS NULL AND wrapped_dek IS NULL
      AND wrapping_nonce IS NULL AND wrapping_tag IS NULL)
  )
);

CREATE INDEX cp_source_content_source_version_idx
  ON cp_source_content(organization_id, source_version_ref, content_id);
CREATE INDEX cp_source_content_purge_idx
  ON cp_source_content(terminal_at, expires_at);

CREATE TABLE cp_source_content_dependency (
  organization_id text NOT NULL,
  content_id text NOT NULL,
  source_version_ref text NOT NULL,
  dependency_id text NOT NULL,
  terminal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, content_id, dependency_id),
  FOREIGN KEY (organization_id, content_id)
    REFERENCES cp_source_content(organization_id, content_id) ON DELETE CASCADE
);

CREATE INDEX cp_source_content_dependency_version_idx
  ON cp_source_content_dependency(organization_id, source_version_ref, terminal);

CREATE TABLE cp_source_content_read_grant (
  grant_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  token_hash text NOT NULL UNIQUE,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  fence_digest text NOT NULL,
  content_ids text[] NOT NULL,
  purpose text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  CHECK (cardinality(content_ids) > 0)
);

CREATE INDEX cp_source_content_read_grant_active_idx
  ON cp_source_content_read_grant(organization_id, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE cp_source_replay_tombstone (
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  replay_identity_digest text NOT NULL,
  source_version_digest text NOT NULL,
  command_id text,
  request_digest text,
  invalidation_receipt jsonb,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, replay_identity_digest)
);

CREATE INDEX cp_source_replay_tombstone_expiry_idx
  ON cp_source_replay_tombstone(expires_at);
CREATE UNIQUE INDEX cp_source_replay_tombstone_command_idx
  ON cp_source_replay_tombstone(organization_id, command_id)
  WHERE command_id IS NOT NULL;
