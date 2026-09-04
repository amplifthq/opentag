import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { canonicalJsonStringify } from "@opentag/control-protocol/canonical-json";
import type { SlackBootstrapConfig } from "../../config.js";
import { withPostgresTransaction } from "../../database/postgres.js";
import { recordManagementAudit } from "../audit/index.js";

type SecretResolver = { resolve(reference: string): Promise<string> };

type SourceInstallationRow = {
  source_app_id: string;
  app_instance_id: string;
  binding_digest: string;
  credential_generation: number;
  credential_generation_digest: string;
  state: string;
};
type SourceBindingRow = {
  installation_id: string;
  binding_digest: string;
  state: string;
};
type SlackInstallationRow = {
  binding_id: string;
  project_target_id: string | null;
  publication_mode: string;
  team_id: string;
  app_id: string;
  channel_id: string;
  bot_user_id: string;
  member_user_ids: string[];
  operator_user_ids: string[];
  approver_user_id: string | null;
  admin_user_ids: string[];
  signing_secret_ref: string;
  bot_token_ref: string;
  route_identity: string;
};

export type SlackInstallationBootstrapOutcome =
  | { kind: "created" | "replayed"; bindingDigest: string;
      credentialGeneration: 1; credentialGenerationDigest: string }
  | { kind: "conflict"; reason: "organization_missing" | "existing_state_mismatch"
      | "identity_already_bound" };

function digest(namespace: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify({ namespace, value }))
    .digest("hex")}`;
}

function bootstrapIdentity(organizationId: string, config: SlackBootstrapConfig) {
  const bindingDigest = digest("opentag.slack.source-binding/v1", {
    organizationId,
    installationId: config.installationId,
    bindingId: config.bindingId,
    projectTargetId: config.projectTargetId,
    publicationMode: config.publicationMode,
    teamId: config.teamId,
    appId: config.appId,
    channelId: config.channelId,
    botUserId: config.botUserId,
    memberUserIds: config.memberUserIds,
    operatorUserIds: config.operatorUserIds,
    approverUserId: config.approverUserId,
    adminUserIds: config.adminUserIds,
  });
  const credentialGenerationDigest = digest("opentag.slack.credential-generation/v1", {
    organizationId,
    installationId: config.installationId,
    credentialGeneration: 1,
    signingSecretRef: config.signingSecretRef,
    botTokenRef: config.botTokenRef,
  });
  return { bindingDigest, credentialGenerationDigest };
}

function secretIsUsable(value: string): boolean {
  return value.length >= 16 && value.length <= 4096 && value === value.trim()
    && !value.includes("\0") && !value.startsWith("replace-with-");
}

function exactRows(input: {
  organizationId: string;
  config: SlackBootstrapConfig;
  bindingDigest: string;
  credentialGenerationDigest: string;
  source: SourceInstallationRow | undefined;
  binding: SourceBindingRow | undefined;
  slack: SlackInstallationRow | undefined;
}): boolean {
  const { config, bindingDigest, credentialGenerationDigest } = input;
  return canonicalJsonStringify(input.source) === canonicalJsonStringify({
    source_app_id: "slack",
    app_instance_id: config.installationId,
    binding_digest: bindingDigest,
    credential_generation: 1,
    credential_generation_digest: credentialGenerationDigest,
    state: "active",
  }) && canonicalJsonStringify(input.binding) === canonicalJsonStringify({
    installation_id: config.installationId,
    binding_digest: bindingDigest,
    state: "active",
  }) && canonicalJsonStringify(input.slack) === canonicalJsonStringify({
    binding_id: config.bindingId,
    project_target_id: config.projectTargetId,
    publication_mode: config.publicationMode,
    team_id: config.teamId,
    app_id: config.appId,
    channel_id: config.channelId,
    bot_user_id: config.botUserId,
    member_user_ids: config.memberUserIds,
    operator_user_ids: config.operatorUserIds,
    approver_user_id: config.approverUserId,
    admin_user_ids: config.adminUserIds,
    signing_secret_ref: config.signingSecretRef,
    bot_token_ref: config.botTokenRef,
    route_identity: config.routeIdentity,
  });
}

export async function bootstrapSlackInstallation(input: {
  pool: Pool;
  organizationId: string;
  config: SlackBootstrapConfig;
  secrets: SecretResolver;
  clock?: { now(): Date };
}): Promise<SlackInstallationBootstrapOutcome> {
  const secretValues = await Promise.all([
    input.secrets.resolve(input.config.signingSecretRef),
    input.secrets.resolve(input.config.botTokenRef),
  ]);
  if (!secretValues.every(secretIsUsable)) {
    throw new Error("slack_bootstrap_secret_unavailable");
  }
  const clock = input.clock ?? { now: () => new Date() };
  const identity = bootstrapIdentity(input.organizationId, input.config);
  try {
    return await withPostgresTransaction(input.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        canonicalJsonStringify([
          "opentag.slack.bootstrap/v1",
          input.organizationId,
          input.config.installationId,
        ]),
      ]);
      const organization = await client.query<{ present: boolean }>(
        "SELECT true AS present FROM cp_organization WHERE organization_id=$1 FOR KEY SHARE",
        [input.organizationId],
      );
      if (!organization.rows[0]?.present) {
        return { kind: "conflict", reason: "organization_missing" } as const;
      }
      const source = await client.query<SourceInstallationRow>(
        `SELECT source_app_id,app_instance_id,binding_digest,
          credential_generation,credential_generation_digest,state
         FROM cp_source_app_installation
         WHERE organization_id=$1 AND installation_id=$2 FOR UPDATE`,
        [input.organizationId, input.config.installationId],
      );
      const binding = await client.query<SourceBindingRow>(
        `SELECT installation_id,binding_digest,state
         FROM cp_source_binding
         WHERE organization_id=$1 AND binding_id=$2 FOR UPDATE`,
        [input.organizationId, input.config.bindingId],
      );
      const slack = await client.query<SlackInstallationRow>(
        `SELECT binding_id,project_target_id,publication_mode,
          team_id,app_id,channel_id,bot_user_id,member_user_ids,operator_user_ids,
          approver_user_id,admin_user_ids,signing_secret_ref,bot_token_ref,route_identity
         FROM cp_slack_installation
         WHERE organization_id=$1 AND installation_id=$2 FOR UPDATE`,
        [input.organizationId, input.config.installationId],
      );
      const existingCount = Number(source.rows.length > 0)
        + Number(binding.rows.length > 0) + Number(slack.rows.length > 0);
      const now = clock.now();
      if (existingCount > 0) {
        if (existingCount !== 3 || !exactRows({
          organizationId: input.organizationId,
          config: input.config,
          ...identity,
          source: source.rows[0],
          binding: binding.rows[0],
          slack: slack.rows[0],
        })) {
          return { kind: "conflict", reason: "existing_state_mismatch" } as const;
        }
        await recordManagementAudit(client, {
          organizationId: input.organizationId,
          actor: { kind: "bootstrap", id: "bootstrap-slack" },
          operationKind: "slack_installation.bootstrap",
          resource: { kind: "slack_installation", id: input.config.installationId },
          outcome: "replayed",
          event: { bindingDigest: identity.bindingDigest, credentialGeneration: 1,
            credentialGenerationDigest: identity.credentialGenerationDigest },
          createdAt: now,
        });
        return { kind: "replayed", ...identity, credentialGeneration: 1 } as const;
      }
      await client.query(`INSERT INTO cp_source_app_installation(
        organization_id,installation_id,source_app_id,app_instance_id,binding_digest,
        credential_generation,credential_generation_digest,state,created_at,updated_at)
        VALUES($1,$2,'slack',$2,$3,1,$4,'active',$5,$5)`,
      [input.organizationId, input.config.installationId, identity.bindingDigest,
        identity.credentialGenerationDigest, now]);
      await client.query(`INSERT INTO cp_source_binding(organization_id,binding_id,
        installation_id,binding_digest,state,created_at,updated_at)
        VALUES($1,$2,$3,$4,'active',$5,$5)`,
      [input.organizationId, input.config.bindingId, input.config.installationId,
        identity.bindingDigest, now]);
      await client.query(`INSERT INTO cp_slack_installation(organization_id,installation_id,
        binding_id,project_target_id,publication_mode,team_id,app_id,channel_id,bot_user_id,
        member_user_ids,operator_user_ids,approver_user_id,admin_user_ids,signing_secret_ref,
        bot_token_ref,route_identity,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
      [input.organizationId, input.config.installationId, input.config.bindingId,
        input.config.projectTargetId, input.config.publicationMode, input.config.teamId,
        input.config.appId, input.config.channelId, input.config.botUserId,
        input.config.memberUserIds, input.config.operatorUserIds, input.config.approverUserId,
        input.config.adminUserIds, input.config.signingSecretRef, input.config.botTokenRef,
        input.config.routeIdentity, now]);
      await recordManagementAudit(client, {
        organizationId: input.organizationId,
        actor: { kind: "bootstrap", id: "bootstrap-slack" },
        operationKind: "slack_installation.bootstrap",
        resource: { kind: "slack_installation", id: input.config.installationId },
        outcome: "created",
        event: { bindingDigest: identity.bindingDigest, credentialGeneration: 1,
          credentialGenerationDigest: identity.credentialGenerationDigest },
        createdAt: now,
      });
      return { kind: "created", ...identity, credentialGeneration: 1 } as const;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return { kind: "conflict", reason: "identity_already_bound" };
    }
    throw error;
  }
}
