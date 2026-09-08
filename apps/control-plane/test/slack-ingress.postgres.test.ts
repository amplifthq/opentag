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
  const installation = { organizationId: "org_a", appInstanceId: "install_1", bindingDigest: digest("binding"),
    credentialGeneration: 1, credentialGenerationDigest: digest("generation") };

  beforeEach(async () => {
    fixture = await createIsolatedPostgres(); await fixture.migrate();
    await fixture.pool.query("INSERT INTO cp_organization(organization_id, display_name) VALUES('org_a','A')");
    await fixture.pool.query(`INSERT INTO cp_slack_binding(organization_id,binding_id,
      installation_id,binding_digest,state,credential_generation,credential_generation_digest,
      route_identity,team_id,app_id,channel_id,bot_user_id,member_user_ids,operator_user_ids,
      approver_user_id,admin_user_ids,signing_secret_ref,bot_token_ref,publication_mode,
      created_at,updated_at) VALUES('org_a','binding_1','install_1',$1,'active',1,$2,
      'route_1','T1','A1','C1','U_APP',
      ARRAY['U1','U_MEMBER','U_REQUESTER','U_OPERATOR','U_APPROVER','U_ADMIN'],
      ARRAY['U_OPERATOR'],'U_APPROVER',ARRAY['U_ADMIN'],
      'secret://slack/signing','secret://slack/bot','proposal_only',$3,$3)`,
    [installation.bindingDigest,installation.credentialGenerationDigest,now]);
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
    const body = JSON.stringify({ type: "url_verification", challenge,
      ...(identity.teamId ? { team_id: identity.teamId } : {}),
      ...(identity.appId ? { api_app_id: identity.appId } : {}) });
    const timestamp = String(Math.floor(now.getTime() / 1000));
    return { rawBody: new TextEncoder().encode(body), headers: new Headers({
      "content-type": "application/json", "x-slack-request-timestamp": timestamp,
      "x-slack-signature": computeSlackSignature({ signingSecret: "secret", timestamp, rawBody: body })
    }), receivedAt: now.toISOString() };
  }

  async function insertSlackInstallation() {
    return Promise.resolve();
  }

  function productionComponents(input: { commandAuthority?: any; effectAuthority?: any;
    tokenFactory?: () => string; testHooks?: any; clock?: { now(): Date } } = {}) {
    const material = new Map([
      ["secret://slack/signing", "secret"], ["secret://slack/bot", "bot-token"]
    ]);
    const clock = input.clock ?? { now: () => now };
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
      ...(input.effectAuthority ? { effectAuthority: input.effectAuthority } : {}),
      ...(input.testHooks ? { testHooks: input.testHooks } : {}),
      ...(input.tokenFactory ? { tokenFactory: input.tokenFactory } : {}),
      fetchImpl: async () => { throw new Error("provider_call_forbidden"); } }) };
  }

  it("does not project orphan approval authority without a current permission request", async () => {
    await insertSlackInstallation();
    let tick = 0;
    const { ingress } = productionComponents({ clock: { now: () => new Date(now.getTime() + tick++ * 1000) } });
    await ingress.issueAction({ organizationId: "org_a", actionId: "approval_refresh_source",
      installationId: "install_1", bindingId: "binding_1", teamId: "T1", appId: "A1", channelId: "C1",
      threadRootMessageId: "1700000000.000100", runId: "run_refresh", pendingRequestId: "permission_refresh",
      actionKind: "approval", actionDescriptor: "workspace.write", approvalEpoch: "1",
      frozenCeiling: ["workspace.write"], policyDigest: digest("policy"), runnerId: "runner_1",
      attemptId: "attempt_1", attemptNumber: 1, attemptEpoch: 1, fencingTokenDigest: digest("fence"),
      permissionRequestDigest: digest("permission"), pendingActionId: "action_refresh",
      allowedDecisions: ["allow_once", "deny"], requesterUserId: "U_REQUESTER", memberUserIds: ["U_MEMBER"],
      operatorUserIds: [], approverUserId: "U_APPROVER", adminUserIds: [],
      expiresAt: new Date(now.getTime() + 60_000) });
    for (let refresh = 0; refresh < 4; refresh += 1) {
      const controls = await ingress.issueProjectionControls({ organizationId: "org_a", runId: "run_refresh", generation: 1 });
      expect(controls).toEqual([]);
    }
    const nestedCopies = await fixture.pool.query(`SELECT action_id FROM cp_slack_action_authority
      WHERE run_id='run_refresh' AND action_id LIKE '%:projection:%:projection:%'`);
    expect(nestedCopies.rows).toEqual([]);
  });

  it("preloads healthy active installations while isolating broken and disabled rows", async () => {
    await insertSlackInstallation();
    for (const [suffix, state, secretRef] of [["2", "active", "secret://missing"],
      ["3", "disabled", "secret://slack/signing"]] as const) {
      await fixture.pool.query(`INSERT INTO cp_slack_binding(organization_id,binding_id,
        installation_id,binding_digest,state,credential_generation,credential_generation_digest,
        route_identity,team_id,app_id,channel_id,bot_user_id,member_user_ids,
        signing_secret_ref,bot_token_ref,created_at,updated_at)
        VALUES('org_a',$1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,ARRAY['U1'],$11,
          'secret://slack/bot',$12,$12)`,
      [`binding_${suffix}`,`install_${suffix}`,digest(`binding_${suffix}`),state,
        digest(`generation_${suffix}`),`route_${suffix}`,`T${suffix}`,`A${suffix}`,
        `C${suffix}`,`U${suffix}`,secretRef,now]);
    }
    const runtime = productionComponents();
    await expect(runtime.ingress.preloadSourceApps()).resolves.toEqual({ registered: 1,
      healthy: [{ organizationId: "org_a", appId: "slack", appInstanceId: "install_1",
        bindingDigest: digest("binding"), credentialGeneration: 1,
        credentialGenerationDigest: digest("generation") }],
      failures: [{ organizationId: "org_a", installationId: "install_2",
        errorCode: "slack_installation_preload_failed",
        evidenceDigest: expect.stringMatching(/^sha256:/u) }] });
    expect(runtime.sourceApps.resolveDelivery({ organizationId: "org_a", appId: "slack",
      appInstanceId: "install_1", bindingDigest: digest("binding"), credentialGeneration: 1,
      credentialGenerationDigest: digest("generation") })).toBeDefined();
    for (const suffix of ["2", "3"]) expect(runtime.sourceApps.resolveDelivery({
      organizationId: "org_a", appId: "slack", appInstanceId: `install_${suffix}`,
      bindingDigest: digest(`binding_${suffix}`), credentialGeneration: 1,
      credentialGenerationDigest: digest(`generation_${suffix}`) })).toBeUndefined();
    runtime.material.set("secret://missing", "recovered-signing-secret");
    await expect(runtime.ingress.preloadSourceApps()).resolves.toMatchObject({ registered: 2,
      failures: [] });
    expect(runtime.sourceApps.resolveDelivery({ organizationId: "org_a", appId: "slack",
      appInstanceId: "install_2", bindingDigest: digest("binding_2"), credentialGeneration: 1,
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
      appInstanceId: "install_1", bindingDigest: digest("binding"), credentialGeneration: 1,
      credentialGenerationDigest: digest("generation") })).toBeDefined();
    expect(runtime.sourceApps.deliveryAuthorities()).toEqual([{ organizationId: "org_a",
      appId: "slack", appInstanceId: "install_1", bindingDigest: digest("binding"),
      credentialGeneration: 1, credentialGenerationDigest: digest("generation") }]);
  });

  it("routes the same installation id independently across organizations", async () => {
    await insertSlackInstallation();
    await fixture.pool.query("INSERT INTO cp_organization(organization_id,display_name) VALUES('org_b','B')");
    await fixture.pool.query(`INSERT INTO cp_slack_binding(organization_id,binding_id,
      installation_id,binding_digest,state,credential_generation,credential_generation_digest,
      route_identity,team_id,app_id,channel_id,bot_user_id,member_user_ids,
      signing_secret_ref,bot_token_ref,created_at,updated_at)
      VALUES('org_b','binding_b','install_1',$1,'active',1,$2,'route_b','TB','AB','CB','UB',
        ARRAY['U1'],'secret://slack/signing','secret://slack/bot',$3,$3)`,
    [digest("binding_b"),digest("generation_b"),now]);
    const runtime = productionComponents();
    await expect(runtime.ingress.preloadSourceApps()).resolves.toMatchObject({
      registered: 2, failures: [],
    });
    await expect(runtime.ingress.receiveEvents("route_1", challengeRequest()))
      .resolves.toMatchObject({ status: 200 });
    await expect(runtime.ingress.receiveEvents("route_b",
      challengeRequest("challenge_b", { teamId: "TB", appId: "AB" })))
      .resolves.toEqual({ status: 200, body: "challenge_b" });
    for (const organizationId of ["org_a", "org_b"]) expect(runtime.sourceApps.resolveDelivery({
      organizationId, appId: "slack", appInstanceId: "install_1",
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
    await fixture.pool.query("UPDATE cp_slack_binding SET state='disabled'");
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
      .resolves.toMatchObject({ status: 200, body: { ok: true, ignored: true } });
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
      attempt_id,runner_id,credential_id,fencing_token_digest,claim_operation_id,
      claim_request_digest,claim,lease_expires_at,material_start_state,
      blocked_permission_request_id,blocked_action_descriptor_digest,blocked_policy_snapshot_digest,
      state,claimed_at,updated_at) VALUES('org_a','run_1',1,'attempt_1','runner_1','credential_1',$1,
      'operation_slack_1','request_digest_slack_1','{}'::jsonb,$2,
      'open','permission_1',$3,$4,'needs_approval',$5,$5)`,
      [fencingTokenDigest, new Date(now.getTime() + 60_000), actionDescriptorDigest, policyDigest, now]);
    await fixture.pool.query(`INSERT INTO cp_permission_request(organization_id,permission_request_id,
      run_id,runner_id,attempt_id,attempt_number,action_id,resolution_id,permission_request_digest,
      policy_snapshot_digest,state,request,current_receipt,created_at,updated_at)
      VALUES('org_a','permission_1','run_1','runner_1','attempt_1',1,'pending_action_1','resolution_1',
      $1,$2,'waiting',$3,'{}',$4,$4)`, [permissionRequestDigest, policyDigest,
      { attempt: { epoch: 1 }, actionDescriptorDigest }, now]);
    const effectTargetBindingDigest = digest("effect-binding");
    const effectTarget = { projectTargetId: "target_effect_action",
      targetBindingDigest: effectTargetBindingDigest, targetBindingGeneration: 1,
      provider: "github", owner: "acme", repo: "demo", remote: "origin",
      baseBranch: "main", branch: "opentag/run_1", frozenBaseRevision: "a".repeat(40),
      workspaceTreeDigest: "b".repeat(40), expectedHeadSha: "c".repeat(40) };
    const effectCandidate = { candidateId: "candidate_effect_action", runId: "run_1",
      attemptId: "attempt_1", projectTargetId: effectTarget.projectTargetId,
      frozenBaseRevision: effectTarget.frozenBaseRevision,
      workspaceTreeDigest: effectTarget.workspaceTreeDigest,
      patchDigest: digest("effect-patch"), changedFiles: ["effect.ts"],
      verificationEvidenceIds: [digest("effect-verification")],
      publicationPolicyDigest: policyDigest, createdAt: now.toISOString() };
    const effectCandidateDigest = await computeControlPayloadDigestV1(effectCandidate);
    await fixture.pool.query(`UPDATE cp_slack_binding SET project_target_id=$1,
      publication_mode='pull_request' WHERE organization_id='org_a' AND installation_id='install_1'`,
    [effectTarget.projectTargetId]);
    await fixture.pool.query(`INSERT INTO cp_project_target(organization_id,project_target_id,
      runner_id,binding_digest,provider,owner,repo,default_executor,default_branch,updated_at,
      binding_generation) VALUES('org_a',$1,'runner_1',$2,'github','acme','demo',
      'executor_1','main',$3,1)`, [effectTarget.projectTargetId,effectTargetBindingDigest,now]);
    await fixture.pool.query(`INSERT INTO cp_publication_candidate(organization_id,candidate_id,
      run_id,attempt_id,attempt_number,project_target_id,frozen_base_revision,workspace_tree_digest,
      patch_digest,changed_files,verification_evidence_ids,publication_policy_digest,candidate,
      completion_assessment,created_at) VALUES('org_a',$1,'run_1','attempt_1',1,$2,$3,$4,$5,$6,$7,
      $8,$9::jsonb,$10::jsonb,$11)`, [effectCandidate.candidateId,effectTarget.projectTargetId,
      effectTarget.frozenBaseRevision,effectTarget.workspaceTreeDigest,effectCandidate.patchDigest,
      effectCandidate.changedFiles,effectCandidate.verificationEvidenceIds,policyDigest,
      JSON.stringify(effectCandidate),JSON.stringify({ state:"proposal_ready",accepted:false,
        candidateId:effectCandidate.candidateId,reasonCodes:["publication_pending"],
        assessedAt:now.toISOString() }),now]);
    await fixture.pool.query(`INSERT INTO cp_effect(organization_id,effect_id,idempotency_key,
      effect_kind,request_id,request_digest,runner_id,runner_generation,run_id,run_attempt_id,
      run_attempt_number,fencing_token_digest,candidate_id,candidate_digest,project_target_id,
      target_binding_digest,target_binding_generation,target_digest,target,policy_snapshot_id,
      policy_snapshot_digest,approval_request_id,approval_request_digest,approval_expires_at,
      state,current_attempt_number,requested_at,created_at,updated_at)
      VALUES('org_a','effect_action','effect:run_1:draft-pr','github.create_draft_pull_request',
      'request_effect_action',$1,'runner_1',1,'run_1','attempt_1',1,$2,$3,$4,$5,$6,1,$7,$8::jsonb,
      'policy_effect_action',$9,'approval_request_effect_action',$10,$11,'requested',0,$12,$12,$12)`,
    [digest("effect-request"),fencingTokenDigest,effectCandidate.candidateId,effectCandidateDigest,
      effectTarget.projectTargetId,effectTargetBindingDigest,digest("effect-target"),
      JSON.stringify(effectTarget),policyDigest,digest("effect-approval-request"),
      new Date(now.getTime()+60_000),now]);
    let sequence = 0;
    const completed = { outcome: "completed" as const };
    const authority = { async status() { return completed; }, async cancel() { return completed; },
      async approve(command: any) { decisions.push(command.decision); envelopes.push(command.authority); return completed; },
      async reject() { decisions.push("deny"); return completed; }, async bind() { return completed; },
      async unbind() { return completed; } };
    const { ingress } = productionComponents({ commandAuthority: authority,
      tokenFactory: () => `opaque_action_token_${++sequence}_abcdefghijklmnopqrstuvwxyz` });
    const issue = (actionId: string, allowedDecisions: string[], actionKind: "status" | "cancel" | "approval" | "effect" | "bind" | "unbind" = "approval",
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
    await issue("projection_status_source", ["status"], "status");
    await issue("projection_cancel_source", ["cancel"], "cancel");
    const projectedControls = await ingress.issueProjectionControls({
      organizationId: "org_a", runId: "run_1", generation: 1 });
    expect(projectedControls.map((control) => control.kind)).toEqual(expect.arrayContaining([
      "status", "cancel"]));
    const projectedCountBefore = Number((await fixture.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM cp_slack_action_authority
       WHERE action_id LIKE '%:projection:%'`)).rows[0]?.count ?? 0);
    const collisionRuntime = productionComponents({ commandAuthority: authority,
      tokenFactory: () => "opaque_projection_collision_token_abcdefghijklmnopqrstuvwxyz" });
    await expect(collisionRuntime.ingress.issueProjectionControls({
      organizationId: "org_a", runId: "run_1", generation: 1 }))
      .rejects.toMatchObject({ code: "23505" });
    const projectedCountAfter = Number((await fixture.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM cp_slack_action_authority
       WHERE action_id LIKE '%:projection:%'`)).rows[0]?.count ?? 0);
    expect(projectedCountAfter).toBe(projectedCountBefore);
    const familyStatus = projectedControls.find((control) => control.kind === "status")!;
    const familyCancel = projectedControls.find((control) => control.kind === "cancel")!;
    await expect(ingress.receiveInteractivity("route_1",
      action(familyCancel.actionId, "cancel", "U_REQUESTER"))).resolves.toMatchObject({ status: 200 });
    await expect(ingress.receiveInteractivity("route_1",
      action(familyStatus.actionId, "status", "U_MEMBER")))
      .resolves.toMatchObject({ status: 403, body: { error: "slack_action_not_authorized" } });
    const statusThenStatus = await issue("family_status_then_status", ["status"], "status",
      { authorityFamilyId: "family_status_then_cancel" });
    const statusThenCancel = await issue("family_status_then_cancel", ["cancel"], "cancel",
      { authorityFamilyId: "family_status_then_cancel" });
    await expect(ingress.receiveInteractivity("route_1",
      action(statusThenStatus, "status", "U_MEMBER"))).resolves.toMatchObject({ status: 200 });
    await expect(ingress.receiveInteractivity("route_1",
      action(statusThenCancel, "cancel", "U_REQUESTER"))).resolves.toMatchObject({ status: 200 });
    const statusAllowStatus=await issue("status_allow_status",["status"],"status",
      {authorityFamilyId:"family_status_allow"});
    const statusAllow=await issue("status_allow_once",["allow_once"],"approval",
      {authorityFamilyId:"family_status_allow"});
    await expect(ingress.receiveInteractivity("route_1",action(statusAllowStatus,"status","U_MEMBER")))
      .resolves.toMatchObject({status:200});
    await expect(ingress.receiveInteractivity("route_1",action(statusAllow,"allow_once","U_APPROVER")))
      .resolves.toMatchObject({status:200});
    await expect(ingress.receiveInteractivity("route_1",action(statusAllowStatus,"status","U_MEMBER")))
      .resolves.toMatchObject({status:403});
    const statusDenyStatus=await issue("status_deny_status",["status"],"status",
      {authorityFamilyId:"family_status_deny"});
    const statusDeny=await issue("status_deny",["deny"],"approval",
      {authorityFamilyId:"family_status_deny"});
    await expect(ingress.receiveInteractivity("route_1",action(statusDenyStatus,"status","U_MEMBER")))
      .resolves.toMatchObject({status:200});
    await expect(ingress.receiveInteractivity("route_1",action(statusDeny,"deny","U_APPROVER")))
      .resolves.toMatchObject({status:200});
    const raceCancel = await issue("race_family_cancel", ["cancel"], "cancel",
      { authorityFamilyId: "family_cancel_approve" });
    const raceApprove = await issue("race_family_approve", ["allow_once"], "approval",
      { authorityFamilyId: "family_cancel_approve" });
    const raceOutcomes = await Promise.all([
      ingress.receiveInteractivity("route_1", action(raceCancel, "cancel", "U_REQUESTER")),
      ingress.receiveInteractivity("route_1", action(raceApprove, "allow_once", "U_APPROVER")),
    ]);
    expect(raceOutcomes.map((outcome) => outcome.status).sort()).toEqual([200, 403]);
    const raceAllow = await issue("race_family_allow", ["allow_once"], "approval",
      { authorityFamilyId: "family_allow_deny" });
    const raceDeny = await issue("race_family_deny", ["deny"], "approval",
      { authorityFamilyId: "family_allow_deny" });
    const decisionRace = await Promise.all([
      ingress.receiveInteractivity("route_1", action(raceAllow, "allow_once", "U_APPROVER")),
      ingress.receiveInteractivity("route_1", action(raceDeny, "deny", "U_APPROVER")),
    ]);
    expect(decisionRace.map((outcome) => outcome.status).sort()).toEqual([200, 403]);
    const effectApproval = {
      organizationId: "org_a", effectId: "effect_action",
      effectKind: "github.create_draft_pull_request" as const,
      requestId: "request_effect_action", requestDigest: digest("effect-request"),
      runnerId: "runner_1", runnerGeneration: 1, runId: "run_1",
      attemptId: "attempt_1", attemptNumber: 1, fencingTokenDigest,
      candidateId: effectCandidate.candidateId, candidateDigest: effectCandidateDigest,
      projectTargetId: effectTarget.projectTargetId, targetBindingDigest: effectTargetBindingDigest,
      targetBindingGeneration: 1, policySnapshotId: "policy_effect_action",
      policySnapshotDigest: policyDigest, approvalRequestId: "approval_request_effect_action",
      approvalRequestDigest: digest("effect-approval-request"),
      approvalId: "effect_approval_action",
      approvalExpiresAt: new Date(now.getTime()+60_000).toISOString(),
    };
    const effectActionDescriptor = { kind: "effect_approve", effectId: effectApproval.effectId,
      requestDigest: effectApproval.requestDigest, candidateId: effectApproval.candidateId };
    const effectFrozenCeiling = { effectKind: effectApproval.effectKind,
      candidate: { candidateId: effectApproval.candidateId,
        candidateDigest: effectApproval.candidateDigest }, target: effectTarget,
      policy: { snapshotId: effectApproval.policySnapshotId,
        snapshotDigest: effectApproval.policySnapshotDigest } };
    let effectNow = now; let failEffectFinalize = true; const effectApprovals: any[] = [];
    const effectRuntime = productionComponents({ commandAuthority: authority,
      clock: { now: () => effectNow },
      effectAuthority: { async approve(command: any) { effectApprovals.push(command);
        if (effectApprovals.length === 1) await fixture.pool.query(
          `UPDATE cp_effect SET approval_id=$3,approval_digest=$4,approval=$5::jsonb,
             state='authorized',updated_at=$6 WHERE organization_id=$1 AND effect_id=$2`,
          [command.organizationId,command.effectId,command.approvalId,digest("effect-approval"),
            JSON.stringify({ approvalRequestId:command.approvalRequestId,
              approvalRequestDigest:command.approvalRequestDigest,approvalId:command.approvalId,
              approvedBy:command.approvedBy,approvedAt:command.approvedAt }),effectNow]);
        return { kind: effectApprovals.length === 1 ? "approved" as const : "replayed" as const }; } },
      testHooks: { async afterServiceBeforeFinalize() {
        if (failEffectFinalize) { failEffectFinalize = false; throw new Error("effect_finalize_crash"); }
      } }, tokenFactory: () => "opaque_effect_action_token_abcdefghijklmnopqrstuvwxyz" });
    const effectToken = await effectRuntime.ingress.issueAction({ organizationId: "org_a",
      actionId: "action_effect", installationId: "install_1", bindingId: "binding_1",
      teamId: "T1", appId: "A1", channelId: "C1",
      threadRootMessageId: "1700000000.000100", runId: "run_1",
      pendingRequestId: effectApproval.approvalRequestId, actionKind: "effect",
      actionDescriptor: effectActionDescriptor, approvalEpoch: "1",
      frozenCeiling: effectFrozenCeiling, policyDigest,
      runnerId: "runner_1", attemptId: "attempt_1", attemptNumber: 1, attemptEpoch: 1,
      projectionGeneration: 1, authorityEpoch: 1, fencingTokenDigest,
      permissionRequestDigest: effectApproval.approvalRequestDigest,
      pendingActionId: effectApproval.effectId, allowedDecisions: ["effect_approve"],
      memberUserIds: ["U_MEMBER"], requesterUserId: "U_REQUESTER",
      operatorUserIds: ["U_OPERATOR"], approverUserId: "U_APPROVER",
      adminUserIds: ["U_ADMIN"], effectApproval,
      expiresAt: new Date(now.getTime()+60_000) });
    await expect(effectRuntime.ingress.receiveInteractivity("route_1",
      action(effectToken,"effect_approve","U_MEMBER"))).resolves.toMatchObject({status:403});
    await expect(effectRuntime.ingress.receiveInteractivity("route_1",
      action(effectToken,"effect_approve","U_APPROVER"))).resolves.toMatchObject({status:503});
    effectNow = new Date(now.getTime()+1_000);
    await expect(effectRuntime.ingress.receiveInteractivity("route_1",
      action(effectToken,"effect_approve","U_APPROVER"))).resolves.toMatchObject({status:200});
    expect(effectApprovals).toHaveLength(2);
    expect(effectApprovals[1]).toEqual(effectApprovals[0]);
    expect((await fixture.pool.query(`SELECT claim_state,consumed_at IS NOT NULL AS consumed
      FROM cp_slack_action_authority WHERE organization_id='org_a' AND action_id='action_effect'`)).rows)
      .toEqual([{claim_state:"consumed",consumed:true}]);
    const staleControls = [
      [await issue("stale_status", ["status"], "status"), "status", "U_MEMBER"],
      [await issue("stale_cancel", ["cancel"], "cancel"), "cancel", "U_REQUESTER"],
      [await issue("stale_approve", ["allow_once"], "approval"), "allow_once", "U_APPROVER"],
      [await issue("stale_reject", ["deny"], "approval"), "deny", "U_APPROVER"],
      [await issue("stale_bind", ["bind"], "bind"), "bind", "U_ADMIN"],
    ] as const;
    await fixture.pool.query(`INSERT INTO cp_hosted_attempt(organization_id,run_id,attempt_number,
      attempt_id,runner_id,credential_id,fencing_token_digest,claim_operation_id,
      claim_request_digest,claim,lease_expires_at,material_start_state,
      state,claimed_at,updated_at)
      VALUES('org_a','run_1',2,'attempt_2','runner_1','credential_1',$1,
      'operation_slack_2','request_digest_slack_2','{}'::jsonb,$2,'open','claimed',$3,$3)`,
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
    expect(decisions).toEqual(expect.arrayContaining(["allow_once", "allow_run"]));
    expect(envelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ selectedDecision: "allow_once", allowedDecisions: ["allow_once"] }),
      expect.objectContaining({ selectedDecision: "allow_run", allowedDecisions: ["allow_run"] })
    ]));
  });
});
