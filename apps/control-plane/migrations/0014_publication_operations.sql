CREATE TABLE cp_publication_branch_ownership (
  organization_id text NOT NULL, ownership_id text NOT NULL,
  run_id text NOT NULL, attempt_id text NOT NULL, attempt_number integer NOT NULL,
  fencing_token_digest text NOT NULL CHECK (fencing_token_digest ~ '^sha256:[a-f0-9]{64}$'),
  runner_id text NOT NULL, runner_generation integer NOT NULL CHECK (runner_generation > 0),
  candidate_id text NOT NULL,
  candidate_digest text NOT NULL CHECK (candidate_digest ~ '^sha256:[a-f0-9]{64}$'),
  project_target_id text NOT NULL,
  target_binding_digest text NOT NULL CHECK (target_binding_digest ~ '^sha256:[a-f0-9]{64}$'),
  provider text NOT NULL, owner text NOT NULL, repo text NOT NULL,
  remote text NOT NULL, base_branch text NOT NULL,
  frozen_base_revision text NOT NULL CHECK (frozen_base_revision ~ '^[a-f0-9]{40,64}$'),
  workspace_tree_digest text NOT NULL CHECK (workspace_tree_digest ~ '^[a-f0-9]{40,64}$'),
  branch text NOT NULL,
  expected_head_sha text NOT NULL CHECK (expected_head_sha ~ '^[a-f0-9]{40,64}$'),
  attestation_digest text NOT NULL CHECK (attestation_digest ~ '^sha256:[a-f0-9]{64}$'),
  attested_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, ownership_id), UNIQUE (organization_id, candidate_id),
  FOREIGN KEY (organization_id, run_id, attempt_number, attempt_id)
    REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number, attempt_id),
  CHECK (provider = lower(provider) AND owner = lower(owner) AND repo = lower(repo))
);
CREATE UNIQUE INDEX cp_publication_branch_owner_key
  ON cp_publication_branch_ownership(
    organization_id, lower(provider), lower(owner), lower(repo), lower(branch));

CREATE TABLE cp_publication_intent (
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  intent_id text NOT NULL, run_id text NOT NULL, attempt_id text NOT NULL,
  attempt_number integer NOT NULL, candidate_id text NOT NULL,
  candidate_digest text NOT NULL CHECK (candidate_digest ~ '^sha256:[a-f0-9]{64}$'),
  ownership_id text NOT NULL,
  ownership_digest text NOT NULL CHECK (ownership_digest ~ '^sha256:[a-f0-9]{64}$'),
  approval_id text NOT NULL, approver_id text NOT NULL,
  approval_digest text NOT NULL CHECK (approval_digest ~ '^sha256:[a-f0-9]{64}$'),
  repository jsonb NOT NULL, branch text NOT NULL,
  expected_head_sha text NOT NULL CHECK (expected_head_sha ~ '^[a-f0-9]{40,64}$'),
  runner_id text NOT NULL, runner_generation integer NOT NULL CHECK (runner_generation > 0),
  approved_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL, PRIMARY KEY (organization_id, intent_id),
  UNIQUE (organization_id, candidate_id), UNIQUE (organization_id, approval_id),
  CHECK (expires_at > approved_at),
  FOREIGN KEY (organization_id, ownership_id)
    REFERENCES cp_publication_branch_ownership(organization_id, ownership_id),
  FOREIGN KEY (organization_id, run_id, attempt_number, attempt_id)
    REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number, attempt_id)
);
CREATE TABLE cp_publication_capability (
  organization_id text NOT NULL, capability_id text NOT NULL, intent_id text NOT NULL,
  operation_id text NOT NULL, idempotency_key text NOT NULL,
  step text NOT NULL CHECK (step IN ('push_owned_branch','create_draft_pull_request')),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  capability_digest text NOT NULL, capability jsonb NOT NULL,
  issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, capability_id),
  UNIQUE (organization_id, intent_id, step, attempt_number),
  FOREIGN KEY (organization_id, intent_id) REFERENCES cp_publication_intent(organization_id, intent_id),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes')
);
CREATE TABLE cp_publication_begin (
  organization_id text NOT NULL, capability_id text NOT NULL, operation_id text NOT NULL,
  begun_at timestamptz NOT NULL, PRIMARY KEY (organization_id, capability_id),
  FOREIGN KEY (organization_id, capability_id) REFERENCES cp_publication_capability(organization_id, capability_id)
);
CREATE TABLE cp_publication_receipt (
  organization_id text NOT NULL, receipt_id text NOT NULL, capability_id text NOT NULL,
  operation_id text NOT NULL, outcome text NOT NULL
    CHECK (outcome IN ('succeeded','failed','outcome_unknown')),
  receipt_digest text NOT NULL, receipt jsonb NOT NULL, observed_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, receipt_id), UNIQUE (organization_id, capability_id),
  FOREIGN KEY (organization_id, capability_id) REFERENCES cp_publication_capability(organization_id, capability_id)
);
CREATE TABLE cp_publication_reconciliation (
  organization_id text NOT NULL, reconciliation_id text NOT NULL,
  capability_id text NOT NULL, operation_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  observation jsonb NOT NULL, observed_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, reconciliation_id),
  CONSTRAINT cp_publication_reconciliation_capability_sequence_key
    UNIQUE (organization_id, capability_id, sequence),
  FOREIGN KEY (organization_id, capability_id) REFERENCES cp_publication_capability(organization_id, capability_id)
);
CREATE INDEX cp_publication_reconciliation_capability_idx
  ON cp_publication_reconciliation(organization_id, capability_id, sequence);
CREATE TABLE cp_publication_completion (
  organization_id text NOT NULL, completion_id text NOT NULL,
  run_id text NOT NULL, attempt_id text NOT NULL, attempt_number integer NOT NULL,
  fencing_token_digest text NOT NULL, candidate_id text NOT NULL,
  candidate_digest text NOT NULL, intent_id text NOT NULL, ownership_id text NOT NULL,
  push_operation_id text NOT NULL, push_receipt_digest text NOT NULL,
  pull_request_operation_id text NOT NULL, pull_request_receipt_digest text NOT NULL,
  pull_request_external_id text NOT NULL, pull_request_external_digest text NOT NULL,
  repository jsonb NOT NULL, remote text NOT NULL, base_branch text NOT NULL,
  branch text NOT NULL, expected_head_sha text NOT NULL, observed_head_sha text NOT NULL,
  required_check_names text[] NOT NULL, evidence_digest text NOT NULL,
  completion_decision jsonb NOT NULL, observation jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, completion_id), UNIQUE (organization_id, run_id),
  FOREIGN KEY (organization_id, intent_id) REFERENCES cp_publication_intent(organization_id, intent_id),
  FOREIGN KEY (organization_id, ownership_id) REFERENCES cp_publication_branch_ownership(organization_id, ownership_id),
  CHECK (candidate_digest ~ '^sha256:[a-f0-9]{64}$'
    AND fencing_token_digest ~ '^sha256:[a-f0-9]{64}$'
    AND push_receipt_digest ~ '^sha256:[a-f0-9]{64}$'
    AND pull_request_receipt_digest ~ '^sha256:[a-f0-9]{64}$'
    AND pull_request_external_digest ~ '^sha256:[a-f0-9]{64}$'
    AND evidence_digest ~ '^sha256:[a-f0-9]{64}$')
);
CREATE FUNCTION cp_reject_publication_authority_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'publication_authority_immutable'; END $$;
CREATE TRIGGER cp_publication_intent_immutable BEFORE UPDATE OR DELETE ON cp_publication_intent
FOR EACH ROW EXECUTE FUNCTION cp_reject_publication_authority_mutation();
CREATE TRIGGER cp_publication_branch_ownership_immutable BEFORE UPDATE OR DELETE ON cp_publication_branch_ownership
FOR EACH ROW EXECUTE FUNCTION cp_reject_publication_authority_mutation();
CREATE TRIGGER cp_publication_capability_immutable BEFORE UPDATE OR DELETE ON cp_publication_capability
FOR EACH ROW EXECUTE FUNCTION cp_reject_publication_authority_mutation();
CREATE TRIGGER cp_publication_begin_immutable BEFORE UPDATE OR DELETE ON cp_publication_begin
FOR EACH ROW EXECUTE FUNCTION cp_reject_publication_authority_mutation();
CREATE TRIGGER cp_publication_receipt_immutable BEFORE UPDATE OR DELETE ON cp_publication_receipt
FOR EACH ROW EXECUTE FUNCTION cp_reject_publication_authority_mutation();
CREATE TRIGGER cp_publication_reconciliation_immutable BEFORE UPDATE OR DELETE ON cp_publication_reconciliation
FOR EACH ROW EXECUTE FUNCTION cp_reject_publication_authority_mutation();
CREATE TRIGGER cp_publication_completion_immutable BEFORE UPDATE OR DELETE ON cp_publication_completion
FOR EACH ROW EXECUTE FUNCTION cp_reject_publication_authority_mutation();
