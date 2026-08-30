ALTER TABLE cp_slack_installation ADD COLUMN route_identity text;
UPDATE cp_slack_installation
SET route_identity = 'slack_route_' || md5(organization_id || ':' || installation_id);
ALTER TABLE cp_slack_installation ALTER COLUMN route_identity SET NOT NULL;
ALTER TABLE cp_slack_installation
  ADD CONSTRAINT cp_slack_installation_route_identity_key UNIQUE(route_identity);
ALTER TABLE cp_slack_installation
  ADD CONSTRAINT cp_slack_installation_route_identity_check CHECK(route_identity <> '');
