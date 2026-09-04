import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SlackBootstrapConfig } from "../src/config.js";
import { bootstrapSlackInstallation } from "../src/modules/slack-installation-bootstrap/index.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const now = new Date("2026-09-04T00:00:00.000Z");
const config = (overrides: Partial<SlackBootstrapConfig> = {}): SlackBootstrapConfig => ({
  installationId: "slack_installation_bootstrap",
  bindingId: "slack_binding_bootstrap",
  routeIdentity: "route_identity_bootstrap",
  projectTargetId: "target_bootstrap",
  publicationMode: "proposal_only",
  teamId: "T_BOOTSTRAP",
  appId: "A_BOOTSTRAP",
  channelId: "C_BOOTSTRAP",
  botUserId: "U_BOT_BOOTSTRAP",
  memberUserIds: ["U_ADMIN", "U_APPROVER", "U_MEMBER", "U_OPERATOR"],
  operatorUserIds: ["U_OPERATOR"],
  approverUserId: "U_APPROVER",
  adminUserIds: ["U_ADMIN"],
  signingSecretRef: "file:/run/secrets/opentag_slack_signing_secret",
  botTokenRef: "file:/run/secrets/opentag_slack_bot_token",
  ...overrides,
});
const resolvedSecretRefs: string[] = [];
const secrets = { async resolve(reference: string) {
  resolvedSecretRefs.push(reference);
  if (reference.endsWith("signing_secret")) return "bootstrap-signing-secret";
  if (reference.endsWith("bot_token")) return "bootstrap-bot-token";
  throw new Error("secret unavailable");
} };

describe.skipIf(!TEST_DATABASE_URL)("Slack installation bootstrap", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  beforeEach(async () => {
    resolvedSecretRefs.length = 0;
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    await fixture.pool.query(
      "INSERT INTO cp_organization(organization_id,display_name) VALUES('org_bootstrap','Bootstrap')",
    );
  });
  afterEach(async () => fixture.close());

  const bootstrap = (slackConfig = config()) => bootstrapSlackInstallation({
    pool: fixture.pool,
    organizationId: "org_bootstrap",
    config: slackConfig,
    secrets,
    clock: { now: () => now },
  });

  it("atomically creates one content-free Slack binding and its audit row", async () => {
    await expect(bootstrap()).resolves.toMatchObject({
      kind: "created",
      credentialGeneration: 1,
    });
    const rows = await fixture.pool.query<{
      installation_id: string;
      binding_id: string;
      binding_digest: string;
      state: string;
      credential_generation: number;
      credential_generation_digest: string;
      project_target_id: string;
      route_identity: string;
      signing_secret_ref: string;
      bot_token_ref: string;
      member_user_ids: string[];
      display_name: string;
    }>(`SELECT installation_id,binding_id,binding_digest,state,credential_generation,
      credential_generation_digest,project_target_id,route_identity,signing_secret_ref,
      bot_token_ref,member_user_ids,display_name
      FROM cp_slack_binding WHERE organization_id='org_bootstrap'`);
    expect(rows.rows).toEqual([expect.objectContaining({
      installation_id: "slack_installation_bootstrap",
      binding_id: "slack_binding_bootstrap",
      state: "active",
      credential_generation: 1,
      project_target_id: "target_bootstrap",
      route_identity: "route_identity_bootstrap",
      signing_secret_ref: "file:/run/secrets/opentag_slack_signing_secret",
      bot_token_ref: "file:/run/secrets/opentag_slack_bot_token",
      member_user_ids: ["U_ADMIN", "U_APPROVER", "U_MEMBER", "U_OPERATOR"],
      display_name: "OpenTag",
    })]);
    expect(rows.rows[0]?.binding_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(rows.rows[0]?.credential_generation_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(resolvedSecretRefs).toEqual([
      "file:/run/secrets/opentag_slack_signing_secret",
      "file:/run/secrets/opentag_slack_bot_token",
    ]);
    const audit = await fixture.pool.query<{ outcome: string; event: unknown }>(
      "SELECT outcome,event FROM cp_management_audit_event WHERE organization_id='org_bootstrap'",
    );
    expect(audit.rows).toEqual([{ outcome: "created", event: expect.objectContaining({
      credentialGeneration: 1,
    }) }]);
    expect(JSON.stringify(audit.rows)).not.toContain("bootstrap-signing-secret");
    expect(JSON.stringify(audit.rows)).not.toContain("bootstrap-bot-token");
    expect(JSON.stringify(audit.rows)).not.toContain("/run/secrets/");
  });

  it("serializes concurrent exact bootstrap as one create and one replay", async () => {
    const outcomes = await Promise.all([bootstrap(), bootstrap()]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["created", "replayed"]);
    await expect(fixture.pool.query("SELECT count(*)::int AS count FROM cp_slack_binding"))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(fixture.pool.query("SELECT outcome FROM cp_management_audit_event ORDER BY sequence_id"))
      .resolves.toMatchObject({ rows: [{ outcome: "created" }, { outcome: "replayed" }] });
  });

  it("fails closed for conflicting configuration or occupied provider identity", async () => {
    await expect(bootstrap()).resolves.toMatchObject({ kind: "created" });
    await expect(bootstrap(config({ channelId: "C_DIFFERENT" }))).resolves.toEqual({
      kind: "conflict",
      reason: "existing_state_mismatch",
    });
    await expect(bootstrap(config({ installationId: "slack_installation_other",
      bindingId: "slack_binding_other", routeIdentity: "route_identity_other" })))
      .resolves.toEqual({ kind: "conflict", reason: "existing_state_mismatch" });
    await expect(fixture.pool.query("SELECT count(*)::int AS count FROM cp_slack_binding"))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("verifies referenced secrets before writing any installation state", async () => {
    await expect(bootstrapSlackInstallation({
      pool: fixture.pool,
      organizationId: "org_bootstrap",
      config: config(),
      secrets: { async resolve() { return "short"; } },
      clock: { now: () => now },
    })).rejects.toThrow("slack_bootstrap_secret_unavailable");
    await expect(fixture.pool.query("SELECT count(*)::int AS count FROM cp_slack_binding"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
