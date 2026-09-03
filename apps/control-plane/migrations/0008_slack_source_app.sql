CREATE TABLE cp_slack_installation (
  organization_id text NOT NULL,
  installation_id text NOT NULL,
  binding_id text NOT NULL,
  project_target_id text,
  publication_mode text NOT NULL DEFAULT 'proposal_only',
  team_id text NOT NULL,
  app_id text NOT NULL,
  channel_id text NOT NULL,
  bot_user_id text NOT NULL,
  member_user_ids text[] NOT NULL,
  operator_user_ids text[] NOT NULL DEFAULT '{}',
  approver_user_id text,
  admin_user_ids text[] NOT NULL DEFAULT '{}',
  signing_secret_ref text NOT NULL,
  bot_token_ref text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, installation_id),
  UNIQUE (team_id, app_id, channel_id),
  FOREIGN KEY (organization_id, installation_id)
    REFERENCES cp_source_app_installation(organization_id, installation_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, binding_id)
    REFERENCES cp_source_binding(organization_id, binding_id),
  CONSTRAINT cp_slack_installation_identity_check
    CHECK (team_id <> '' AND app_id <> '' AND channel_id <> '' AND bot_user_id <> ''),
  CONSTRAINT cp_slack_installation_secret_refs_check
    CHECK (signing_secret_ref <> '' AND bot_token_ref <> ''),
  CONSTRAINT cp_slack_installation_members_check CHECK (cardinality(member_user_ids) > 0),
  CONSTRAINT cp_slack_installation_publication_mode_check
    CHECK (publication_mode IN ('proposal_only','pull_request')),
  CONSTRAINT cp_slack_installation_roles_check CHECK (
    operator_user_ids <@ member_user_ids AND admin_user_ids <@ member_user_ids
    AND (approver_user_id IS NULL OR approver_user_id = ANY(member_user_ids)))
);

CREATE TABLE cp_slack_action_authority (
  organization_id text NOT NULL,
  action_id text NOT NULL,
  action_token_hash text NOT NULL,
  installation_id text NOT NULL,
  binding_id text NOT NULL,
  team_id text NOT NULL,
  app_id text NOT NULL,
  channel_id text NOT NULL,
  thread_root_message_id text NOT NULL,
  run_id text NOT NULL,
  pending_request_id text NOT NULL,
  action_kind text NOT NULL,
  action_descriptor jsonb NOT NULL,
  approval_epoch text NOT NULL,
  frozen_ceiling jsonb NOT NULL,
  allowed_decisions text[] NOT NULL,
  requester_user_id text,
  member_user_ids text[] NOT NULL,
  operator_user_ids text[] NOT NULL,
  approver_user_id text,
  admin_user_ids text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, action_id),
  UNIQUE (action_token_hash),
  FOREIGN KEY (organization_id, installation_id)
    REFERENCES cp_slack_installation(organization_id, installation_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, binding_id)
    REFERENCES cp_source_binding(organization_id, binding_id),
  CONSTRAINT cp_slack_action_authority_kind_check
    CHECK (action_kind IN ('status','cancel','approval','bind','unbind')),
  CONSTRAINT cp_slack_action_authority_decisions_check
    CHECK (cardinality(allowed_decisions) > 0 AND allowed_decisions <@
      ARRAY['status','cancel','allow_once','allow_run','deny','bind','unbind']::text[]),
  CONSTRAINT cp_slack_action_authority_members_check CHECK (cardinality(member_user_ids) > 0),
  CONSTRAINT cp_slack_action_authority_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX cp_slack_action_authority_lookup_idx
  ON cp_slack_action_authority(organization_id, installation_id, channel_id, thread_root_message_id);
