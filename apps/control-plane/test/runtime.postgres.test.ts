import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { computeSlackSignature } from "@opentag/slack";
import { createOpenTagClient } from "@opentag/client";
import type { SourceAppDefinition } from "@opentag/source-app-runtime";
import { DeliveryIntentV2Schema } from "@opentag/delivery-contract";
import { computeHostedAdmissionEnvelopeDigestV1,
  computeControlPayloadDigestV1, computeControlReceiptDigestV1,
  buildHostedLifecycleRequestV1, computePermissionRequestDigestV1,
  HostedAdmissionEnvelopeV1Schema,
  RunnerBranchOwnershipAttestationV1Schema,
  RunnerPermissionRequestV1Schema,
  RunnerReadinessReceiptEnvelopeV1Schema } from "@opentag/control-protocol";
import { digest as contentDigest, sourceContentAad } from "../src/modules/source-content/crypto.js";
import { createControlPlaneRuntime } from "../src/runtime.js";
import { runOneJob } from "../src/modules/jobs/worker.js";
import { HOSTED_CAPABILITIES, hostedAdmissionFixture,
  hostedClaimRequest } from "./control-fixtures.js";
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
    await expect.poll(async () => {
      const response = await runtime.application.fetch(
        new Request("http://control.test/readyz"),
      );
      return {
        body: await response.json(),
        status: response.status,
      };
    }, {
      interval: 50,
      timeout: 5_000,
    }).toEqual({
      body: { status: "ready" },
      status: 200,
    });
    await runtime.close();
    expect(closes).toBe(1);
  });

  it("composes canonical Slack ingress through raw runtime HTTP routes", async () => {
    const slackFixture = await createIsolatedPostgres();
    const directory = await mkdtemp(join(tmpdir(), "opentag-slack-key-"));
    const keyFile = join(directory, "relay.key"); await writeFile(keyFile, Buffer.alloc(32, 9), { mode: 0o600 });
    await slackFixture.migrate(); const now = new Date();
    const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
    const deliveredSlackPayloads: unknown[] = [];
    const runtime = createControlPlaneRuntime({ config, migrations: slackFixture.migrations,
      postgres: { pool: slackFixture.pool, async close() {} },
      slackSecrets: { async resolve(reference) {
        if (reference === "env:SLACK_SIGNING_SECRET") return "secret";
        if (reference === "env:SLACK_BOT_TOKEN") return "bot";
        throw new Error("secret unavailable");
      } },
      slackFetchImpl: async (_url, init) => {
        deliveredSlackPayloads.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, ts: "1700000001.000100" });
      } });
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await runtime.application.fetch(new Request(String(url), init));
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    };
    const sourceBindingDigest = digest("binding");
    const targetBindingDigest = digest("target-binding");
    const generationDigest = digest("generation");
    const registered = await runtime.runners.register({ organizationId: "org_slack_runtime",
      organizationName: "Slack", request: { schemaVersion: 1, protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"], requestId: "register_slack_runtime",
        operationId: "register_slack_runtime", runnerId: "runner_slack_runtime",
        capabilities: [...HOSTED_CAPABILITIES] } });
    if (registered.kind !== "created") throw new Error("runner registration failed");
    const authenticated = await runtime.runners.authenticate(registered.response.runnerToken);
    if (authenticated.kind !== "authenticated") throw new Error("runner authentication failed");
    const runtimeClient = createOpenTagClient({ dispatcherUrl: "http://control.test",
      controlCredential: { kind: "runtime", token: registered.response.runnerToken }, fetchImpl });
    await runtime.runners.upsertProjectTarget({ principal: authenticated.principal,
      target: { projectTargetId: "target_slack_runtime", bindingDigest: targetBindingDigest,
        provider: "github", owner: "acme", repo: "demo", defaultExecutor: "executor_acp",
        defaultBranch: "main", version: 1 } });
    const readinessPayload = { readinessId: "readiness_slack_runtime",
      runnerId: "runner_slack_runtime", registrationGeneration: 1,
      capabilities: [...HOSTED_CAPABILITIES],
      executors: [{ executorId: "executor_acp", adapterVersion: "1.0.0",
        capabilityDigest: digest("executor"), state: "ready" as const }],
      targets: [{ projectTargetId: "target_slack_runtime",
        bindingDigest: targetBindingDigest, state: "ready" as const }],
      observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString() };
    const readinessSeed = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      receiptId: "readiness_receipt_hosted", organizationId: "org_slack_runtime",
      operationId: "readiness_slack_runtime", requiredCapabilities: ["relay.readiness.v1"] as const,
      producer: { kind: "runner" as const, id: "runner_slack_runtime",
        credentialId: registered.response.credentialId, registrationGeneration: 1 },
      identity: { namespace: "opentag.control.receipt/runner-readiness/v1" as const,
        parts: ["org_slack_runtime", "runner_slack_runtime", "1", "readiness_slack_runtime"] },
      observedAt: now.toISOString(), payloadDigest: await computeControlPayloadDigestV1(readinessPayload),
      receiptDigest: digest("unused"), receiptKind: "runner_readiness" as const,
      payload: readinessPayload };
    const { receiptDigest: _readinessDigest, ...readinessDigestInput } = readinessSeed;
    const readiness = RunnerReadinessReceiptEnvelopeV1Schema.parse({ ...readinessSeed,
      receiptDigest: await computeControlReceiptDigestV1(readinessDigestInput) });
    await runtime.runners.recordReadiness({ principal: authenticated.principal, receipt: readiness });
    await slackFixture.pool.query(`INSERT INTO cp_source_app_installation(organization_id,installation_id,
      source_app_id,app_instance_id,binding_digest,credential_generation,credential_generation_digest,
      state,created_at,updated_at) VALUES('org_slack_runtime','install_runtime','slack','A_RUNTIME',$1,1,$2,'active',$3,$3)`,
      [sourceBindingDigest, generationDigest, now]);
    await slackFixture.pool.query(`INSERT INTO cp_source_binding(organization_id,binding_id,installation_id,
      binding_digest,state,created_at,updated_at) VALUES('org_slack_runtime','binding_runtime',
      'install_runtime',$1,'active',$2,$2)`, [sourceBindingDigest, now]);
    await slackFixture.pool.query(`INSERT INTO cp_slack_installation(organization_id,installation_id,binding_id,
      project_target_id,publication_mode,route_identity,team_id,app_id,channel_id,bot_user_id,member_user_ids,
      operator_user_ids,approver_user_id,admin_user_ids,
      signing_secret_ref,bot_token_ref,created_at,updated_at)
      VALUES('org_slack_runtime','install_runtime','binding_runtime','target_slack_runtime','pull_request','route_runtime',
      'T_RUNTIME','A_RUNTIME','C_RUNTIME','U_APP',ARRAY['U_MEMBER','U_APPROVER','U_OPERATOR'],
      ARRAY['U_OPERATOR'],'U_APPROVER',ARRAY['U_OPERATOR'],
      'env:SLACK_SIGNING_SECRET','env:SLACK_BOT_TOKEN',$1,$1)`, [now]);
    await expect(runtime.providerDeliveryWorker.processNext()).resolves.toEqual({ kind: "empty", recovered: 0,
      failures: [] });
    const send = (teamId: string) => { const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ type: "event_callback", team_id: teamId, api_app_id: "A_RUNTIME",
        event_id: `Ev_${teamId}`, event_time: Math.floor(now.getTime() / 1000),
        authorizations: [{ user_id: "U_APP" }], event: { type: "app_mention", user: "U_MEMBER",
          text: "<@U_APP> fix", ts: "1700000000.000100", channel: "C_RUNTIME" } });
      return runtime.application.fetch(new Request("http://control.test/v1/providers/slack/events/route_runtime",
        { method: "POST", headers: { "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": computeSlackSignature({ signingSecret: "secret", timestamp, rawBody: body }) },
          body })); };
    const sendAction = (token: string, decision: "allow_once" | "publication_approve",
      actorId = "U_APPROVER") => {
      const payload = { type: "block_actions", api_app_id: "A_RUNTIME",
        team: { id: "T_RUNTIME" }, user: { id: actorId }, channel: { id: "C_RUNTIME" },
        container: { channel_id: "C_RUNTIME", thread_ts: "1700000000.000100",
          message_ts: "1700000001.000100" },
        actions: [{ action_id: `opentag:decision:${decision}`, value: token }] };
      const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
      const timestamp = String(Math.floor(Date.now() / 1_000));
      return runtime.application.fetch(new Request(
        "http://control.test/v1/providers/slack/interactivity/route_runtime",
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": computeSlackSignature({ signingSecret: "secret", timestamp,
            rawBody: body }) }, body }));
    };
    try {
      expect((await send("T_RUNTIME")).status).toBe(200);
      expect((await send("T_WRONG")).status).toBe(404);
      await expect(runtime.sourceIngressWorker!.processNext()).resolves.toMatchObject({
        kind: "settled", resolution: { kind: "waiting_for_runner" },
      });
      const resolution = await slackFixture.pool.query<{ run_id: string }>(
        `SELECT resolution->>'runId' AS run_id FROM cp_source_resolution
         WHERE organization_id='org_slack_runtime'`);
      const runId = resolution.rows[0]?.run_id;
      expect(runId).toMatch(/^run_[a-f0-9]{31}$/u);
      const durable = await slackFixture.pool.query<{
        run_state: string; provider: string; event_name: string;
        intent_state: string; projection_purpose: string; provider_instance_id: string;
        operation_kind: string; thread_ts: string;
      }>(`SELECT run.state AS run_state,run.hosted_admission->>'provider' AS provider,
          run.hosted_admission->>'eventName' AS event_name,intent.state AS intent_state,
          intent.projection_purpose,intent.provider_instance_id,
          intent.payload->'providerRequest'->'operation'->>'kind' AS operation_kind,
          intent.payload->'providerRequest'->'operation'->>'threadTs' AS thread_ts
        FROM cp_hosted_run run JOIN cp_provider_delivery_intent intent
          ON intent.organization_id=run.organization_id AND intent.run_id=run.run_id
        WHERE run.organization_id='org_slack_runtime' AND run.run_id=$1`, [runId]);
      expect(durable.rows).toEqual([{ run_state: "queued", provider: "slack",
        event_name: "app_mention", intent_state: "pending", projection_purpose: "anchor_create",
        provider_instance_id: "A_RUNTIME", operation_kind: "create_message",
        thread_ts: "1700000000.000100" }]);
      const projectedActionToken = async (decision: "allow_once" | "publication_approve") => {
        const findToken = (value: unknown): string | null => {
          if (Array.isArray(value)) {
            for (const item of value) { const found = findToken(item); if (found) return found; }
            return null;
          }
          if (!value || typeof value !== "object") return null;
          const record = value as Record<string, unknown>;
          if (record["action_id"] === `opentag:decision:${decision}`
            && typeof record["value"] === "string") return record["value"];
          return findToken(Object.values(record));
        };
        for (let index = 0; index < 8; index += 1) {
          const rows = await slackFixture.pool.query<{ payload: unknown }>(
            `SELECT payload FROM cp_provider_delivery_intent
             WHERE organization_id='org_slack_runtime' AND run_id=$1
             ORDER BY projection_revision DESC,projection_event_sequence DESC,created_at DESC`,
            [runId]);
          for (const row of rows.rows) {
            const token = findToken(row.payload); if (token) return token;
          }
          const job = await runOneJob({ queue: runtime.jobs, workerId: `projection-${decision}-${index}`,
            handlers: runtime.jobHandlers, retryDelayMs: 1_000, clock: { now: () => new Date() } });
          if (job.kind === "empty") break;
        }
        throw new Error(`${decision} projection control missing`);
      };
      for (let index = 0; index < 4 && deliveredSlackPayloads.length === 0; index += 1) {
        await runOneJob({ queue: runtime.jobs, workerId: `slack-runtime-${index}`,
          handlers: runtime.jobHandlers, retryDelayMs: 1_000, clock: { now: () => new Date() } });
      }
      expect(deliveredSlackPayloads).toHaveLength(1);
      const claimFromHttp = await runtimeClient.claimHostedRunControlV1({
        runnerId: "runner_slack_runtime",
        request: hostedClaimRequest({ operationId: "claim_slack_runtime",
          requestId: "claim_slack_runtime", credentialId: registered.response.credentialId,
          readinessDigest: readiness.receiptDigest }) });
      if (!claimFromHttp) throw new Error("Slack run claim failed");
      const claimed = { claim: claimFromHttp };
      const redeemed = await runtimeClient.redeemHostedSourceContentControlV1({
        runnerId: claimed.claim.runnerId,
        request: { schemaVersion: 1, protocolVersion: "1.0",
          requiredCapabilities: ["relay.source-content-redeem.v1"],
          requestId: "redeem_slack_runtime", operationId: "redeem_slack_runtime",
          organizationId: claimed.claim.organizationId, runnerId: claimed.claim.runnerId,
          runId: claimed.claim.runId, expectedAuthority: {
            credentialId: claimed.claim.authority.credentialId,
            registrationGeneration: claimed.claim.authority.registrationGeneration,
            credentialGeneration: claimed.claim.authority.credentialGeneration },
          attempt: { attemptId: claimed.claim.attempt.id,
            attemptNumber: claimed.claim.attempt.number, epoch: claimed.claim.attempt.epoch,
            fencingTokenDigest: claimed.claim.attempt.fencingTokenDigest,
            leaseExpiresAt: claimed.claim.attempt.leaseExpiresAt },
          grant: claimed.claim.sourceContentGrant,
          admissionEnvelopeDigest: claimed.claim.hostedAdmission.envelopeDigest,
          contentEnvelope: claimed.claim.hostedAdmission.sourceContextEnvelope } });
      expect(redeemed.content.payload).toMatchObject({ executionBearingCommentBody: "fix",
        event: { source: "slack", sourceEventId: "Ev_T_RUNTIME",
          command: { rawText: "fix" } } });
      const workspaceAttestation = { workspaceId: "workspace_slack_runtime",
        workspacePathDigest: digest("workspace-path"), repositoryPathDigest: digest("repository-path"),
        worktreeIdentityDigest: digest("worktree"), baseRevision: "a".repeat(40),
        currentRevision: "a".repeat(40), currentTree: "b".repeat(40),
        workspaceStateDigest: digest("workspace-state"), attemptId: claimed.claim.attempt.id,
        attemptNumber: claimed.claim.attempt.number,
        fencingTokenDigest: claimed.claim.attempt.fencingTokenDigest,
        credentialId: claimed.claim.authority.credentialId,
        leaseExpiresAt: claimed.claim.attempt.leaseExpiresAt };
      const running = await buildHostedLifecycleRequestV1({ action: "running",
        organizationId: claimed.claim.organizationId, runnerId: claimed.claim.runnerId,
        runId: claimed.claim.runId, attempt: { attemptId: claimed.claim.attempt.id,
          attemptNumber: claimed.claim.attempt.number, epoch: claimed.claim.attempt.epoch,
          fencingToken: claimed.claim.attempt.fencingToken,
          fencingTokenDigest: claimed.claim.attempt.fencingTokenDigest },
        occurredAt: new Date().toISOString(), executorId: claimed.claim.executorId,
        executorCapabilityDigest: claimed.claim.authority.executorCapabilityDigest,
        workspaceAttestation });
      await runtimeClient.markHostedRunRunningControlV1({
        organizationId: claimed.claim.organizationId,
        credentialId: claimed.claim.authority.credentialId,
        runnerId: claimed.claim.runnerId, runId: claimed.claim.runId, request: running });
      const permissionDigestInput = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
        requiredCapabilities: ["relay.permission.v1"] as const,
        organizationId: claimed.claim.organizationId, runnerId: claimed.claim.runnerId,
        runId: claimed.claim.runId, attempt: { attemptId: claimed.claim.attempt.id,
          attemptNumber: claimed.claim.attempt.number, epoch: claimed.claim.attempt.epoch,
          fencingTokenDigest: claimed.claim.attempt.fencingTokenDigest },
        permissionRequestId: "permission_slack_runtime", actionId: "action_slack_runtime",
        actionDescriptor: "workspace.write" as const,
        actionDescriptorDigest: await computeControlPayloadDigestV1("workspace.write"),
        riskTier: "high" as const, targetFingerprint: digest("target-fingerprint"),
        policySnapshotRef: claimed.claim.admissionPolicySnapshot.payload.snapshotId,
        policySnapshotDigest: claimed.claim.admissionPolicySnapshot.receiptDigest,
        workspaceAttestationDigest: await computeControlPayloadDigestV1(workspaceAttestation),
        requestedAt: new Date().toISOString() };
      const permissionRequest = RunnerPermissionRequestV1Schema.parse({ ...permissionDigestInput,
        requestId: "request_permission_slack_runtime",
        operationId: "operation_permission_slack_runtime",
        attempt: { ...permissionDigestInput.attempt,
          fencingToken: claimed.claim.attempt.fencingToken },
        permissionRequestDigest: await computePermissionRequestDigestV1(permissionDigestInput) });
      const waiting = await runtimeClient.requestActionPermissionControlV1(permissionRequest);
      expect(waiting).toMatchObject({ status: 202, outcome: "waiting" });
      expect((await slackFixture.pool.query(`SELECT action_kind,allowed_decisions,
          requester_user_id,approver_user_id,claim_state FROM cp_slack_action_authority
        WHERE organization_id='org_slack_runtime' AND pending_request_id=$1`,
      [permissionRequest.permissionRequestId])).rows).toEqual([{ action_kind: "approval",
        allowed_decisions: ["allow_once", "deny"], requester_user_id: "U_MEMBER",
        approver_user_id: "U_APPROVER", claim_state: "available" }]);
      const needsHuman = await buildHostedLifecycleRequestV1({
        organizationId: claimed.claim.organizationId, runnerId: claimed.claim.runnerId,
        runId: claimed.claim.runId, action: "complete",
        attempt: { attemptId: claimed.claim.attempt.id,
          attemptNumber: claimed.claim.attempt.number, epoch: claimed.claim.attempt.epoch,
          fencingToken: claimed.claim.attempt.fencingToken,
          fencingTokenDigest: claimed.claim.attempt.fencingTokenDigest },
        occurredAt: new Date().toISOString(), conclusion: "needs_human",
        reasonCode: "executor_needs_human", resultDigest: digest("needs-human"),
        workspaceAttestation, artifactDigests: [], evidenceDigests: [],
        blockedPermission: { permissionRequestId: permissionRequest.permissionRequestId,
          actionDescriptorDigest: permissionRequest.actionDescriptorDigest,
          policySnapshotDigest: permissionRequest.policySnapshotDigest } });
      await runtimeClient.completeHostedRunControlV1({
        organizationId: claimed.claim.organizationId,
        credentialId: claimed.claim.authority.credentialId,
        runnerId: claimed.claim.runnerId, runId: claimed.claim.runId,
        request: needsHuman });
      const approvalResponse = await sendAction(
        await projectedActionToken("allow_once"), "allow_once");
      expect(approvalResponse.status).toBe(200);
      const finalRevision = "c".repeat(40); const finalTree = "d".repeat(40);
      const finalWorkspaceAttestation = { ...workspaceAttestation,
        currentRevision: finalRevision, currentTree: finalTree,
        workspaceStateDigest: digest("final-workspace-state") };
      const verification = { command: "git diff --check", outcome: "passed" as const };
      const verificationDigest = await computeControlPayloadDigestV1(verification);
      const evidenceInput = { schemaVersion: 1 as const,
        kind: "attempt_proposal_evidence" as const, attemptId: claimed.claim.attempt.id,
        attemptNumber: claimed.claim.attempt.number, workspaceId: workspaceAttestation.workspaceId,
        workspacePathDigest: workspaceAttestation.workspacePathDigest,
        branch: `opentag/${claimed.claim.runId}`, baseRevision: workspaceAttestation.baseRevision,
        finalRevision, finalTree, diffDigest: digest("content-free-diff"),
        changedFilesDigest: await computeControlPayloadDigestV1(["src/index.ts"]),
        changedFiles: ["src/index.ts"], verificationEvidenceDigests: [verificationDigest],
        limitations: ["No provider publication was attempted."] };
      const evidenceDigest = await computeControlPayloadDigestV1(evidenceInput);
      const proposalArtifactInput = { id: `${claimed.claim.runId}:proposal-evidence`,
        type: "patch_summary" as const, kind: "patch" as const,
        title: "Immutable proposal evidence",
        uri: `opentag://run/${encodeURIComponent(claimed.claim.runId)}/proposal-evidence`,
        summary: "Attempt-bound content-free proposal evidence.", sourceRunId: claimed.claim.runId,
        createdAt: new Date().toISOString(), metadata: { proposalEvidence: { ...evidenceInput,
          evidenceDigest }, evidenceDigest, readiness: "not_assessed" as const } };
      const proposalArtifact = { ...proposalArtifactInput, metadata: {
        ...proposalArtifactInput.metadata,
        artifactDigest: await computeControlPayloadDigestV1(proposalArtifactInput) } };
      const success = await buildHostedLifecycleRequestV1({
        organizationId: claimed.claim.organizationId, runnerId: claimed.claim.runnerId,
        runId: claimed.claim.runId, action: "complete",
        attempt: { attemptId: claimed.claim.attempt.id,
          attemptNumber: claimed.claim.attempt.number, epoch: claimed.claim.attempt.epoch,
          fencingToken: claimed.claim.attempt.fencingToken,
          fencingTokenDigest: claimed.claim.attempt.fencingTokenDigest },
        occurredAt: new Date().toISOString(), conclusion: "success",
        reasonCode: "executor_success", resultDigest: digest("executor-success"),
        workspaceAttestation: finalWorkspaceAttestation,
        artifactDigests: [proposalArtifact.metadata.artifactDigest],
        evidenceDigests: [verificationDigest] });
      await runtimeClient.completeHostedRunControlV1({
        organizationId: claimed.claim.organizationId,
        credentialId: claimed.claim.authority.credentialId,
        runnerId: claimed.claim.runnerId, runId: claimed.claim.runId, request: success });
      const candidateId = `candidate_${proposalArtifact.metadata.artifactDigest
        .slice("sha256:".length, "sha256:".length + 48)}`;
      const settled = await runtimeClient.settleProposalCandidateControlV1({
        schemaVersion: 1, protocolVersion: "1.0", requiredCapabilities: ["relay.lifecycle.v1"],
        requestId: "settle_slack_runtime", organizationId: claimed.claim.organizationId,
        runnerId: claimed.claim.runnerId, runId: claimed.claim.runId,
        attempt: { attemptId: claimed.claim.attempt.id,
          attemptNumber: claimed.claim.attempt.number, epoch: claimed.claim.attempt.epoch,
          fencingToken: claimed.claim.attempt.fencingToken,
          fencingTokenDigest: claimed.claim.attempt.fencingTokenDigest },
        candidateId, proposalArtifact });
      expect(settled).toMatchObject({ outcome: "settled", status: "publication_pending" });
      const ownership = RunnerBranchOwnershipAttestationV1Schema.parse({
        schemaVersion: 1, protocolVersion: "1.0", requiredCapabilities: ["relay.publication.v1"],
        requestId: "ownership_slack_runtime", organizationId: "org_slack_runtime",
        runnerId: "runner_slack_runtime", runnerGeneration: 1,
        runId: claimed.claim.runId, attemptId: claimed.claim.attempt.id,
        attemptNumber: claimed.claim.attempt.number,
        fencingToken: claimed.claim.attempt.fencingToken, candidateId,
        candidateDigest: settled.candidateDigest,
        projectTargetId: "target_slack_runtime", targetBindingDigest,
        remote: "origin", baseBranch: "main", frozenBaseRevision: workspaceAttestation.baseRevision,
        workspaceTreeDigest: finalTree, branch: `opentag/${claimed.claim.runId}`,
        expectedHeadSha: finalRevision, attestedAt: new Date().toISOString() });
      await expect(runtimeClient.attestPublicationBranchOwnershipControlV1(ownership))
        .resolves.toMatchObject({ replayed: false });
      expect((await slackFixture.pool.query(`SELECT action_kind,allowed_decisions,
          approver_user_id,publication_approval->>'candidateId' AS candidate_id
        FROM cp_slack_action_authority WHERE organization_id='org_slack_runtime'
          AND action_kind='publication'`)).rows).toEqual([{ action_kind: "publication",
        allowed_decisions: ["publication_approve"], approver_user_id: "U_APPROVER",
        candidate_id: candidateId }]);
      const publicationResponse = await sendAction(
        await projectedActionToken("publication_approve"), "publication_approve");
      expect(publicationResponse.status).toBe(200);
      expect((await slackFixture.pool.query(`SELECT candidate_id,approver_id,repository->>'provider' AS provider
        FROM cp_publication_intent WHERE organization_id='org_slack_runtime'`)).rows)
        .toEqual([{ candidate_id: candidateId, approver_id: "U_APPROVER", provider: "github" }]);
    } finally {
      await runtime.close();
      await slackFixture.close();
      await rm(directory, { recursive: true, force: true });
    }
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

  it("rejects the retired prebuilt-admission source-context shortcut", async () => {
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
          keyVersion: "v1", envelopeDigest: rawDigest, payloadDigest: rawDigest },
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
        kind: "settled", resolution: { kind: "invalid_request",
          code: "source_context_invalid" },
      });
      const durable = await fixture.pool.query(
        `SELECT (SELECT count(*)::int FROM cp_source_resolution
                   WHERE organization_id = $1) AS resolutions,
                (SELECT state FROM cp_job WHERE job_id = $2) AS job_state`,
        ["org_runtime_source", `source-ingress:${reservationId}`],
      );
      expect(durable.rows[0]).toEqual({ resolutions: 1, job_state: "succeeded" });
    } finally {
      await runtime.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
