import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeSlackSignature, createSlackSourceApp } from "@opentag/slack";
import { SourceAppRegistry } from "@opentag/source-app-runtime";
import { computeControlPayloadDigestV1 } from "@opentag/control-protocol";
import { createDurableJobQueue } from "../src/modules/jobs/index.js";
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
import { createSourceIngressService } from "../src/modules/source-ingress/index.js";
import { createPostgresSlackIngress, createSlackIngressForTest } from "../src/modules/slack-ingress/index.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const now = new Date("2026-08-30T00:00:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)("Slack durable ingress", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const installation = { organizationId: "org_a", appInstanceId: "A1", bindingDigest: digest("binding"),
    credentialGeneration: 1, credentialGenerationDigest: digest("generation") };

  beforeEach(async () => {
    fixture = await createIsolatedPostgres(); await fixture.migrate();
    await fixture.pool.query("INSERT INTO cp_organization(organization_id, display_name) VALUES('org_a','A')");
    await fixture.pool.query(`INSERT INTO cp_source_app_installation(
      organization_id, installation_id, source_app_id, app_instance_id, binding_digest,
      credential_generation, credential_generation_digest, state, created_at, updated_at)
      VALUES('org_a','install_1','slack','A1',$1,1,$2,'active',$3,$3)`,
      [installation.bindingDigest, installation.credentialGenerationDigest, now]);
    await fixture.pool.query(`INSERT INTO cp_source_binding(organization_id,binding_id,
      installation_id,binding_digest,state,created_at,updated_at)
      VALUES('org_a','binding_1','install_1',$1,'active',$2,$2)`, [installation.bindingDigest, now]);
  });
  afterEach(async () => fixture.close());

  function components() {
    const clock = { now: () => now };
    const jobs = createDurableJobQueue({ pool: fixture.pool, clock,
      leaseDurationMs: 30_000, tokenFactory: () => "lease_test" });
    const custody = createRelayContentCustody({ pool: fixture.pool, clock,
      key: { key: randomBytes(32), keyVersion: "v1" },
      invalidationAuthority: { async invalidateInTransaction(_client, command) {
        return { commandId: command.commandId, organizationId: command.organizationId,
          sourceVersionRef: command.sourceVersionRef, reason: "source_content_deleted" as const,
          recordedAt: now.toISOString(), authorityReceiptDigest: digest(command.commandId) };
      } } });
    const sourceApp = createSlackSourceApp({ installation, signingSecret: "secret",
      botUserId: "U_APP", resolveCredential: async () => "unused", clock: () => now.getTime() });
    const ingress = createSlackIngressForTest({ sourceApp, organizationId: "org_a",
      installationId: "install_1", bindingId: "binding_1",
      sourceIngress: createSourceIngressService({ pool: fixture.pool, clock, custody, jobs }),
      sourceContent: custody, clock });
    return { ingress };
  }

  function request(eventId = "Ev1", event: Record<string, unknown> | undefined = undefined,
    identity: { teamId?: string; appId?: string } = {}) {
    event ??= {
    type: "app_mention", user: "U1", text: "<@U_APP> fix this",
    ts: "1700000000.000100", channel: "C1"
  };
    const body = JSON.stringify({ type: "event_callback", team_id: identity.teamId ?? "T1",
      api_app_id: identity.appId ?? "A1",
      event_id: eventId, event_time: Math.floor(now.getTime() / 1000),
      authorizations: [{ user_id: "U_APP" }], event });
    const timestamp = String(Math.floor(now.getTime() / 1000));
    return { rawBody: new TextEncoder().encode(body), headers: new Headers({
      "content-type": "application/json", "x-slack-request-timestamp": timestamp,
      "x-slack-signature": computeSlackSignature({ signingSecret: "secret", timestamp, rawBody: body })
    }), receivedAt: now.toISOString() };
  }

  function actionRequest(payload: unknown) {
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const timestamp = String(Math.floor(now.getTime() / 1000));
    return { rawBody: new TextEncoder().encode(body), headers: new Headers({
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": computeSlackSignature({ signingSecret: "secret", timestamp, rawBody: body })
    }), receivedAt: now.toISOString() };
  }

  function challengeRequest(challenge: unknown = "challenge_abc123",
    identity: { teamId?: string; appId?: string } = {}) {
    const body = JSON.stringify({ type: "url_verification", team_id: identity.teamId ?? "T1",
      api_app_id: identity.appId ?? "A1", challenge });
    const timestamp = String(Math.floor(now.getTime() / 1000));
    return { rawBody: new TextEncoder().encode(body), headers: new Headers({
      "content-type": "application/json", "x-slack-request-timestamp": timestamp,
      "x-slack-signature": computeSlackSignature({ signingSecret: "secret", timestamp, rawBody: body })
    }), receivedAt: now.toISOString() };
  }

  async function insertSlackInstallation() {
    await fixture.pool.query(`INSERT INTO cp_slack_installation(
      organization_id, installation_id, route_identity, binding_id, team_id, app_id, channel_id,
      bot_user_id, member_user_ids, signing_secret_ref, bot_token_ref, created_at, updated_at)
      VALUES('org_a','install_1','route_1','binding_1','T1','A1','C1','U_APP',
        ARRAY['U1','U_MEMBER','U_REQUESTER','U_OPERATOR','U_APPROVER','U_ADMIN'],
        'secret://slack/signing','secret://slack/bot',$1,$1)`, [now]);
  }

  function productionComponents(input: { commandAuthority?: any; publicationAuthority?: any;
    tokenFactory?: () => string; testHooks?: any } = {}) {
    const material = new Map([
      ["secret://slack/signing", "secret"], ["secret://slack/bot", "bot-token"]
    ]);
    const clock = { now: () => now };
    const jobs = createDurableJobQueue({ pool: fixture.pool, clock,
      leaseDurationMs: 30_000, tokenFactory: () => "lease_test" });
    const custody = createRelayContentCustody({ pool: fixture.pool, clock,
      key: { key: randomBytes(32), keyVersion: "v1" },
      invalidationAuthority: { async invalidateInTransaction(_client, command) {
        return { commandId: command.commandId, organizationId: command.organizationId,
          sourceVersionRef: command.sourceVersionRef, reason: "source_content_deleted" as const,
          recordedAt: now.toISOString(), authorityReceiptDigest: digest(command.commandId) };
      } } });
    const sourceApps = new SourceAppRegistry();
    return { material, sourceApps, ingress: createPostgresSlackIngress({ pool: fixture.pool, clock, custody,
      sourceApps,
      jobs, secrets: { async resolve(reference) {
        const value = material.get(reference); if (!value) throw new Error("secret_unavailable");
        return value;
      } }, ...(input.commandAuthority ? { commandAuthority: input.commandAuthority } : {}),
      ...(input.publicationAuthority ? { publicationAuthority: input.publicationAuthority } : {}),
      ...(input.testHooks ? { testHooks: input.testHooks } : {}),
      ...(input.tokenFactory ? { tokenFactory: input.tokenFactory } : {}),
      fetchImpl: async () => { throw new Error("provider_call_forbidden"); } }) };
  }

  it("preloads healthy active installations while isolating broken and disabled rows", async () => {
    await insertSlackInstallation();
    for (const [suffix, state, secretRef] of [["2", "active", "secret://missing"],
      ["3", "disabled", "secret://slack/signing"]] as const) {
      await fixture.pool.query(`INSERT INTO cp_source_app_installation(
        organization_id,installation_id,source_app_id,app_instance_id,binding_digest,
        credential_generation,credential_generation_digest,state,created_at,updated_at)
        VALUES('org_a',$1,'slack',$2,$3,1,$4,$5,$6,$6)`,
      [`install_${suffix}`, `A${suffix}`, digest(`binding_${suffix}`),
        digest(`generation_${suffix}`), state, now]);
      await fixture.pool.query(`INSERT INTO cp_source_binding(organization_id,binding_id,
        installation_id,binding_digest,state,created_at,updated_at)
        VALUES('org_a',$1,$2,$3,'active',$4,$4)`,
      [`binding_${suffix}`, `install_${suffix}`, digest(`binding_${suffix}`), now]);
      await fixture.pool.query(`INSERT INTO cp_slack_installation(organization_id,installation_id,
        route_identity,binding_id,team_id,app_id,channel_id,bot_user_id,member_user_ids,signing_secret_ref,
        bot_token_ref,created_at,updated_at) VALUES('org_a',$1,$2,$3,$4,$5,$6,$7,ARRAY['U1'],$8,
        'secret://slack/bot',$9,$9)`, [`install_${suffix}`, `route_${suffix}`, `binding_${suffix}`, `T${suffix}`,
          `A${suffix}`, `C${suffix}`, `U${suffix}`, secretRef, now]);
    }
    const runtime = productionComponents();
    await expect(runtime.ingress.preloadSourceApps()).resolves.toEqual({ registered: 1,
      healthy: [{ organizationId: "org_a", appId: "slack", appInstanceId: "A1",
        bindingDigest: digest("binding"), credentialGeneration: 1,
        credentialGenerationDigest: digest("generation") }],
      failures: [{ organizationId: "org_a", installationId: "install_2",
        errorCode: "slack_installation_preload_failed",
        evidenceDigest: expect.stringMatching(/^sha256:/u) }] });
    expect(runtime.sourceApps.resolveDelivery({ organizationId: "org_a", appId: "slack",
      appInstanceId: "A1", bindingDigest: digest("binding"), credentialGeneration: 1,
      credentialGenerationDigest: digest("generation") })).toBeDefined();
    for (const suffix of ["2", "3"]) expect(runtime.sourceApps.resolveDelivery({
      organizationId: "org_a", appId: "slack", appInstanceId: `A${suffix}`,
      bindingDigest: digest(`binding_${suffix}`), credentialGeneration: 1,
      credentialGenerationDigest: digest(`generation_${suffix}`) })).toBeUndefined();
    runtime.material.set("secret://missing", "recovered-signing-secret");
    await expect(runtime.ingress.preloadSourceApps()).resolves.toMatchObject({ registered: 2,
      failures: [] });
    expect(runtime.sourceApps.resolveDelivery({ organizationId: "org_a", appId: "slack",
      appInstanceId: "A2", bindingDigest: digest("binding_2"), credentialGeneration: 1,
      credentialGenerationDigest: digest("generation_2") })).toBeDefined();
  });

  it("republishes exact Slack delivery authority when route resolution recovers a secret", async () => {
    await insertSlackInstallation();
    const runtime = productionComponents();
    await expect(runtime.ingress.preloadSourceApps()).resolves.toMatchObject({ registered: 1,
      failures: [] });

    runtime.material.delete("secret://slack/signing");
    await expect(runtime.ingress.preloadSourceApps()).resolves.toMatchObject({ registered: 0,
      failures: [{ organizationId: "org_a", installationId: "install_1",
        errorCode: "slack_installation_preload_failed" }] });
    expect(runtime.sourceApps.deliveryAuthorities()).toEqual([]);

    runtime.material.set("secret://slack/signing", "secret");
    await expect(runtime.ingress.receiveEvents("route_1", challengeRequest()))
      .resolves.toEqual({ status: 200, body: "challenge_abc123" });
    expect(runtime.sourceApps.resolveDelivery({ organizationId: "org_a", appId: "slack",
      appInstanceId: "A1", bindingDigest: digest("binding"), credentialGeneration: 1,
      credentialGenerationDigest: digest("generation") })).toBeDefined();
    expect(runtime.sourceApps.deliveryAuthorities()).toEqual([{ organizationId: "org_a",
      appId: "slack", appInstanceId: "A1", bindingDigest: digest("binding"),
      credentialGeneration: 1, credentialGenerationDigest: digest("generation") }]);
  });

  it("routes the same installation id independently across organizations", async () => {
    await insertSlackInstallation();
    await fixture.pool.query("INSERT INTO cp_organization(organization_id,display_name) VALUES('org_b','B')");
    await fixture.pool.query(`INSERT INTO cp_source_app_installation(organization_id,installation_id,
      source_app_id,app_instance_id,binding_digest,credential_generation,credential_generation_digest,
      state,created_at,updated_at) VALUES('org_b','install_1','slack','A1',$1,1,$2,'active',$3,$3)`,
    [digest("binding_b"), digest("generation_b"), now]);
    await fixture.pool.query(`INSERT INTO cp_source_binding(organization_id,binding_id,installation_id,
      binding_digest,state,created_at,updated_at) VALUES('org_b','binding_b','install_1',$1,'active',$2,$2)`,
    [digest("binding_b"), now]);
    await fixture.pool.query(`INSERT INTO cp_slack_installation(organization_id,installation_id,
      route_identity,binding_id,team_id,app_id,channel_id,bot_user_id,member_user_ids,
      signing_secret_ref,bot_token_ref,created_at,updated_at)
      VALUES('org_b','install_1','route_b','binding_b','TB','AB','CB','UB',ARRAY['U1'],
        'secret://slack/signing','secret://slack/bot',$1,$1)`, [now]);
    const runtime = productionComponents();
    await expect(runtime.ingress.preloadSourceApps()).resolves.toMatchObject({ registered: 2, failures: [] });
    await expect(runtime.ingress.receiveEvents("route_1", challengeRequest()))
      .resolves.toMatchObject({ status: 200 });
    await expect(runtime.ingress.receiveEvents("route_b",
      challengeRequest("challenge_b", { teamId: "TB", appId: "AB" })))
      .resolves.toEqual({ status: 200, body: "challenge_b" });
    for (const organizationId of ["org_a", "org_b"]) expect(runtime.sourceApps.resolveDelivery({
      organizationId, appId: "slack", appInstanceId: "A1",
      bindingDigest: organizationId === "org_a" ? digest("binding") : digest("binding_b"),
      credentialGeneration: 1,
      credentialGenerationDigest: organizationId === "org_a" ? digest("generation") : digest("generation_b"),
    })).toBeDefined();
  });

  it("acks only after reservation, encrypted content, and processing job commit", async () => {
    await expect(components().ingress.receiveEvents(request())).resolves.toMatchObject({
      status: 200, body: { ok: true }
    });
    const counts = await fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM cp_ingress_reservation) reservations,
      (SELECT count(*)::int FROM cp_source_content) contents,
      (SELECT count(*)::int FROM cp_job WHERE job_kind='source_ingress.process') jobs`);
    expect(counts.rows[0]).toEqual({ reservations: 1, contents: 1, jobs: 1 });
  });

  it("returns non-success when transaction authority fails", async () => {
    await fixture.pool.query("UPDATE cp_source_binding SET state='disabled'");
    await expect(components().ingress.receiveEvents(request())).resolves.toMatchObject({ status: 503 });
    expect((await fixture.pool.query("SELECT count(*)::int count FROM cp_ingress_reservation")).rows[0])
      .toEqual({ count: 0 });
  });

  it("replays a committed delivery as one reservation and one processing job", async () => {
    const ingress = components().ingress;
    await ingress.receiveEvents(request()); await ingress.receiveEvents(request());
    const counts = await fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM cp_ingress_reservation) reservations,
      (SELECT count(*)::int FROM cp_job WHERE job_kind='source_ingress.process') jobs`);
    expect(counts.rows[0]).toEqual({ reservations: 1, jobs: 1 });
  });

  it("routes verified deletion to custody and creates no new reservation or Run", async () => {
    const ingress = components().ingress; await ingress.receiveEvents(request());
    await expect(ingress.receiveEvents(request("EvDelete", { type: "message",
      subtype: "message_deleted", user: "USLACKBOT", channel: "C1",
      ts: "1700000001.000100", deleted_ts: "1700000000.000100" })))
      .resolves.toMatchObject({ status: 200, body: { ok: true, withdrawn: true } });
    const counts = await fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM cp_ingress_reservation) reservations,
      (SELECT count(*)::int FROM cp_hosted_run) runs,
      (SELECT count(*)::int FROM cp_source_content WHERE deleted_at IS NOT NULL) deleted`);
    expect(counts.rows[0]).toEqual({ reservations: 1, runs: 0, deleted: 1 });
  });

  it("stores and deletes two exact triggering messages independently inside one Slack thread", async () => {
    const ingress = components().ingress;
    await ingress.receiveEvents(request("EvRoot", { type: "app_mention", user: "U1",
      text: "<@U_APP> first", ts: "1700000000.000100", channel: "C1" }));
    await ingress.receiveEvents(request("EvReply", { type: "app_mention", user: "U1",
      text: "<@U_APP> second", ts: "1700000001.000200",
      thread_ts: "1700000000.000100", channel: "C1" }));
    const identities = await fixture.pool.query(`SELECT source_message_id, source_version_ref
      FROM cp_ingress_reservation ORDER BY source_message_id`);
    expect(identities.rows).toEqual([
      { source_message_id: "1700000000.000100", source_version_ref: "slack:T1:C1:1700000000.000100" },
      { source_message_id: "1700000001.000200", source_version_ref: "slack:T1:C1:1700000001.000200" }
    ]);
    await ingress.receiveEvents(request("EvDeleteReply", { type: "message", subtype: "message_deleted",
      channel: "C1", deleted_ts: "1700000001.000200", ts: "1700000002.000100" }));
    expect((await fixture.pool.query(`SELECT source_message_id FROM cp_source_content
      WHERE deleted_at IS NOT NULL`)).rows).toEqual([{ source_message_id: "1700000001.000200" }]);
    await ingress.receiveEvents(request("EvDeleteRoot", { type: "message", subtype: "message_deleted",
      channel: "C1", deleted_ts: "1700000000.000100", ts: "1700000003.000100" }));
    expect((await fixture.pool.query(`SELECT source_message_id FROM cp_source_content
      WHERE deleted_at IS NOT NULL ORDER BY source_message_id`)).rows).toEqual([
      { source_message_id: "1700000000.000100" }, { source_message_id: "1700000001.000200" }
    ]);
  });

  it("resolves canonical installation identity and rejects wrong URL/team/app/channel before admission", async () => {
    await insertSlackInstallation();
    const { ingress } = productionComponents();

    await expect(ingress.receiveEvents("route_1", request())).resolves.toMatchObject({ status: 200 });
    await expect(ingress.receiveEvents("wrong_install", request("EvWrongInstall"))).resolves.toMatchObject({ status: 404 });
    await expect(ingress.receiveEvents("route_1", request("EvWrongTeam", undefined, { teamId: "T2" })))
      .resolves.toMatchObject({ status: 404 });
    await expect(ingress.receiveEvents("route_1", request("EvWrongApp", undefined, { appId: "A2" })))
      .resolves.toMatchObject({ status: 404 });
    await expect(ingress.receiveEvents("route_1", request("EvWrongChannel", {
      type: "app_mention", user: "U1", text: "<@U_APP> fix", ts: "1700000002.1", channel: "C2"
    }))).resolves.toMatchObject({ status: 404 });
  });

  it("answers only signed bounded challenges for the exact production installation without admission", async () => {
    await insertSlackInstallation();
    const { ingress } = productionComponents();

    await expect(ingress.receiveEvents("route_1", challengeRequest()))
      .resolves.toEqual({ status: 200, body: "challenge_abc123" });

    const invalidSignature = challengeRequest();
    invalidSignature.headers.set("x-slack-signature", "v0=invalid");
    await expect(ingress.receiveEvents("route_1", invalidSignature))
      .resolves.toMatchObject({ status: 401 });
    await expect(ingress.receiveEvents("wrong_install", challengeRequest()))
      .resolves.toMatchObject({ status: 404 });
    await expect(ingress.receiveEvents("route_1", challengeRequest("challenge_abc123", { teamId: "T2" })))
      .resolves.toMatchObject({ status: 404 });
    await expect(ingress.receiveEvents("route_1", challengeRequest("challenge_abc123", { appId: "A2" })))
      .resolves.toMatchObject({ status: 404 });
    for (const malformed of [null, "", "x".repeat(4097)]) {
      await expect(ingress.receiveEvents("route_1", challengeRequest(malformed)))
        .resolves.toEqual({ status: 400, body: { error: "invalid_slack_challenge" } });
    }

    const counts = await fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM cp_ingress_reservation) reservations,
      (SELECT count(*)::int FROM cp_job) jobs,
      (SELECT count(*)::int FROM cp_hosted_run) runs`);
    expect(counts.rows[0]).toEqual({ reservations: 0, jobs: 0, runs: 0 });
  });

  it("maps signature, malformed payload, secret failure, and guest invocation to typed statuses", async () => {
    await insertSlackInstallation(); const { ingress, material } = productionComponents();
    const invalid = request(); invalid.headers.set("x-slack-signature", "v0=invalid");
    await expect(ingress.receiveEvents("route_1", invalid)).resolves.toMatchObject({ status: 401 });
    const timestamp = String(Math.floor(now.getTime() / 1000)); const malformedBody = "{";
    const malformed = { rawBody: new TextEncoder().encode(malformedBody), headers: new Headers({
      "content-type": "application/json", "x-slack-request-timestamp": timestamp,
      "x-slack-signature": computeSlackSignature({ signingSecret: "secret", timestamp, rawBody: malformedBody })
    }), receivedAt: now.toISOString() };
    await expect(ingress.receiveEvents("route_1", malformed)).resolves.toMatchObject({ status: 400 });
    await expect(ingress.receiveEvents("route_1", request("EvGuest", { type: "app_mention",
      user: "U_GUEST", text: "<@U_APP> fix", ts: "1700000004.1", channel: "C1" })))
      .resolves.toMatchObject({ status: 403 });
    await expect(ingress.receiveEvents("route_1", request("EvMalformedMention", {
      type: "app_mention", user: "U1", text: "<@U_APP> fix", channel: "C1" })))
      .resolves.toMatchObject({ status: 400, body: { error: "slack_app_mention_malformed" } });
    await expect(ingress.receiveEvents("route_1", request("EvMissingUser", {
      type: "app_mention", text: "<@U_APP> fix", ts: "1700000005.2", channel: "C1" })))
      .resolves.toMatchObject({ status: 400, body: { error: "slack_app_mention_malformed" } });
    await expect(ingress.receiveEvents("route_1", request("EvMalformedDelete", {
      type: "message", subtype: "message_deleted", channel: "C1", ts: "1700000005.1" })))
      .resolves.toMatchObject({ status: 400, body: { error: "slack_deletion_malformed" } });
    await expect(ingress.receiveEvents("route_1", request("EvUnsupported", {
      type: "reaction_added", user: "U1", reaction: "eyes", channel: "C1" })))
      .resolves.toMatchObject({ status: 200, body: { ignored: true } });
    material.delete("secret://slack/signing");
    await expect(ingress.receiveEvents("route_1", request("EvSecret"))).resolves.toMatchObject({ status: 503 });
  });

  it("returns 400 for signed malformed interactivity rather than masking it as unavailable", async () => {
    await insertSlackInstallation(); const completed = { outcome: "completed" as const };
    const { ingress } = productionComponents({ commandAuthority: {
      async status() { return completed; }, async cancel() { return completed; },
      async approve() { return completed; }, async reject() { return completed; },
      async bind() { return completed; }, async unbind() { return completed; } } });
    await expect(ingress.receiveInteractivity("route_1", actionRequest({ type: "block_actions",
      api_app_id: "A1", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
      actions: [] }))).resolves.toMatchObject({ status: 400, body: { error: "invalid_slack_envelope" } });
  });

  it("authorizes opaque action tokens by exact install/thread/role/decision and consumes them once", async () => {
    await insertSlackInstallation(); const decisions: string[] = []; const envelopes: unknown[] = [];
    const frozenCeiling = { publicationMode: "proposal_only", network: ["api.example"] };
    const frozenCeilingDigest = await computeControlPayloadDigestV1(frozenCeiling);
    const actionDescriptor = "workspace.write";
    const actionDescriptorDigest = await computeControlPayloadDigestV1(actionDescriptor);
    const policyDigest = digest("policy"); const permissionRequestDigest = digest("permission");
    const fencingTokenDigest = digest("fence");
    await fixture.pool.query(`INSERT INTO cp_runner(organization_id,runner_id,registration_generation,
      credential_generation,current_credential_id,capabilities,created_at,updated_at)
      VALUES('org_a','runner_1',1,1,'credential_1','[]',$1,$1)`, [now]);
    await fixture.pool.query(`INSERT INTO cp_hosted_run(organization_id,run_id,admission_id,
      admission_operation_id,admission_digest,source_identity_digest,runner_id,executor_id,
      source_version_ref,source_content_ids,source_context_digest,queue_claim_deadline,
      permission_ceiling_digest,publication_mode,publication_policy_digest,completion_mode,
      completion_contract_digest,state,current_attempt_number,hosted_admission,
      admission_policy_snapshot,created_at,updated_at)
      VALUES('org_a','run_1','admission_1','operation_1',$1,$2,'runner_1','executor_1',
      'slack:T1:C1:1700000000.000100',ARRAY['content_1'],$3,$4,$5,'proposal_only',$6,
      'proposal_ready',$7,'needs_approval',1,'{}','{}',$8,$8)`,
      [digest("admission"), digest("source"), digest("context"),
        new Date(now.getTime() + 120_000), frozenCeilingDigest, policyDigest,
        digest("completion"), now]);
    await fixture.pool.query(`INSERT INTO cp_hosted_attempt(organization_id,run_id,attempt_number,
      attempt_id,runner_id,credential_id,fencing_token_digest,lease_expires_at,material_start_state,
      blocked_permission_request_id,blocked_action_descriptor_digest,blocked_policy_snapshot_digest,
      state,claimed_at,updated_at) VALUES('org_a','run_1',1,'attempt_1','runner_1','credential_1',$1,$2,
      'open','permission_1',$3,$4,'needs_approval',$5,$5)`,
      [fencingTokenDigest, new Date(now.getTime() + 60_000), actionDescriptorDigest, policyDigest, now]);
    await fixture.pool.query(`INSERT INTO cp_permission_request(organization_id,permission_request_id,
      run_id,runner_id,attempt_id,attempt_number,action_id,resolution_id,permission_request_digest,
      policy_snapshot_digest,state,request,current_receipt,created_at,updated_at)
      VALUES('org_a','permission_1','run_1','runner_1','attempt_1',1,'pending_action_1','resolution_1',
      $1,$2,'waiting',$3,'{}',$4,$4)`, [permissionRequestDigest, policyDigest,
      { attempt: { epoch: 1 } }, now]);
    let sequence = 0;
    const completed = { outcome: "completed" as const };
    const authority = { async status() { return completed; }, async cancel() { return completed; },
      async approve(command: any) { decisions.push(command.decision); envelopes.push(command.authority); return completed; },
      async reject() { decisions.push("deny"); return completed; }, async bind() { return completed; },
      async unbind() { return completed; } };
    const publicationApprove = vi.fn(async () => ({ kind: "approved" as const }));
    const { ingress } = productionComponents({ commandAuthority: authority,
      publicationAuthority: { approve: publicationApprove },
      tokenFactory: () => `opaque_action_token_${++sequence}_abcdefghijklmnopqrstuvwxyz` });
    const issue = (actionId: string, allowedDecisions: string[], actionKind: "status" | "cancel" | "approval" | "publication" | "bind" | "unbind" = "approval",
      override: Record<string, unknown> = {}) => ingress.issueAction({
      organizationId: "org_a", actionId, installationId: "install_1", bindingId: "binding_1",
      teamId: "T1", appId: "A1", channelId: "C1", threadRootMessageId: "1700000000.000100",
      runId: "run_1", pendingRequestId: "permission_1", actionKind,
      actionDescriptor: actionKind === "approval" ? actionDescriptor : { kind: actionKind, target: "frozen" },
      approvalEpoch: "1", frozenCeiling, policyDigest,
      runnerId: "runner_1", attemptId: "attempt_1", attemptNumber: 1, attemptEpoch: 1,
      fencingTokenDigest, permissionRequestDigest, pendingActionId: "pending_action_1",
      allowedDecisions, memberUserIds: ["U_MEMBER"], requesterUserId: "U_REQUESTER",
      operatorUserIds: ["U_OPERATOR"], approverUserId: "U_APPROVER", adminUserIds: ["U_ADMIN"],
      expiresAt: new Date(now.getTime() + 60_000), ...override });
    const action = (token: string, decision: string, userId = "U_APPROVER", thread = "1700000000.000100") =>
      actionRequest({ type: "block_actions", api_app_id: "A1", team: { id: "T1" }, user: { id: userId },
        channel: { id: "C1" }, container: { channel_id: "C1", thread_ts: thread,
          message_ts: "1700000005.1" }, frozen_ceiling: { publicationMode: "direct", secrets: ["all"] },
        actions: [{ action_id: `opentag:decision:${decision}`, value: token }] });
    const once = await issue("action_once", ["allow_once"]);
    await expect(ingress.receiveInteractivity("wrong_install", action(once, "allow_once")))
      .resolves.toMatchObject({ status: 404 });
    await expect(ingress.receiveInteractivity("route_1", action(once, "allow_once", "U_GUEST")))
      .resolves.toMatchObject({ status: 403 });
    await expect(ingress.receiveInteractivity("route_1", action(once, "allow_once", "U_APPROVER", "wrong")))
      .resolves.toMatchObject({ status: 403 });
    await expect(ingress.receiveInteractivity("route_1", action(once, "allow_run")))
      .resolves.toMatchObject({ status: 403 });
    await expect(ingress.receiveInteractivity("route_1", action(once, "allow_once")))
      .resolves.toMatchObject({ status: 200 });
    await expect(ingress.receiveInteractivity("route_1", action(once, "allow_once")))
      .resolves.toMatchObject({ status: 403 });
    const run = await issue("action_run", ["allow_run"]);
    await expect(ingress.receiveInteractivity("route_1", action(run, "allow_run")))
      .resolves.toMatchObject({ status: 200 });
    for (const [name, override] of [
      ["cross_run", { runId: "run_other" }],
      ["stale_epoch", { approvalEpoch: "epoch_stale" }],
      ["attempt_epoch", { attemptEpoch: 2 }],
      ["ceiling_mismatch", { frozenCeiling: { publicationMode: "pull_request" } }],
      ["policy_mismatch", { policyDigest: digest("other_policy") }]
    ] as const) {
      const stale = await issue(`action_${name}`, ["allow_once"], "approval", override);
      await expect(ingress.receiveInteractivity("route_1", action(stale, "allow_once")))
        .resolves.toMatchObject({ status: 403, body: { error: "slack_action_authority_stale" } });
    }
    const status = await issue("action_status", ["status"], "status");
    await expect(ingress.receiveInteractivity("route_1", action(status, "status", "U_GUEST")))
      .resolves.toMatchObject({ status: 403 });
    await expect(ingress.receiveInteractivity("route_1", action(status, "status", "U_MEMBER")))
      .resolves.toMatchObject({ status: 200 });
    const requesterCancel = await issue("action_cancel_requester", ["cancel"], "cancel");
    await expect(ingress.receiveInteractivity("route_1", action(requesterCancel, "cancel", "U_REQUESTER")))
      .resolves.toMatchObject({ status: 200 });
    const operatorCancel = await issue("action_cancel_operator", ["cancel"], "cancel");
    await expect(ingress.receiveInteractivity("route_1", action(operatorCancel, "cancel", "U_OPERATOR")))
      .resolves.toMatchObject({ status: 200 });
    const bind = await issue("action_bind", ["bind"], "bind");
    await expect(ingress.receiveInteractivity("route_1", action(bind, "bind", "U_MEMBER")))
      .resolves.toMatchObject({ status: 403 });
    await expect(ingress.receiveInteractivity("route_1", action(bind, "bind", "U_ADMIN")))
      .resolves.toMatchObject({ status: 200 });
    const publicationApproval = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.publication.v1"] as const, requestId: "request_publication",
      organizationId: "org_a", runnerId: "runner_1", runId: "run_1",
      ownershipId: "ownership_1", ownershipDigest: digest("ownership"),
      candidateId: "candidate_1", candidateDigest: digest("candidate"),
      approvalId: "approval_1", approvedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString() };
    const publication = await issue("action_publication", ["publication_approve"], "publication",
      { publicationApproval });
    await expect(ingress.receiveInteractivity("route_1",
      action(publication, "publication_approve", "U_MEMBER")))
      .resolves.toMatchObject({ status: 403 });
    await expect(ingress.receiveInteractivity("route_1",
      action(publication, "publication_approve", "U_APPROVER")))
      .resolves.toMatchObject({ status: 200 });
    expect(publicationApprove).toHaveBeenCalledWith({ ...publicationApproval,
      approverId: "U_APPROVER" });
    await issue("projection_status_source", ["status"], "status");
    await issue("projection_cancel_source", ["cancel"], "cancel");
    await issue("projection_publication_source", ["publication_approve", "publication_reject"],
      "publication", { publicationApproval });
    const projectedControls = await ingress.issueProjectionControls({
      organizationId: "org_a", runId: "run_1", generation: 1 });
    expect(projectedControls.map((control) => control.kind)).toEqual(expect.arrayContaining([
      "status", "cancel", "publication_approve"]));
    expect(projectedControls.map((control) => control.kind)).not.toContain("publication_reject");
    const familyStatus = projectedControls.find((control) => control.kind === "status")!;
    const familyCancel = projectedControls.find((control) => control.kind === "cancel")!;
    await expect(ingress.receiveInteractivity("route_1",
      action(familyCancel.actionId, "cancel", "U_REQUESTER"))).resolves.toMatchObject({ status: 200 });
    await expect(ingress.receiveInteractivity("route_1",
      action(familyStatus.actionId, "status", "U_MEMBER")))
      .resolves.toMatchObject({ status: 403, body: { error: "slack_action_not_authorized" } });
    const staleControls = [
      [await issue("stale_status", ["status"], "status"), "status", "U_MEMBER"],
      [await issue("stale_cancel", ["cancel"], "cancel"), "cancel", "U_REQUESTER"],
      [await issue("stale_approve", ["allow_once"], "approval"), "allow_once", "U_APPROVER"],
      [await issue("stale_reject", ["deny"], "approval"), "deny", "U_APPROVER"],
      [await issue("stale_publication", ["publication_approve"], "publication",
        { publicationApproval }), "publication_approve", "U_APPROVER"],
      [await issue("stale_bind", ["bind"], "bind"), "bind", "U_ADMIN"],
    ] as const;
    await fixture.pool.query(`INSERT INTO cp_hosted_attempt(organization_id,run_id,attempt_number,
      attempt_id,runner_id,credential_id,fencing_token_digest,lease_expires_at,material_start_state,
      state,claimed_at,updated_at)
      VALUES('org_a','run_1',2,'attempt_2','runner_1','credential_1',$1,$2,'open','claimed',$3,$3)`,
    [digest("fence_2"), new Date(now.getTime() + 60_000), now]);
    await fixture.pool.query(`UPDATE cp_hosted_run SET current_attempt_number=2,updated_at=$1
      WHERE organization_id='org_a' AND run_id='run_1'`, [now]);
    for (const [token, decision, actorId] of staleControls) {
      await expect(ingress.receiveInteractivity("route_1", action(token, decision, actorId)))
        .resolves.toMatchObject({ status: 403, body: { error: "slack_action_authority_stale" } });
    }
    let crash = true; let crashToken = 0;
    const cancelCalls: string[] = [];
    const crashRuntime = productionComponents({ commandAuthority: {
      ...authority, async cancel(command: any) { cancelCalls.push(command.commandId); return completed; } },
      tokenFactory: () => `opaque_crash_token_${++crashToken}_abcdefghijklmnopqrstuvwxyz`,
      testHooks: { async afterServiceBeforeFinalize() { if (crash) { crash = false;
        throw new Error("crash_after_service"); } } } });
    const issueCrash = (actionId: string, decision: "status" | "cancel") =>
      crashRuntime.ingress.issueAction({ organizationId: "org_a", actionId,
        installationId: "install_1", bindingId: "binding_1", teamId: "T1", appId: "A1",
        channelId: "C1", threadRootMessageId: "1700000000.000100", runId: "run_1",
        pendingRequestId: "permission_1", actionKind: decision, actionDescriptor: { kind: decision },
        approvalEpoch: "2", frozenCeiling, policyDigest, runnerId: "runner_1",
        attemptId: "attempt_2", attemptNumber: 2, attemptEpoch: 2,
        projectionGeneration: 2, authorityEpoch: 2, authorityFamilyId: "family_crash",
        fencingTokenDigest: digest("fence_2"), permissionRequestDigest,
        pendingActionId: "pending_action_1", allowedDecisions: [decision],
        memberUserIds: ["U_MEMBER"], requesterUserId: "U_REQUESTER",
        operatorUserIds: ["U_OPERATOR"], approverUserId: "U_APPROVER",
        adminUserIds: ["U_ADMIN"], expiresAt: new Date(now.getTime()+60_000) });
    const crashStatus = await issueCrash("crash_status", "status");
    const crashCancel = await issueCrash("crash_cancel", "cancel");
    await expect(crashRuntime.ingress.receiveInteractivity("route_1",
      action(crashCancel, "cancel", "U_REQUESTER"))).resolves.toMatchObject({ status: 503 });
    await expect(crashRuntime.ingress.receiveInteractivity("route_1",
      action(crashCancel, "cancel", "U_REQUESTER"))).resolves.toMatchObject({ status: 200 });
    await expect(crashRuntime.ingress.receiveInteractivity("route_1",
      action(crashStatus, "status", "U_MEMBER"))).resolves.toMatchObject({ status: 403 });
    expect(cancelCalls).toEqual(["crash_cancel", "crash_cancel"]);
    let poolToken = 0;
    const poolRuntime = productionComponents({ commandAuthority: { ...authority,
      async status() { await fixture.pool.query("SELECT 1"); return completed; } },
      tokenFactory: () => `opaque_pool_token_${++poolToken}_abcdefghijklmnopqrstuvwxyz` });
    const poolActions = await Promise.all(Array.from({ length: 8 }, async (_, index) =>
      poolRuntime.ingress.issueAction({ organizationId: "org_a", actionId: `pool_status_${index}`,
        installationId: "install_1", bindingId: "binding_1", teamId: "T1", appId: "A1",
        channelId: "C1", threadRootMessageId: "1700000000.000100", runId: "run_1",
        pendingRequestId: "permission_1", actionKind: "status", actionDescriptor: { kind: "status" },
        approvalEpoch: "2", frozenCeiling, policyDigest, runnerId: "runner_1",
        attemptId: "attempt_2", attemptNumber: 2, attemptEpoch: 2, projectionGeneration: 2,
        authorityEpoch: 2, authorityFamilyId: `pool_family_${index}`,
        fencingTokenDigest: digest("fence_2"), permissionRequestDigest,
        pendingActionId: "pending_action_1", allowedDecisions: ["status"],
        memberUserIds: ["U_MEMBER"], requesterUserId: "U_REQUESTER",
        operatorUserIds: ["U_OPERATOR"], approverUserId: "U_APPROVER",
        adminUserIds: ["U_ADMIN"], expiresAt: new Date(now.getTime()+60_000) })));
    const poolResults = await Promise.all(poolActions.map((token) =>
      poolRuntime.ingress.receiveInteractivity("route_1", action(token, "status", "U_MEMBER"))));
    expect(poolResults.map((result) => result.status)).toEqual(Array(8).fill(200));
    expect(decisions).toEqual(["allow_once", "allow_run"]);
    expect(envelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ selectedDecision: "allow_once", allowedDecisions: ["allow_once"] }),
      expect.objectContaining({ selectedDecision: "allow_run", allowedDecisions: ["allow_run"] })
    ]));
  });
});
