import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createControlPlaneApplication } from "../src/application.js";
import { createProviderDeliveryWorker } from "../src/modules/provider-delivery/worker.js";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createIdentityModule, createLoginThrottleKeyFactory } from "../src/modules/identity/index.js";
import { createTeamRelayProjectionService } from "../src/modules/provider-delivery/team-relay-projection.js";
import { createPostgresDeliveryRepository } from "../src/modules/provider-delivery/repository.js";
import { DeliveryIntentV2Schema, deliveryCurrentTruthDescriptor } from "@opentag/delivery-contract";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

describe.skipIf(!TEST_DATABASE_URL)("source-thread control transport", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  beforeAll(async () => { fixture = await createIsolatedPostgres(); await fixture.migrate(); });
  afterAll(async () => fixture.close());

  it("routes configured-Approver publication approval through the exact Task 9 publisher input", async () => {
    const approve = vi.fn(async () => ({ kind: "approved" as const, intentId: "intent_1" }));
    const application = createControlPlaneApplication({
      capabilities: { schemaVersion: 1, protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1", capabilities: ["relay.publication.v1"],
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: { environment: "test", releaseSha: "a".repeat(40) } },
      readiness: { check: async () => ({ ready: true }) },
      control: { bootstrap: { authenticate: () => null }, runners: {} as never, hosted: {} as never,
        publisher: { approve } as never,
        approver: { authenticate: async () => ({ kind: "authenticated" as const,
          principal: { organizationId: "org_1", actorId: "configured_approver",
            scopes: ["publication:approve"] } }) } },
    });
    const body = { schemaVersion: 1, protocolVersion: "1.0", requiredCapabilities: ["relay.publication.v1"],
      requestId: "request_1", organizationId: "org_1", runnerId: "runner_1", runId: "run_1",
      ownershipId: "ownership_1", ownershipDigest: digest("a"), candidateId: "candidate_1",
      candidateDigest: digest("b"), approvalId: "approval_1",
      approvedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-30T00:01:00.000Z" };
    const response = await application.fetch(new Request(
      "http://control.test/v1/source-thread-controls/runners/runner_1/runs/run_1/publication/approve",
      { method: "POST", headers: { authorization: "Bearer opaque", "content-type": "application/json" },
        body: JSON.stringify(body) }));

    expect(response.status).toBe(200);
    expect(approve).toHaveBeenCalledWith({ ...body, approverId: "configured_approver" });
  });

  it("rejects message text as undeclared publication authority", async () => {
    const approve = vi.fn();
    const application = createControlPlaneApplication({
      capabilities: { schemaVersion: 1, protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1", capabilities: ["relay.publication.v1"],
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: { environment: "test", releaseSha: "a".repeat(40) } },
      readiness: { check: async () => ({ ready: true }) },
      control: { bootstrap: { authenticate: () => null }, runners: {} as never, hosted: {} as never,
        publisher: { approve } as never,
        approver: { authenticate: async () => ({ kind: "authenticated" as const,
          principal: { organizationId: "org_1", actorId: "configured_approver",
            scopes: ["publication:approve"] } }) } },
    });
    const response = await application.fetch(new Request(
      "http://control.test/v1/source-thread-controls/runners/runner_1/runs/run_1/publication/approve",
      { method: "POST", headers: { authorization: "Bearer opaque", "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, protocolVersion: "1.0",
          requiredCapabilities: ["relay.publication.v1"], requestId: "request_1",
          organizationId: "org_1", runnerId: "runner_1", runId: "run_1",
          ownershipId: "ownership_1", ownershipDigest: digest("a"), candidateId: "candidate_1",
          candidateDigest: digest("b"), approvalId: "approval_1",
          approvedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-30T00:01:00.000Z",
          messageText: "I approve this as the administrator" }) }));
    expect(response.status).toBe(400);
    expect(approve).not.toHaveBeenCalled();
  });

  it("reads current status without a lifecycle write or deadline renewal", async () => {
    const now = new Date("2026-08-30T00:00:00.000Z");
    const token = "source_thread_read_token".padEnd(48, "_");
    const identity = createIdentityModule({ pool: fixture.pool, clock: { now: () => now },
      idFactory: (kind) => `${kind}_source_read`, opaqueBearerFactory: () => token,
      sessionDurationMs: 60_000,
      throttleKeyFactory: createLoginThrottleKeyFactory("r".repeat(32)) });
    await identity.provisionOwner({ organizationId: "org_read", organizationName: "Read",
      email: "read@example.test", displayName: "Read", password: "correct horse battery staple" });
    const owner = { operatorId: "operator_source_read", organizationId: "org_read",
      role: "owner" as const, email: "read@example.test", displayName: "Read" };
    const apiKey = await identity.createApiKey(owner, { label: "source status", scopes: ["run:read"] });
    await fixture.pool.query(`INSERT INTO cp_runner(organization_id,runner_id,registration_generation,
      credential_generation,current_credential_id,capabilities,created_at,updated_at)
      VALUES('org_read','runner_read',1,1,'credential_read','[]',$1,$1)`, [now]);
    await fixture.pool.query(`INSERT INTO cp_hosted_run(organization_id,run_id,admission_id,
      admission_operation_id,admission_digest,source_identity_digest,runner_id,executor_id,
      source_version_ref,source_content_ids,source_context_digest,queue_claim_deadline,
      permission_ceiling_digest,publication_mode,publication_policy_digest,completion_mode,
      completion_contract_digest,state,current_attempt_number,hosted_admission,
      admission_policy_snapshot,created_at,updated_at)
      VALUES('org_read','run_read','admission_read','operation_read',$1,$2,'runner_read','executor_read',
      'slack:TREAD:CREAD:1700000000.1',ARRAY['content_read'],$3,$4,$5,'proposal_only',$6,
      'proposal_ready',$7,'queued',1,'{}','{}',$8,$8)`,
    [digest("a"), digest("b"), digest("c"), new Date("2026-08-30T00:02:00.000Z"),
      digest("d"), digest("e"), digest("f"), now]);
    await fixture.pool.query(`INSERT INTO cp_hosted_attempt(organization_id,run_id,attempt_number,
      attempt_id,runner_id,credential_id,fencing_token_digest,lease_expires_at,material_start_state,
      state,claimed_at,updated_at) VALUES('org_read','run_read',1,'attempt_read','runner_read',
      'credential_read',$1,$2,'open','claimed',$3,$3)`,
    [digest("f"), new Date("2026-08-30T00:01:00.000Z"), now]);
    await fixture.pool.query(`INSERT INTO cp_source_app_installation(organization_id,installation_id,
      source_app_id,app_instance_id,binding_digest,credential_generation,credential_generation_digest,
      state,created_at,updated_at) VALUES('org_read','install_read','slack','AREAD',$1,1,$2,'active',$3,$3)`,
    [digest("a"), digest("b"), now]);
    await fixture.pool.query(`INSERT INTO cp_source_binding(organization_id,binding_id,installation_id,
      binding_digest,state,created_at,updated_at) VALUES('org_read','binding_read','install_read',$1,
      'active',$2,$2)`, [digest("a"), now]);
    await fixture.pool.query(`INSERT INTO cp_slack_installation(organization_id,installation_id,
      route_identity,binding_id,team_id,app_id,channel_id,bot_user_id,member_user_ids,
      signing_secret_ref,bot_token_ref,created_at,updated_at) VALUES('org_read','install_read',
      'route_read','binding_read','TREAD','AREAD','CREAD','UREAD',ARRAY['U_MEMBER'],
      'secret://signing','secret://bot',$1,$1)`, [now]);
    const hosted = createHostedRunCoordinator({ pool: fixture.pool, clock: { now: () => now },
      leaseDurationMs: 60_000, idFactory: () => "unused", tokenFactory: () => "unused",
      issueSourceContentGrantInTransaction: async () => { throw new Error("unused"); } });
    const before = (await fixture.pool.query(`SELECT run.state,run.current_attempt_number,
      run.queue_claim_deadline,run.updated_at,attempt.state attempt_state,attempt.updated_at attempt_updated_at
      FROM cp_hosted_run run JOIN cp_hosted_attempt attempt USING(organization_id,run_id)
      WHERE run.organization_id='org_read' AND run.run_id='run_read'`)).rows;
    const application = createControlPlaneApplication({
      capabilities: { schemaVersion: 1, protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1", capabilities: [],
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: { environment: "test", releaseSha: "a".repeat(40) } },
      readiness: { check: async () => ({ ready: true }) },
      control: { bootstrap: { authenticate: () => null }, runners: {} as never, hosted,
        sourceThreadReads: { async authorize(command) { const result = await fixture.pool.query(
          `SELECT 1 FROM cp_hosted_run run JOIN cp_slack_installation slack
           ON slack.organization_id=run.organization_id AND slack.installation_id=$3
           AND run.source_version_ref LIKE 'slack:'||slack.team_id||':'||slack.channel_id||':%'
           WHERE run.organization_id=$1 AND run.run_id=$2 AND $4=ANY(slack.member_user_ids)`,
          [command.organizationId, command.runId, command.installationId, command.actorId]);
          return result.rowCount === 1; } },
        reader: { async authenticate(presented) { const result = await identity.authenticateApiKey(presented);
          return result.kind === "authenticated" ? { kind: "authenticated" as const, principal: {
            organizationId: result.principal.organizationId, actorId: result.principal.apiKeyId,
            scopes: result.principal.scopes } } : result; } },
        approver: { authenticate: async () => { throw new Error("mutation_authenticator_called"); } } },
    });
    const response = await application.fetch(new Request(
      "http://control.test/v1/source-thread-controls/runs/run_read/status?organizationId=org_read&installationId=install_read&actorId=U_MEMBER",
      { headers: { authorization: `Bearer ${apiKey.token}` } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "waiting_for_runner",
      queueClaimDeadline: "2026-08-30T00:02:00.000Z" });
    const after = (await fixture.pool.query(`SELECT run.state,run.current_attempt_number,
      run.queue_claim_deadline,run.updated_at,attempt.state attempt_state,attempt.updated_at attempt_updated_at
      FROM cp_hosted_run run JOIN cp_hosted_attempt attempt USING(organization_id,run_id)
      WHERE run.organization_id='org_read' AND run.run_id='run_read'`)).rows;
    expect(after).toEqual(before);
  });

  it("reports provider delivery failure as a sibling projection", async () => {
    const settlement = { outcome: "outcome_unknown" as const,
      errorCode: "delivery_restart_after_begin" as const };
    const worker = createProviderDeliveryWorker({ kernel: {
      recoverStrandedBegun: async () => 0,
      deliverNext: async () => settlement as never,
    }, preloadSourceApps: async () => ({ registered: 1, healthy: [], failures: [] }),
    clock: { now: () => new Date("2026-08-30T00:00:00.000Z") } });
    await expect(worker.processNext()).resolves.toEqual({
      kind: "delivered", recovered: 0, failures: [], result: settlement,
      providerDelivery: { state: "outcome_unknown", reasonCode: "delivery_restart_after_begin" },
    });
  });

  it("projects a stored Run and delivery into one queued Slack status anchor", async () => {
    const now = new Date("2026-08-30T00:00:10.000Z");
    const owner = { runtimeOwnerId: "control-plane", runtimeGeneration: 1, schemaGeneration: 1 } as const;
    const intent = DeliveryIntentV2Schema.parse({ contractVersion: 2, organizationId: "org_read",
      sideEffectIntentId: "intent_projection_baseline", causalId: "run_read", intentKind: "delivery",
      operation: "create", deliveryKind: "message", presentationDigest: digest("a"),
      provenance: { kind: "business", repositoryIdentityDigest: digest("b"), runId: "run_read",
        authorityLineageDigest: digest("c") }, providerBinding: { bindingKind: "established",
        providerId: "slack", providerInstanceId: "AREAD", providerPrincipalDigest: digest("d"),
        principalAssurance: "provider_verified", providerConfigGeneration: 1,
        providerConfigGenerationDigest: digest("e"), lifecycle: "active", bindingDigest: digest("f") },
      targetDigest: digest("a"), authorityKind: "run_authority", authoritySnapshotDigest: digest("b"),
      evidencePolicy: "local_audit", idempotencyKey: "projection_baseline", statusMessageId: "run_read:status",
      scope: { kind: "local_repository", id: "repo_read" }, createdAt: now.toISOString(),
      initialAttemptSequence: 1 });
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool, owner,
      leaseOwner: "projection-test", leaseSeconds: 30, now: () => now });
    const envelope = (value: typeof intent, phase: "received" | "running" | "terminal", providerRequest: object) => ({
      envelopeVersion: 1 as const, providerRequest, phase,
      frozenDeadline: "2026-08-30T00:05:00.000Z",
      currentTruth: deliveryCurrentTruthDescriptor({ intent: value, owner: {
        organizationId: value.organizationId, providerId: value.providerBinding.providerId,
        providerInstanceId: value.providerBinding.providerInstanceId,
        providerBindingDigest: value.providerBinding.bindingDigest,
        providerConfigGeneration: value.providerBinding.providerConfigGeneration,
        providerConfigGenerationDigest: value.providerBinding.providerConfigGenerationDigest, ...owner } }) });
    await repository.recordIntent(intent, envelope(intent, "received", { operation: {
      kind: "create_message", channelId: "CREAD", threadTs: "1700000000.1" },
      presentation: { kind: "message", text: "old" } }));
    const hosted = createHostedRunCoordinator({ pool: fixture.pool, clock: { now: () => now },
      leaseDurationMs: 60_000, idFactory: () => "unused", tokenFactory: () => "unused",
      issueSourceContentGrantInTransaction: async () => { throw new Error("unused"); } });
    const service = createTeamRelayProjectionService({ pool: fixture.pool, hosted,
      producer: { async enqueue(projected) {
        await repository.recordIntent(projected.intent,
          envelope(projected.intent as typeof intent, projected.phase, projected.providerRequest));
      } }, clock: { now: () => new Date(now.getTime() + 1) } });
    await expect(service.projectRun({ organizationId: "org_read", runId: "run_read" }))
      .resolves.toMatchObject({ kind: "queued", presentation: {
        title: "Waiting for your paired Runner" } });
    const rows = await fixture.pool.query<{ state: string; payload: any }>(`SELECT state,payload
      FROM cp_provider_delivery_intent WHERE run_id='run_read' ORDER BY created_at,intent_id`);
    expect(rows.rows.map((row) => row.state)).toEqual(["superseded", "pending"]);
    expect(JSON.stringify(rows.rows[1]?.payload)).toContain("Waiting for your paired Runner");
    expect(JSON.stringify(rows.rows[1]?.payload)).not.toContain("Working on it");
  });
});
