import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { computeSlackSignature } from "@opentag/slack";
import type { SourceAppDefinition } from "@opentag/source-app-runtime";
import { DeliveryIntentV2Schema } from "@opentag/delivery-contract";
import { computeHostedAdmissionEnvelopeDigestV1,
  HostedAdmissionEnvelopeV1Schema } from "@opentag/control-protocol";
import { digest as contentDigest, sourceContentAad } from "../src/modules/source-content/crypto.js";
import { createControlPlaneRuntime } from "../src/runtime.js";
import { runOneJob } from "../src/modules/jobs/worker.js";
import { createProductionControlPlaneRuntime } from "../src/index.js";
import { HOSTED_CAPABILITIES, hostedAdmissionFixture } from "./control-fixtures.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("Control Plane runtime composition", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("keeps readiness closed until the reviewed migration set is current", async () => {
    let closes = 0;
    const runtime = createControlPlaneRuntime({
      config: {
        bootstrapOrganizationId: "org_runtime",
        bootstrapOrganizationName: "Runtime",
        bootstrapPairingToken: "bootstrap_runtime_secret",
        databaseUrl: TEST_DATABASE_URL!,
        environment: "local",
        fencingTokenSecret: "f".repeat(32),
        githubIngressMasterSecret: null,
        host: "127.0.0.1",
        jobLeaseDurationMs: 30_000,
        jobPollIntervalMs: 1_000,
        jobRetryDelayMs: 30_000,
        loginRateLimit: {
          secret: "l".repeat(32),
          networkMode: "direct-peer",
          maxFailures: 5,
          networkMaxFailures: 50,
          windowMs: 300_000,
          lockoutMs: 900_000,
        },
        poolMax: 4,
        port: 3000,
        publicOrigin: "http://127.0.0.1:3000",
        recoveryPairingToken: null,
        releaseSha: "local",
      },
      postgres: {
        pool: fixture.pool,
        async close() {
          closes += 1;
        },
      },
      migrations: fixture.migrations,
    });

    const before = await runtime.application.fetch(
      new Request("http://control.test/readyz"),
    );
    expect(before.status).toBe(503);
    expect(await before.json()).toEqual({
      status: "not_ready",
      reason: "migrations_pending",
    });

    await fixture.migrate();
    const after = await runtime.application.fetch(
      new Request("http://control.test/readyz"),
    );
    expect(after.status).toBe(200);
    await runtime.close();
    expect(closes).toBe(1);
  });

  it("composes canonical Slack ingress through raw runtime HTTP routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opentag-slack-key-"));
    const keyFile = join(directory, "relay.key"); await writeFile(keyFile, Buffer.alloc(32, 9), { mode: 0o600 });
    await fixture.migrate(); const now = new Date("2026-08-30T00:00:00.000Z");
    const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
    await fixture.pool.query("INSERT INTO cp_organization(organization_id,display_name) VALUES('org_slack_runtime','Slack')");
    await fixture.pool.query(`INSERT INTO cp_source_app_installation(organization_id,installation_id,
      source_app_id,app_instance_id,binding_digest,credential_generation,credential_generation_digest,
      state,created_at,updated_at) VALUES('org_slack_runtime','install_runtime','slack','A_RUNTIME',$1,1,$2,'active',$3,$3)`,
      [digest("binding"), digest("generation"), now]);
    await fixture.pool.query(`INSERT INTO cp_source_binding(organization_id,binding_id,installation_id,
      binding_digest,state,created_at,updated_at) VALUES('org_slack_runtime','binding_runtime',
      'install_runtime',$1,'active',$2,$2)`, [digest("binding"), now]);
    await fixture.pool.query(`INSERT INTO cp_slack_installation(organization_id,installation_id,binding_id,
      team_id,app_id,channel_id,bot_user_id,member_user_ids,signing_secret_ref,bot_token_ref,created_at,updated_at)
      VALUES('org_slack_runtime','install_runtime','binding_runtime','T_RUNTIME','A_RUNTIME','C_RUNTIME',
      'U_APP',ARRAY['U_MEMBER'],'env:SLACK_SIGNING_SECRET','env:SLACK_BOT_TOKEN',$1,$1)`, [now]);
    const config = {
      bootstrapOrganizationId: "org_slack_runtime", bootstrapOrganizationName: "Slack",
      bootstrapPairingToken: "bootstrap_slack_runtime_secret", databaseUrl: TEST_DATABASE_URL!,
      environment: "local", fencingTokenSecret: "f".repeat(32), githubIngressMasterSecret: null,
      host: "127.0.0.1", jobLeaseDurationMs: 30_000, jobPollIntervalMs: 1_000,
      jobRetryDelayMs: 30_000, loginRateLimit: { secret: "l".repeat(32), networkMode: "direct-peer",
        maxFailures: 5, networkMaxFailures: 50, windowMs: 300_000, lockoutMs: 900_000 },
      poolMax: 4, port: 3000, publicOrigin: "http://127.0.0.1:3000",
      recoveryPairingToken: null, releaseSha: "local", relayContentKey: { file: keyFile, keyVersion: "v1" }
    } as const;
    const unavailable = createProductionControlPlaneRuntime({ config, migrations: fixture.migrations,
      env: {}, postgres: { pool: fixture.pool, async close() {} } });
    expect((await unavailable.application.fetch(new Request("http://control.test/readyz"))).status).toBe(503);
    await unavailable.close();
    const runtime = createProductionControlPlaneRuntime({ config, migrations: fixture.migrations,
      env: { SLACK_SIGNING_SECRET: "secret", SLACK_BOT_TOKEN: "bot" },
      postgres: { pool: fixture.pool, async close() {} } });
    expect(runtime.providerDeliveryProducer).toBeDefined();
    expect(runtime.providerDeliveryWorker).toBeDefined();
    await expect(runtime.providerDeliveryWorker.processNext()).resolves.toEqual({ kind: "empty", recovered: 0 });
    expect(runtime.sourceApps.resolveDelivery({ organizationId: "org_slack_runtime",
      appId: "slack", appInstanceId: "A_RUNTIME",
      bindingDigest: digest("binding"), credentialGeneration: 1,
      credentialGenerationDigest: digest("generation") })).toBeDefined();
    const send = (teamId: string) => { const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ type: "event_callback", team_id: teamId, api_app_id: "A_RUNTIME",
        event_id: `Ev_${teamId}`, event_time: Math.floor(now.getTime() / 1000),
        authorizations: [{ user_id: "U_APP" }], event: { type: "app_mention", user: "U_MEMBER",
          text: "<@U_APP> fix", ts: "1700000000.000100", channel: "C_RUNTIME" } });
      return runtime.application.fetch(new Request("http://control.test/v1/providers/slack/events/install_runtime",
        { method: "POST", headers: { "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": computeSlackSignature({ signingSecret: "secret", timestamp, rawBody: body }) },
          body })); };
    try { expect((await send("T_RUNTIME")).status).toBe(200);
      expect((await send("T_WRONG")).status).toBe(404); }
    finally { await runtime.close();
      await fixture.pool.query("DELETE FROM cp_job WHERE organization_id='org_slack_runtime'");
      await fixture.pool.query("DELETE FROM cp_ingress_reservation WHERE organization_id='org_slack_runtime'");
      await fixture.pool.query("DELETE FROM cp_source_content WHERE organization_id='org_slack_runtime'");
      await fixture.pool.query("DELETE FROM cp_slack_installation WHERE organization_id='org_slack_runtime'");
      await fixture.pool.query("DELETE FROM cp_source_binding WHERE organization_id='org_slack_runtime'");
      await fixture.pool.query("DELETE FROM cp_source_app_installation WHERE organization_id='org_slack_runtime'");
      await fixture.pool.query("DELETE FROM cp_organization WHERE organization_id='org_slack_runtime'");
      await rm(directory, { recursive: true, force: true }); }
  });

  it("claims a scheduled delivery job and reconciles through the real kernel once", async () => {
    await fixture.migrate();
    const config = { bootstrapOrganizationId: "org_delivery", bootstrapOrganizationName: "Delivery",
      bootstrapPairingToken: "bootstrap_delivery_secret", databaseUrl: TEST_DATABASE_URL!,
      environment: "local", fencingTokenSecret: "f".repeat(32), githubIngressMasterSecret: null,
      host: "127.0.0.1", jobLeaseDurationMs: 30_000, jobPollIntervalMs: 1_000,
      jobRetryDelayMs: 30_000, loginRateLimit: { secret: "l".repeat(32), networkMode: "direct-peer",
        maxFailures: 5, networkMaxFailures: 50, windowMs: 300_000, lockoutMs: 900_000 },
      poolMax: 4, port: 3000, publicOrigin: "http://127.0.0.1:3000",
      recoveryPairingToken: null, releaseSha: "local" } as const;
    const runtime = createControlPlaneRuntime({ config,
      postgres: { pool: fixture.pool, async close() {} }, migrations: fixture.migrations });
    const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
    let deliveries = 0; let reconciliations = 0;
    runtime.sourceApps.register({ appId: "fixture", protocol: "opentag.channel.v1",
      capabilities: { threads: true, messageUpdate: true, reactions: false,
        interactiveActions: false, attachments: "metadata", authenticatedDeletion: false,
        stableSourceVersions: true }, installation: { organizationId: "org_delivery",
        appInstanceId: "fixture-instance", bindingDigest: digest("binding"),
        credentialGeneration: 1, credentialGenerationDigest: digest("generation") },
      ingress: { verify: async (value) => value, normalize: () => null },
      context: { readThread: async () => ({ messages: [], truncated: false, decodedBytes: 0 }) },
      presentation: { render: () => ({}) }, delivery: { prepare: () => ({ text: "fixture" }),
        async deliver() { deliveries += 1; return { outcome: "outcome_unknown",
          evidenceDigest: digest("ambiguous"), errorCode: "ambiguous_response" }; },
        async reconcile() { reconciliations += 1; return { outcome: "accepted",
          evidenceDigest: digest("reconciled"), externalResourceId: "fixture-resource",
          externalResourceDigest: digest("resource") }; } } });
    const intent = DeliveryIntentV2Schema.parse({ contractVersion: 2,
      organizationId: "org_delivery", sideEffectIntentId: "scheduled-delivery",
      causalId: "scheduled-cause", intentKind: "delivery", operation: "create",
      deliveryKind: "message", presentationDigest: digest("presentation"),
      provenance: { kind: "business", repositoryIdentityDigest: digest("repo"),
        runId: "scheduled-run", authorityLineageDigest: digest("authority") },
      providerBinding: { bindingKind: "established", providerId: "fixture",
        providerInstanceId: "fixture-instance", providerPrincipalDigest: digest("principal"),
        principalAssurance: "provider_verified", bindingDigest: digest("binding"),
        providerConfigGeneration: 1, providerConfigGenerationDigest: digest("generation"),
        lifecycle: "active" }, targetDigest: digest("target"), authorityKind: "run_authority",
      authoritySnapshotDigest: digest("snapshot"), evidencePolicy: "local_audit",
      idempotencyKey: "scheduled-key", scope: { kind: "local_repository", id: "repo" },
      createdAt: "2026-08-30T00:00:00.000Z", initialAttemptSequence: 1 });
    await runtime.providerDeliveryProducer.enqueue({ intent, providerRequest: { text: "fixture" },
      phase: "terminal", frozenDeadline: "2030-08-30T00:00:00.000Z" });
    await runtime.jobs.enqueue({ jobId: "provider-delivery:scheduled", organizationId: null,
      kind: "provider-delivery", payload: {}, maxAttempts: 1 });
    await expect(runOneJob({ queue: runtime.jobs, workerId: "worker-delivery",
      handlers: runtime.jobHandlers, retryDelayMs: 30_000, clock: { now: () => new Date() } }))
      .resolves.toEqual({ kind: "settled", jobId: "provider-delivery:scheduled" });
    expect({ deliveries, reconciliations }).toEqual({ deliveries: 1, reconciliations: 1 });
    expect((await fixture.pool.query(`SELECT state,external_resource_id FROM cp_provider_delivery_intent
      WHERE intent_id='scheduled-delivery'`)).rows).toEqual([
        { state: "accepted", external_resource_id: "fixture-resource" }]);
    await runtime.close();
  });

  it("wires the restart-safe Source worker to the coordinator resolver by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opentag-relay-key-"));
    const keyFile = join(directory, "relay.key");
    await writeFile(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    await fixture.migrate();
    const config = {
        bootstrapOrganizationId: "org_runtime_source",
        bootstrapOrganizationName: "Runtime Source",
        bootstrapPairingToken: "bootstrap_runtime_source_secret",
        databaseUrl: TEST_DATABASE_URL!, environment: "local",
        fencingTokenSecret: "f".repeat(32), githubIngressMasterSecret: null,
        host: "127.0.0.1", jobLeaseDurationMs: 30_000, jobPollIntervalMs: 1_000,
        jobRetryDelayMs: 30_000, loginRateLimit: { secret: "l".repeat(32),
          networkMode: "direct-peer", maxFailures: 5, networkMaxFailures: 50,
          windowMs: 300_000, lockoutMs: 900_000 }, poolMax: 4, port: 3000,
        publicOrigin: "http://127.0.0.1:3000", recoveryPairingToken: null,
        releaseSha: "local", relayContentKey: { file: keyFile, keyVersion: "v1" },
      } as const;
    const runtime = createControlPlaneRuntime({
      config,
      postgres: { pool: fixture.pool, async close() {} },
      migrations: fixture.migrations,
    });
    try {
      expect(runtime.sourceIngress).not.toBeNull();
      expect(runtime.sourceIngressWorker).not.toBeNull();
      await expect(runtime.sourceIngressWorker!.processNext()).resolves.toEqual({ kind: "empty" });
      const registered = await runtime.runners.register({
        organizationId: "org_runtime_source", organizationName: "Runtime Source",
        request: { schemaVersion: 1, protocolVersion: "1.0",
          requiredCapabilities: ["relay.registration.v1"],
          requestId: "request_register_runtime_source",
          operationId: "operation_register_runtime_source",
          runnerId: "runner_runtime_source", capabilities: [...HOSTED_CAPABILITIES] },
      });
      expect(registered.kind).toBe("created");
      const sourceDigest = (value: string) => `sha256:${createHash("sha256")
        .update(value).digest("hex")}`;
      const bindingDigest = sourceDigest("runtime_binding");
      const generationDigest = sourceDigest("runtime_generation");
      const sourceApp: SourceAppDefinition<unknown, unknown, unknown> = {
        appId: "runtime-source", protocol: "opentag.channel.v1",
        capabilities: { threads: true, messageUpdate: true, reactions: false,
          interactiveActions: false, attachments: "metadata",
          authenticatedDeletion: true, stableSourceVersions: true },
        installation: { organizationId: "org_runtime_source", appInstanceId: "runtime-instance", bindingDigest,
          credentialGeneration: 1, credentialGenerationDigest: generationDigest },
        ingress: { verify: async (value) => value, normalize: () => null },
        context: { readThread: async () => ({ messages: [], truncated: false,
          decodedBytes: 0 }) }, presentation: { render: () => ({}) },
        delivery: { prepare: () => ({}),
          deliver: async () => ({ status: "failed", error: { code: "unused", retryable: false } }),
          reconcile: async () => ({ status: "failed", error: { code: "unused", retryable: false } }) },
      };
      await fixture.pool.query(
        `INSERT INTO cp_source_app_installation(organization_id, installation_id,
           source_app_id, app_instance_id, binding_digest, credential_generation,
           credential_generation_digest, state, created_at, updated_at)
         VALUES($1,$2,$3,$4,$5,1,$6,'active',clock_timestamp(),clock_timestamp())`,
        ["org_runtime_source", "runtime_installation", sourceApp.appId,
          sourceApp.installation.appInstanceId, bindingDigest, generationDigest],
      );
      await fixture.pool.query(
        `INSERT INTO cp_source_binding(organization_id, binding_id, installation_id,
           binding_digest, state, created_at, updated_at)
         VALUES($1,$2,$3,$4,'active',clock_timestamp(),clock_timestamp())`,
        ["org_runtime_source", "runtime_binding", "runtime_installation", bindingDigest],
      );
      const rawDigest = sourceDigest("runtime_raw");
      const deliveryId = "runtime_delivery";
      const reservationId = `ingress_${createHash("sha256").update(JSON.stringify([
        "org_runtime_source", "runtime_installation", deliveryId,
      ])).digest("hex")}`;
      const contentId = `content_${createHash("sha256").update(JSON.stringify([
        "org_runtime_source", "runtime_installation", deliveryId, rawDigest,
      ])).digest("hex")}`;
      const admissionFixture = await hostedAdmissionFixture({ runId: "run_runtime_source",
        suffix: "fruntimesource", organizationId: "org_runtime_source",
        runnerId: "runner_runtime_source",
        queueClaimDeadline: "2030-08-29T00:00:00.000Z", contentId });
      const sourceVersionRef = "runtime:message:v1";
      const unsignedAdmission = {
        ...admissionFixture.admission,
        sourceContextEnvelope: { contentId, sourceVersionRef,
          aadDigest: contentDigest(sourceContentAad({ organizationId: "org_runtime_source",
            contentId, installationId: "runtime_installation", sourceAppId: sourceApp.appId,
            sourceDeliveryId: deliveryId, sourceMessageId: "runtime_message",
            sourceVersionRef, purpose: "source_context" })),
          keyVersion: "v1", envelopeDigest: rawDigest },
      };
      const admission = HostedAdmissionEnvelopeV1Schema.parse({ ...unsignedAdmission,
        envelopeDigest: await computeHostedAdmissionEnvelopeDigestV1(unsignedAdmission) });
      const reserved = await runtime.sourceIngress!.reserve({
        organizationId: "org_runtime_source", installationId: "runtime_installation",
        bindingId: "runtime_binding", sourceApp, sourceDeliveryId: deliveryId,
        sourceMessageId: "runtime_message", sourceVersionRef,
        rawDigest, normalizedContent: { runId: "run_runtime_source",
          hostedAdmission: admission, admissionPolicySnapshot: admissionFixture.policy },
        expiresAt: new Date("2030-08-30T00:00:00.000Z"),
      });
      expect(reserved).toMatchObject({ outcome: "reserved",
        reservation: { reservationId } });
      await expect(runtime.sourceIngressWorker!.processNext()).resolves.toMatchObject({
        kind: "settled", resolution: { kind: "waiting_for_runner",
          runId: "run_runtime_source" },
      });
      await runtime.close();
      const restarted = createControlPlaneRuntime({ config,
        postgres: { pool: fixture.pool, async close() {} }, migrations: fixture.migrations });
      try {
        await expect(restarted.sourceIngressWorker!.processNext()).resolves.toEqual({ kind: "empty" });
      } finally {
        await restarted.close();
      }
      const durable = await fixture.pool.query(
        `SELECT (SELECT count(*)::int FROM cp_hosted_run
                   WHERE organization_id = $1) AS runs,
                (SELECT count(*)::int FROM cp_source_resolution
                   WHERE organization_id = $1) AS resolutions,
                (SELECT count(*)::int FROM cp_source_resolution_admission
                   WHERE idempotency_key = $2) AS admissions,
                (SELECT state FROM cp_job WHERE job_id = $3) AS job_state`,
        ["org_runtime_source", `source-ingress:${reservationId}`,
          `source-ingress:${reservationId}`],
      );
      expect(durable.rows[0]).toEqual({ runs: 1, resolutions: 1,
        admissions: 1, job_state: "succeeded" });
    } finally {
      await runtime.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
