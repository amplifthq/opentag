ALTER TABLE cp_slack_action_authority
  ADD COLUMN action_descriptor_digest text,
  ADD COLUMN frozen_ceiling_digest text,
  ADD COLUMN policy_digest text,
  ADD COLUMN runner_id text,
  ADD COLUMN attempt_id text,
  ADD COLUMN attempt_number integer,
  ADD COLUMN attempt_epoch integer,
  ADD COLUMN fencing_token_digest text,
  ADD COLUMN permission_request_digest text,
  ADD COLUMN pending_action_id text;

UPDATE cp_slack_action_authority SET
  action_descriptor_digest = 'legacy_unusable',
  frozen_ceiling_digest = 'legacy_unusable',
  policy_digest = 'legacy_unusable',
  runner_id = 'legacy_unusable',
  attempt_id = 'legacy_unusable',
  attempt_number = 1,
  attempt_epoch = 1,
  fencing_token_digest = 'legacy_unusable',
  permission_request_digest = 'legacy_unusable',
  pending_action_id = action_id,
  consumed_at = COALESCE(consumed_at, clock_timestamp());

ALTER TABLE cp_slack_action_authority
  ALTER COLUMN action_descriptor_digest SET NOT NULL,
  ALTER COLUMN frozen_ceiling_digest SET NOT NULL,
  ALTER COLUMN policy_digest SET NOT NULL,
  ALTER COLUMN runner_id SET NOT NULL,
  ALTER COLUMN attempt_id SET NOT NULL,
  ALTER COLUMN attempt_number SET NOT NULL,
  ALTER COLUMN attempt_epoch SET NOT NULL,
  ALTER COLUMN fencing_token_digest SET NOT NULL,
  ALTER COLUMN permission_request_digest SET NOT NULL,
  ALTER COLUMN pending_action_id SET NOT NULL,
  ADD CONSTRAINT cp_slack_action_authority_attempt_number_check CHECK (attempt_number > 0);
