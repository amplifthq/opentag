ALTER TABLE cp_slack_action_authority
  ADD COLUMN projection_generation integer,
  ADD COLUMN publication_approval jsonb;

UPDATE cp_slack_action_authority
SET projection_generation = attempt_number,
    consumed_at = COALESCE(consumed_at, clock_timestamp());

ALTER TABLE cp_slack_action_authority
  ALTER COLUMN projection_generation SET NOT NULL,
  DROP CONSTRAINT cp_slack_action_authority_kind_check,
  DROP CONSTRAINT cp_slack_action_authority_decisions_check,
  ADD CONSTRAINT cp_slack_action_authority_kind_check
    CHECK (action_kind IN ('status','cancel','approval','publication','bind','unbind')),
  ADD CONSTRAINT cp_slack_action_authority_decisions_check
    CHECK (cardinality(allowed_decisions) > 0 AND allowed_decisions <@
      ARRAY['status','cancel','allow_once','allow_run','deny','publication_approve','publication_reject','bind','unbind']::text[]),
  ADD CONSTRAINT cp_slack_action_authority_projection_generation_check
    CHECK (projection_generation > 0),
  ADD CONSTRAINT cp_slack_action_authority_publication_shape_check
    CHECK ((action_kind = 'publication') = (publication_approval IS NOT NULL));
