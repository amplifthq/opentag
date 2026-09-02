import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSlackSignature, createSlackSourceApp } from "@opentag/slack";
import { DeliveryIntentV2Schema, deliveryCurrentTruthDescriptor } from "@opentag/delivery-contract";
import { createDurableJobQueue } from "../src/modules/jobs/index.js";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createPostgresDeliveryRepository } from "../src/modules/provider-delivery/repository.js";
import { createTeamRelayProjectionService } from "../src/modules/provider-delivery/team-relay-projection.js";
import { createRunnerDirectory } from "../src/modules/runners/index.js";
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
import { createSourceIngressService } from "../src/modules/source-ingress/index.js";
import { createSourceIngressWorker } from "../src/modules/source-ingress/worker.js";
import { createSlackIngressForTest } from "../src/modules/slack-ingress/index.js";
import { HOSTED_CAPABILITIES, hostedAdmissionFixture, hostedClaimRequest,
  hostedGrantIssuerFixture, recordHostedReadiness } from "./control-fixtures.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const now = new Date("2026-08-15T07:00:00.000Z");
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const owner = { runtimeOwnerId: "control-plane", runtimeGeneration: 1, schemaGeneration: 1 } as const;

describe.skipIf(!TEST_DATABASE_URL)("Slack team relay certification profile", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;

  beforeEach(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    await fixture.pool.query("INSERT INTO cp_organization(organization_id,display_name) VALUES('org_cert','Certification')");
    await fixture.pool.query(`INSERT INTO cp_source_app_installation(
      organization_id,installation_id,source_app_id,app_instance_id,binding_digest,
      credential_generation,credential_generation_digest,state,created_at,updated_at)
      VALUES('org_cert','install_cert','slack','A_CERT',$1,1,$2,'active',$3,$3)`,
    [digest("binding"), digest("generation"), now]);
    await fixture.pool.query(`INSERT INTO cp_source_binding(organization_id,binding_id,
      installation_id,binding_digest,state,created_at,updated_at)
      VALUES('org_cert','binding_cert','install_cert',$1,'active',$2,$2)`, [digest("binding"), now]);
  });
  afterEach(async () => fixture.close());

  it("carries one signed Slack request through offline admission, fenced claim, and outcome-independent presentation", async () => {
    const clock = { now: () => now };
    const jobs = createDurableJobQueue({ pool: fixture.pool, clock, leaseDurationMs: 30_000,
      tokenFactory: () => "job_lease_cert" });
    const custody = createRelayContentCustody({ pool: fixture.pool, clock,
      key: { key: randomBytes(32), keyVersion: "cert-v1" } });
    const sourceIngress = createSourceIngressService({ pool: fixture.pool, clock, custody, jobs });
    const installation = { organizationId: "org_cert", appInstanceId: "A_CERT",
      bindingDigest: digest("binding"), credentialGeneration: 1,
      credentialGenerationDigest: digest("generation") };
    const sourceApp = createSlackSourceApp({ installation, signingSecret: "cert-signing-secret",
      botUserId: "U_APP", resolveCredential: async () => "provider-call-forbidden",
      clock: () => now.getTime() });
    const slack = createSlackIngressForTest({ sourceApp, organizationId: "org_cert",
      installationId: "install_cert", bindingId: "binding_cert", sourceIngress,
      sourceContent: custody, clock });
    const body = JSON.stringify({ type: "event_callback", team_id: "T_CERT", api_app_id: "A_CERT",
      event_id: "Ev_CERT", event_time: Math.floor(now.getTime() / 1000),
      authorizations: [{ user_id: "U_APP" }], event: { type: "app_mention", user: "U_MEMBER",
        text: "<@U_APP> certify relay", ts: "1700000000.000100", channel: "C_CERT" } });
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const received = await slack.receiveEvents({ rawBody: new TextEncoder().encode(body),
      headers: new Headers({ "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({ signingSecret: "cert-signing-secret", timestamp, rawBody: body }) }),
      receivedAt: now.toISOString() });
    expect(received).toMatchObject({ status: 200, body: { ok: true } });

    const runners = createRunnerDirectory({ pool: fixture.pool, clock,
      tokenFactory: () => "runtime_cert_secret", idFactory: () => "credential_cert" });
    const registration = await runners.register({ organizationId: "org_cert", organizationName: "Certification",
      request: { schemaVersion: 1, protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"], requestId: "request_register_cert",
        operationId: "operation_register_cert", runnerId: "runner_cert",
        capabilities: [...HOSTED_CAPABILITIES] } });
    expect(registration.kind).toBe("created");
    const authentication = await runners.authenticate("runtime_cert_secret");
    if (authentication.kind !== "authenticated") throw new Error("certification authentication failed");
    const hosted = createHostedRunCoordinator({ pool: fixture.pool, clock, leaseDurationMs: 60_000,
      idFactory: () => "attempt_cert", tokenFactory: () => "fence_cert",
      issueSourceContentGrantInTransaction: hostedGrantIssuerFixture });
    const worker = createSourceIngressWorker({ ingress: sourceIngress, queue: jobs,
      workerId: "source_cert", retryDelayMs: 1_000, clock,
      resolver: { async resolve(input) {
        expect(input.sourceContext).toMatchObject({ text: "certify relay" });
        const admission = await hostedAdmissionFixture({ runId: "run_cert", suffix: "12",
          organizationId: "org_cert", runnerId: "runner_cert",
          contentId: input.reservation.contentRef.contentId });
        const result = await hosted.admit({ runId: "run_cert", admission: admission.admission,
          policy: admission.policy });
        expect(result).toMatchObject({ kind: "created", view: { status: "waiting_for_runner" } });
        return { kind: "accepted" as const, runId: "run_cert" };
      } } });
    await expect(worker.processNext()).resolves.toMatchObject({ kind: "settled",
      resolution: { kind: "accepted", runId: "run_cert" } });
    await expect(hosted.claim({ principal: authentication.principal,
      request: hostedClaimRequest({ operationId: "claim_offline", requestId: "claim_offline",
        credentialId: "credential_cert" }) })).resolves.toEqual({ kind: "empty" });

    const repository = createPostgresDeliveryRepository({ pool: fixture.pool, owner,
      leaseOwner: "delivery_cert", leaseSeconds: 30, now: () => now });
    const anchor = DeliveryIntentV2Schema.parse({ contractVersion: 2, organizationId: "org_cert",
      sideEffectIntentId: "intent_anchor_cert", causalId: "run_cert", intentKind: "delivery",
      operation: "create", deliveryKind: "message", presentationDigest: digest("initial"),
      provenance: { kind: "business", repositoryIdentityDigest: digest("repo"), runId: "run_cert",
        authorityLineageDigest: digest("authority") }, providerBinding: { bindingKind: "established",
        providerId: "slack", providerInstanceId: "T_CERT", providerPrincipalDigest: digest("principal"),
        principalAssurance: "provider_verified", providerConfigGeneration: 1,
        providerConfigGenerationDigest: digest("generation"), lifecycle: "active",
        bindingDigest: digest("binding") }, targetDigest: digest("channel"),
      authorityKind: "run_authority", authoritySnapshotDigest: digest("snapshot"),
      evidencePolicy: "local_audit", idempotencyKey: "anchor_cert", scope: { kind: "local_repository",
        id: "repository_cert" }, statusMessageId: "slack:run_cert",
      projectionRevision: 1, projectionEventSequence: 0, projectionPurpose: "anchor_create",
      createdAt: now.toISOString(), initialAttemptSequence: 1 });
    const currentTruth = deliveryCurrentTruthDescriptor({ intent: anchor, owner: {
      organizationId: anchor.organizationId, providerId: "slack", providerInstanceId: "T_CERT",
      providerBindingDigest: digest("binding"), providerConfigGeneration: 1,
      providerConfigGenerationDigest: digest("generation"), ...owner } });
    await repository.recordIntent(anchor, { envelopeVersion: 1, phase: "received",
      frozenDeadline: "2026-08-16T07:00:00.000Z", currentTruth,
      providerRequest: { operation: { kind: "post_message", channelId: "C_CERT" },
        presentation: { kind: "message", text: "waiting" } } });
    const anchorClaim = (await repository.claimNext())!;
    const begunAnchor = (await repository.markBegin({ ...anchorClaim,
      installationBeginMarkerId: "install_begin_anchor", installationBeginMarkerDigest: digest("install_begin_anchor"),
      scopeBeginMarkerId: "scope_begin_anchor", scopeBeginMarkerDigest: digest("scope_begin_anchor") }))!;
    await repository.settleOrReadTerminal({ ...begunAnchor, outcome: "accepted",
      evidenceDigest: digest("anchor_accepted"), externalResourceId: "1700000001.000200",
      externalResourceDigest: digest("1700000001.000200") });

    await recordHostedReadiness({ pool: fixture.pool, organizationId: "org_cert", runnerId: "runner_cert" });
    const claimed = await hosted.claim({ principal: authentication.principal,
      request: hostedClaimRequest({ operationId: "claim_online", requestId: "claim_online",
        credentialId: "credential_cert" }) });
    expect(claimed.kind).toBe("claimed");
    const producer = { enqueue: async (input: { intent: typeof anchor; providerRequest: object;
      phase: "received" | "running" | "terminal"; frozenDeadline: string }) => repository.recordIntent(
        input.intent, { envelopeVersion: 1, providerRequest: input.providerRequest, phase: input.phase,
          frozenDeadline: input.frozenDeadline,
          currentTruth: deliveryCurrentTruthDescriptor({ intent: input.intent, owner: {
            organizationId: input.intent.organizationId, providerId: "slack", providerInstanceId: "T_CERT",
            providerBindingDigest: digest("binding"), providerConfigGeneration: 1,
            providerConfigGenerationDigest: digest("generation"), ...owner } }) }) };
    const projection = createTeamRelayProjectionService({ pool: fixture.pool, hosted,
      producer: producer as never, clock, deliveryOwner: owner });
    const queued = await projection.projectRun({ organizationId: "org_cert", runId: "run_cert",
      projectionRevision: 2, includeControls: false });
    expect(queued).toMatchObject({ kind: "queued", presentation: { state: "assigned" } });
    if (queued.kind !== "queued") throw new Error("projection was not queued");
    const updateClaim = (await repository.claimNext())!;
    expect(updateClaim.intentId).toBe(queued.intentId);
    const begunUpdate = (await repository.markBegin({ ...updateClaim,
      installationBeginMarkerId: "install_begin_update", installationBeginMarkerDigest: digest("install_begin_update"),
      scopeBeginMarkerId: "scope_begin_update", scopeBeginMarkerDigest: digest("scope_begin_update") }))!;
    await repository.settleOrReadTerminal({ ...begunUpdate, outcome: "outcome_unknown",
      evidenceDigest: digest("ambiguous_slack_response"), errorCode: "ambiguous_response" });
    const truth = await fixture.pool.query("SELECT state,outcome_state FROM cp_hosted_run WHERE run_id='run_cert'");
    expect(truth.rows).toEqual([{ state: "assigned", outcome_state: null }]);
  });
});
