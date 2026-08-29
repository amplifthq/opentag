import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSlackSignature, createSlackSourceApp } from "@opentag/slack";
import { createDurableJobQueue } from "../src/modules/jobs/index.js";
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
import { createSourceIngressService } from "../src/modules/source-ingress/index.js";
import { createSlackIngress } from "../src/modules/slack-ingress/index.js";
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

  function components(commandAuthority?: Parameters<typeof createSlackIngress>[0]["commandAuthority"]) {
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
    const ingress = createSlackIngress({ sourceApp, organizationId: "org_a",
      installationId: "install_1", bindingId: "binding_1",
      sourceIngress: createSourceIngressService({ pool: fixture.pool, clock, custody, jobs }),
      sourceContent: custody, clock, ...(commandAuthority ? { commandAuthority } : {}) });
    return { ingress };
  }

  function request(eventId = "Ev1", event: Record<string, unknown> = {
    type: "app_mention", user: "U1", text: "<@U_APP> fix this",
    ts: "1700000000.000100", channel: "C1"
  }) {
    const body = JSON.stringify({ type: "event_callback", team_id: "T1", api_app_id: "A1",
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

  it("delegates shared-thread roles to the provider-neutral authority without widening commands", async () => {
    const completed = { outcome: "completed" as const };
    const authority = {
      async status(command: any) { return command.actor.id === "U_MEMBER" ? completed
        : { outcome: "rejected" as const, reason: "guest_denied" }; },
      async cancel(command: any) { return ["U_REQUESTER", "U_OPERATOR"].includes(command.actor.id)
        ? completed : { outcome: "rejected" as const, reason: "cancel_denied" }; },
      async approve(command: any) { return command.actor.id === "U_APPROVER" && command.requestId === "action_1"
        ? completed : { outcome: "rejected" as const, reason: "approval_denied" }; },
      async reject(command: any) { return command.actor.id === "U_APPROVER" ? completed
        : { outcome: "rejected" as const, reason: "approval_denied" }; },
      async bind(command: any) { return command.actor.id === "U_ADMIN" ? completed
        : { outcome: "rejected" as const, reason: "admin_required" }; },
      async unbind(command: any) { return command.actor.id === "U_ADMIN" ? completed
        : { outcome: "rejected" as const, reason: "admin_required" }; }
    };
    const ingress = components(authority).ingress;
    const action = (userId: string, action_id: string, value: unknown) => actionRequest({
      type: "block_actions", trigger_id: `${action_id}:${userId}`, user: { id: userId },
      actions: [{ action_id, action_ts: "1700000000.1", value: JSON.stringify(value) }]
    });
    await expect(ingress.receiveInteractivity(action("U_MEMBER", "opentag:status", {})))
      .resolves.toMatchObject({ status: 200 });
    await expect(ingress.receiveInteractivity(action("U_REQUESTER", "opentag:cancel", { reason: "requested" })))
      .resolves.toMatchObject({ status: 200 });
    await expect(ingress.receiveInteractivity(action("U_OPERATOR", "opentag:cancel", { reason: "operator" })))
      .resolves.toMatchObject({ status: 200 });
    await expect(ingress.receiveInteractivity(action("U_APPROVER", "opentag:permission:allow_once", {
      actionId: "action_1", permissionCeiling: ["publication:unbounded"], publicationMode: "direct"
    }))).resolves.toMatchObject({ status: 200 });
    await expect(ingress.receiveInteractivity(action("U_ADMIN", "opentag:bind", {
      bindingDigest: installation.bindingDigest, network: "unbounded", secrets: ["all"]
    }))).resolves.toMatchObject({ status: 200 });
    await expect(ingress.receiveInteractivity(action("U_GUEST", "opentag:status", {})))
      .resolves.toMatchObject({ status: 403 });
  });
});
