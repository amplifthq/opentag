import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSlackSignature, createSlackSourceApp } from "@opentag/slack";
import { createDurableJobQueue } from "../src/modules/jobs/index.js";
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
import { createSourceIngressService } from "../src/modules/source-ingress/index.js";
import { createPostgresSlackIngress, createSlackIngressForTest } from "../src/modules/slack-ingress/index.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const now = new Date("2026-08-30T00:00:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)("Slack durable ingress", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const installation = { appInstanceId: "A1", bindingDigest: digest("binding"),
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

  async function insertSlackInstallation() {
    await fixture.pool.query(`INSERT INTO cp_slack_installation(
      organization_id, installation_id, binding_id, team_id, app_id, channel_id,
      bot_user_id, member_user_ids, signing_secret_ref, bot_token_ref, created_at, updated_at)
      VALUES('org_a','install_1','binding_1','T1','A1','C1','U_APP',
        ARRAY['U1','U_MEMBER','U_REQUESTER','U_OPERATOR','U_APPROVER','U_ADMIN'],
        'secret://slack/signing','secret://slack/bot',$1,$1)`, [now]);
  }

  function productionComponents(input: { commandAuthority?: any; tokenFactory?: () => string } = {}) {
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
    return { material, ingress: createPostgresSlackIngress({ pool: fixture.pool, clock, custody,
      jobs, secrets: { async resolve(reference) {
        const value = material.get(reference); if (!value) throw new Error("secret_unavailable");
        return value;
      } }, ...(input.commandAuthority ? { commandAuthority: input.commandAuthority } : {}),
      ...(input.tokenFactory ? { tokenFactory: input.tokenFactory } : {}),
      fetchImpl: async () => { throw new Error("provider_call_forbidden"); } }) };
  }

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

    await expect(ingress.receiveEvents("install_1", request())).resolves.toMatchObject({ status: 200 });
    await expect(ingress.receiveEvents("wrong_install", request("EvWrongInstall"))).resolves.toMatchObject({ status: 404 });
    await expect(ingress.receiveEvents("install_1", request("EvWrongTeam", undefined, { teamId: "T2" })))
      .resolves.toMatchObject({ status: 404 });
    await expect(ingress.receiveEvents("install_1", request("EvWrongApp", undefined, { appId: "A2" })))
      .resolves.toMatchObject({ status: 404 });
    await expect(ingress.receiveEvents("install_1", request("EvWrongChannel", {
      type: "app_mention", user: "U1", text: "<@U_APP> fix", ts: "1700000002.1", channel: "C2"
    }))).resolves.toMatchObject({ status: 404 });
  });

  it("maps signature, malformed payload, secret failure, and guest invocation to typed statuses", async () => {
    await insertSlackInstallation(); const { ingress, material } = productionComponents();
    const invalid = request(); invalid.headers.set("x-slack-signature", "v0=invalid");
    await expect(ingress.receiveEvents("install_1", invalid)).resolves.toMatchObject({ status: 401 });
    const timestamp = String(Math.floor(now.getTime() / 1000)); const malformedBody = "{";
    const malformed = { rawBody: new TextEncoder().encode(malformedBody), headers: new Headers({
      "content-type": "application/json", "x-slack-request-timestamp": timestamp,
      "x-slack-signature": computeSlackSignature({ signingSecret: "secret", timestamp, rawBody: malformedBody })
    }), receivedAt: now.toISOString() };
    await expect(ingress.receiveEvents("install_1", malformed)).resolves.toMatchObject({ status: 400 });
    await expect(ingress.receiveEvents("install_1", request("EvGuest", { type: "app_mention",
      user: "U_GUEST", text: "<@U_APP> fix", ts: "1700000004.1", channel: "C1" })))
      .resolves.toMatchObject({ status: 403 });
    material.delete("secret://slack/signing");
    await expect(ingress.receiveEvents("install_1", request("EvSecret"))).resolves.toMatchObject({ status: 503 });
  });

  it("authorizes opaque action tokens by exact install/thread/role/decision and consumes them once", async () => {
    await insertSlackInstallation(); const decisions: string[] = [];
    let sequence = 0;
    const completed = { outcome: "completed" as const };
    const authority = { async status() { return completed; }, async cancel() { return completed; },
      async approve(command: any) { decisions.push(command.decision); return completed; },
      async reject() { decisions.push("deny"); return completed; }, async bind() { return completed; },
      async unbind() { return completed; } };
    const { ingress } = productionComponents({ commandAuthority: authority,
      tokenFactory: () => `opaque_action_token_${++sequence}_abcdefghijklmnopqrstuvwxyz` });
    const issue = (actionId: string, allowedDecisions: string[], actionKind: "status" | "cancel" | "approval" | "bind" | "unbind" = "approval") => ingress.issueAction({
      organizationId: "org_a", actionId, installationId: "install_1", bindingId: "binding_1",
      teamId: "T1", appId: "A1", channelId: "C1", threadRootMessageId: "1700000000.000100",
      runId: "run_1", pendingRequestId: "permission_1", actionKind,
      actionDescriptor: { kind: actionKind, target: "frozen" },
      approvalEpoch: "epoch_1", frozenCeiling: { publicationMode: "proposal_only", network: ["api.example"] },
      allowedDecisions, memberUserIds: ["U_MEMBER"], requesterUserId: "U_REQUESTER",
      operatorUserIds: ["U_OPERATOR"], approverUserId: "U_APPROVER", adminUserIds: ["U_ADMIN"],
      expiresAt: new Date(now.getTime() + 60_000) });
    const action = (token: string, decision: string, userId = "U_APPROVER", thread = "1700000000.000100") =>
      actionRequest({ type: "block_actions", api_app_id: "A1", team: { id: "T1" }, user: { id: userId },
        channel: { id: "C1" }, container: { channel_id: "C1", thread_ts: thread,
          message_ts: "1700000005.1" }, frozen_ceiling: { publicationMode: "direct", secrets: ["all"] },
        actions: [{ action_id: `opentag:decision:${decision}`, value: token }] });
    const once = await issue("action_once", ["allow_once"]);
    await expect(ingress.receiveInteractivity("wrong_install", action(once, "allow_once")))
      .resolves.toMatchObject({ status: 404 });
    await expect(ingress.receiveInteractivity("install_1", action(once, "allow_once", "U_GUEST")))
      .resolves.toMatchObject({ status: 403 });
    await expect(ingress.receiveInteractivity("install_1", action(once, "allow_once", "U_APPROVER", "wrong")))
      .resolves.toMatchObject({ status: 403 });
    await expect(ingress.receiveInteractivity("install_1", action(once, "allow_run")))
      .resolves.toMatchObject({ status: 403 });
    await expect(ingress.receiveInteractivity("install_1", action(once, "allow_once")))
      .resolves.toMatchObject({ status: 200 });
    await expect(ingress.receiveInteractivity("install_1", action(once, "allow_once")))
      .resolves.toMatchObject({ status: 403 });
    const run = await issue("action_run", ["allow_run"]);
    await expect(ingress.receiveInteractivity("install_1", action(run, "allow_run")))
      .resolves.toMatchObject({ status: 200 });
    const status = await issue("action_status", ["status"], "status");
    await expect(ingress.receiveInteractivity("install_1", action(status, "status", "U_GUEST")))
      .resolves.toMatchObject({ status: 403 });
    await expect(ingress.receiveInteractivity("install_1", action(status, "status", "U_MEMBER")))
      .resolves.toMatchObject({ status: 200 });
    const requesterCancel = await issue("action_cancel_requester", ["cancel"], "cancel");
    await expect(ingress.receiveInteractivity("install_1", action(requesterCancel, "cancel", "U_REQUESTER")))
      .resolves.toMatchObject({ status: 200 });
    const operatorCancel = await issue("action_cancel_operator", ["cancel"], "cancel");
    await expect(ingress.receiveInteractivity("install_1", action(operatorCancel, "cancel", "U_OPERATOR")))
      .resolves.toMatchObject({ status: 200 });
    const bind = await issue("action_bind", ["bind"], "bind");
    await expect(ingress.receiveInteractivity("install_1", action(bind, "bind", "U_MEMBER")))
      .resolves.toMatchObject({ status: 403 });
    await expect(ingress.receiveInteractivity("install_1", action(bind, "bind", "U_ADMIN")))
      .resolves.toMatchObject({ status: 200 });
    expect(decisions).toEqual(["allow_once", "allow_run"]);
  });
});
