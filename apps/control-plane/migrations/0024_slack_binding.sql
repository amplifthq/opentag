LOCK TABLE cp_source_app_installation,cp_source_binding,cp_slack_installation,
  cp_ingress_reservation,cp_slack_action_authority,cp_provider_delivery_intent
  IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cp_source_app_installation)
    OR EXISTS (SELECT 1 FROM cp_source_binding)
    OR EXISTS (SELECT 1 FROM cp_slack_installation)
    OR EXISTS (SELECT 1 FROM cp_ingress_reservation)
    OR EXISTS (SELECT 1 FROM cp_slack_action_authority)
    OR EXISTS (SELECT 1 FROM cp_provider_delivery_intent) THEN
    RAISE EXCEPTION 'slack_binding_fresh_reset_required';
  END IF;
END $$;

CREATE TABLE cp_slack_binding (
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  binding_id text NOT NULL,
  installation_id text NOT NULL,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('active','disabled')),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  credential_generation_digest text NOT NULL
    CHECK (credential_generation_digest ~ '^sha256:[a-f0-9]{64}$'),
  route_identity text NOT NULL,
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
  project_target_id text,
  publication_mode text NOT NULL DEFAULT 'proposal_only',
  display_name text NOT NULL DEFAULT 'OpenTag',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id,binding_id),
  UNIQUE (organization_id,installation_id),
  UNIQUE (organization_id,binding_id,installation_id),
  UNIQUE (route_identity),
  UNIQUE (team_id,app_id,channel_id),
  CONSTRAINT cp_slack_binding_identity_check
    CHECK (binding_id<>'' AND installation_id<>'' AND route_identity<>''
      AND team_id<>'' AND app_id<>'' AND channel_id<>'' AND bot_user_id<>''),
  CONSTRAINT cp_slack_binding_secret_refs_check
    CHECK (signing_secret_ref<>'' AND bot_token_ref<>''),
  CONSTRAINT cp_slack_binding_members_check CHECK (cardinality(member_user_ids)>0),
  CONSTRAINT cp_slack_binding_publication_mode_check
    CHECK (publication_mode IN ('proposal_only','pull_request')),
  CONSTRAINT cp_slack_binding_roles_check CHECK (
    operator_user_ids <@ member_user_ids AND admin_user_ids <@ member_user_ids
    AND (approver_user_id IS NULL OR approver_user_id=ANY(member_user_ids)))
);

ALTER TABLE cp_ingress_reservation
  DROP CONSTRAINT cp_ingress_reservation_organization_id_binding_id_fkey,
  ADD CONSTRAINT cp_ingress_reservation_slack_binding_fkey
    FOREIGN KEY (organization_id,binding_id,installation_id)
    REFERENCES cp_slack_binding(organization_id,binding_id,installation_id);

ALTER TABLE cp_slack_action_authority
  DROP CONSTRAINT cp_slack_action_authority_organization_id_binding_id_fkey,
  DROP CONSTRAINT cp_slack_action_authority_organization_id_installation_id_fkey,
  ADD CONSTRAINT cp_slack_action_authority_slack_binding_fkey
    FOREIGN KEY (organization_id,binding_id,installation_id)
    REFERENCES cp_slack_binding(organization_id,binding_id,installation_id)
    ON DELETE CASCADE;

DROP TABLE cp_slack_installation;
DROP TABLE cp_source_binding;
DROP TABLE cp_source_app_installation;
