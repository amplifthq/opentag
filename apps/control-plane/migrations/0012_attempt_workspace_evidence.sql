ALTER TABLE cp_source_content
  ADD COLUMN payload_digest text;

UPDATE cp_source_content
SET payload_digest = 'sha256:' || repeat('0', 64)
WHERE payload_digest IS NULL;

ALTER TABLE cp_source_content
  ALTER COLUMN payload_digest SET NOT NULL;

ALTER TABLE cp_source_content
  ADD CONSTRAINT cp_source_content_payload_digest_check
  CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$');

ALTER TABLE cp_ingress_reservation
  ADD COLUMN content_payload_digest text;

UPDATE cp_ingress_reservation
SET content_payload_digest = raw_digest
WHERE content_payload_digest IS NULL;

ALTER TABLE cp_ingress_reservation
  ALTER COLUMN content_payload_digest SET NOT NULL;

ALTER TABLE cp_hosted_attempt
  ADD COLUMN workspace_attestation jsonb,
  ADD COLUMN interruption_evidence jsonb;

ALTER TABLE cp_hosted_attempt
  ADD CONSTRAINT cp_hosted_attempt_workspace_attestation_content_free_check
  CHECK (workspace_attestation IS NULL OR (
    jsonb_typeof(workspace_attestation) = 'object'
    AND workspace_attestation ?& ARRAY[
      'workspaceId', 'workspacePathDigest', 'repositoryPathDigest',
      'worktreeIdentityDigest', 'baseRevision', 'currentRevision', 'currentTree',
      'workspaceStateDigest', 'attemptId', 'attemptNumber', 'fencingTokenDigest',
      'credentialId', 'leaseExpiresAt'
    ]
    AND NOT workspace_attestation ? 'workspacePath'
  )),
  ADD CONSTRAINT cp_hosted_attempt_interruption_evidence_content_free_check
  CHECK (interruption_evidence IS NULL OR (
    jsonb_typeof(interruption_evidence) = 'object'
    AND interruption_evidence ?& ARRAY[
      'state', 'runId', 'attemptId', 'attemptNumber', 'workspaceId',
      'workspacePathDigest', 'fencingTokenDigest', 'reason', 'observedAt',
      'processStop', 'materialOutcome'
    ]
    AND NOT interruption_evidence ? 'workspacePath'
  ));
