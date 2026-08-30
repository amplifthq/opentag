import {
  buildHostedLifecycleRequestV1,
  computePermissionRequestDigestV1,
  computeControlPayloadDigestV1,
  HumanPermissionDecisionRequestV1Schema,
  PermissionResolutionReceiptEnvelopeV1Schema,
  RunnerPermissionCurrentQueryV1Schema,
  RunnerPermissionRequestV1Schema,
} from "@opentag/control-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createMaterialActionCoordinator } from "../src/modules/hosted-runs/material-actions.js";
import { createPermissionCoordinator } from "../src/modules/hosted-runs/permissions.js";
import { createConsoleReadModel } from "../src/modules/console-reads/index.js";
import { createRunnerDirectory, type RuntimePrincipal } from "../src/modules/runners/index.js";
import {
  hostedAdmissionFixture,
  hostedClaimRequest,
  hostedGrantIssuerFixture,
  recordHostedReadiness,
} from "./control-fixtures.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("governed permissions PostgreSQL module", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let principal: RuntimePrincipal;
  const now = new Date("2026-08-15T14:00:00.000Z");

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    const runners = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => now },
      idFactory: () => "credential_permission",
      tokenFactory: () => "runtime_permission_secret",
    });
    const registration = await runners.register({
      organizationId: "org_permission",
      organizationName: "Permissions",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_register_permission",
        operationId: "operation_register_permission",
        runnerId: "runner_permission",
        capabilities: [
          "relay.claim-fence.v1",
          "relay.hosted-admission.v1",
          "relay.hosted-claim.v1",
          "relay.lifecycle.v1",
          "relay.permission.v1",
          "relay.readiness.v1",
          "relay.source-content-redeem.v1",
        ],
      },
    });
    if (registration.kind !== "created") throw new Error("registration failed");
    const authenticated = await runners.authenticate("runtime_permission_secret");
    if (authenticated.kind !== "authenticated") throw new Error("authentication failed");
    principal = authenticated.principal;
    await recordHostedReadiness({
      pool: fixture.pool,
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
    });
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("persists waiting authority and resolves exactly one attributed decision", async () => {
    const hosted = createHostedRunCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      leaseDurationMs: 60_000,
      idFactory: () => "attempt_permission",
      tokenFactory: () => "fence_permission",
      issueSourceContentGrantInTransaction: hostedGrantIssuerFixture,
    });
    const admission = await hostedAdmissionFixture({
      runId: "run_permission",
      suffix: "91",
      organizationId: "org_permission",
      runnerId: "runner_permission",
      permissionActions: ["git.force_push", "git.push", "git.target_write",
        "github.branch.delete", "github.pull_request.create",
        "github.pull_request.merge", "github.pull_request.update",
        "github.release.create", "workspace.write"],
    });
    await hosted.admit({
      runId: "run_permission",
      admission: admission.admission,
      policy: admission.policy,
    });
    const claimOutcome = await hosted.claim({
      principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_permission",
        requestId: "request_claim_permission",
        credentialId: "credential_permission",
      }),
    });
    if (claimOutcome.kind !== "claimed") throw new Error("claim failed");
    const claim = claimOutcome.claim;
    const workspaceAttestation = { workspaceId: "workspace_permission",
      workspacePathDigest: `sha256:${"1".repeat(64)}`,
      repositoryPathDigest: `sha256:${"2".repeat(64)}`,
      worktreeIdentityDigest: `sha256:${"3".repeat(64)}`,
      baseRevision: "a".repeat(40), currentRevision: "a".repeat(40),
      currentTree: "b".repeat(40), workspaceStateDigest: `sha256:${"4".repeat(64)}`,
      attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
      fencingTokenDigest: claim.attempt.fencingTokenDigest,
      credentialId: claim.authority.credentialId, leaseExpiresAt: claim.attempt.leaseExpiresAt };
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt SET workspace_attestation = $4::jsonb
       WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3`,
      [principal.organizationId, claim.runId, claim.attempt.id,
        JSON.stringify(workspaceAttestation)],
    );
    const workspaceAttestationDigest = await computeControlPayloadDigestV1(workspaceAttestation);
    const lifecycleAttempt = { attemptId: claim.attempt.id,
      attemptNumber: claim.attempt.number, epoch: claim.attempt.epoch,
      fencingToken: claim.attempt.fencingToken,
      fencingTokenDigest: claim.attempt.fencingTokenDigest };
    const digestInput = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.permission.v1"] as const,
      organizationId: "org_permission",
      runnerId: "runner_permission",
      runId: "run_permission",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      permissionRequestId: "permission_request_1",
      actionId: "action_1",
      actionDescriptor: "workspace.write" as const,
      actionDescriptorDigest: await computeControlPayloadDigestV1("workspace.write"),
      riskTier: "high" as const,
      targetFingerprint: `sha256:${"1".repeat(64)}`,
      policySnapshotRef: admission.policy.payload.snapshotId,
      policySnapshotDigest: admission.policy.receiptDigest,
      workspaceAttestationDigest,
      requestedAt: now.toISOString(),
    };
    const request = RunnerPermissionRequestV1Schema.parse({
      ...digestInput,
      requestId: "request_permission_1",
      operationId: "operation_permission_1",
      attempt: {
        ...digestInput.attempt,
        fencingToken: claim.attempt.fencingToken,
      },
      permissionRequestDigest: await computePermissionRequestDigestV1(
        digestInput,
      ),
    });
    const permissions = createPermissionCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      idFactory: (kind) => `${kind}_1`,
    });
    const { workspaceAttestationDigest: _workspaceDigest, ...legacyDigestInput } = digestInput;
    const missingWorkspaceRequest = RunnerPermissionRequestV1Schema.parse({
      ...legacyDigestInput, permissionRequestId: "permission_missing_workspace",
      actionId: "action_missing_workspace", requestId: "request_missing_workspace",
      operationId: "operation_missing_workspace",
      attempt: { ...legacyDigestInput.attempt, fencingToken: claim.attempt.fencingToken },
      permissionRequestDigest: await computePermissionRequestDigestV1({
        ...legacyDigestInput, permissionRequestId: "permission_missing_workspace",
        actionId: "action_missing_workspace" }),
    });
    await fixture.pool.query(
      "UPDATE cp_hosted_attempt SET workspace_attestation=NULL WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3",
      [principal.organizationId, claim.runId, claim.attempt.id]);
    await expect(permissions.request({ principal, request: missingWorkspaceRequest }))
      .resolves.toEqual({ kind: "stale_fence" });
    await fixture.pool.query(
      "UPDATE cp_hosted_attempt SET workspace_attestation=$4::jsonb WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3",
      [principal.organizationId, claim.runId, claim.attempt.id, JSON.stringify(workspaceAttestation)]);
    const wrongWorkspaceRequest = RunnerPermissionRequestV1Schema.parse({
      ...digestInput, workspaceAttestationDigest: `sha256:${"f".repeat(64)}`,
      permissionRequestId: "permission_wrong_workspace", actionId: "action_wrong_workspace",
      requestId: "request_wrong_workspace", operationId: "operation_wrong_workspace",
      attempt: { ...digestInput.attempt, fencingToken: claim.attempt.fencingToken },
      permissionRequestDigest: await computePermissionRequestDigestV1({
        ...legacyDigestInput, permissionRequestId: "permission_wrong_workspace",
        actionId: "action_wrong_workspace" }),
    });
    await expect(permissions.request({ principal, request: wrongWorkspaceRequest }))
      .resolves.toEqual({ kind: "conflict" });
    const publicationDigestInput = {
      ...digestInput,
      permissionRequestId: "permission_request_publication_denied",
      actionId: "action_publication_denied",
      actionDescriptor: "github.pull_request.create" as const,
      actionDescriptorDigest: await computeControlPayloadDigestV1(
        "github.pull_request.create"),
    };
    const publicationRequest = RunnerPermissionRequestV1Schema.parse({
      ...publicationDigestInput,
      requestId: "request_publication_denied",
      operationId: "operation_publication_denied",
      attempt: { ...publicationDigestInput.attempt,
        fencingToken: claim.attempt.fencingToken },
      permissionRequestDigest: await computePermissionRequestDigestV1(
        publicationDigestInput,
      ),
    });
    await expect(permissions.request({ principal, request: publicationRequest }))
      .resolves.toEqual({ kind: "conflict" });
    for (const [index, actionDescriptor] of ([
      "git.push", "git.force_push", "git.target_write",
      "github.pull_request.create", "github.pull_request.update",
      "github.pull_request.merge", "github.release.create", "github.branch.delete",
    ] as const).entries()) {
      const publication = { ...digestInput,
        permissionRequestId: `permission_publication_${index}`,
        actionId: `action_publication_${index}`,
        actionDescriptor,
        actionDescriptorDigest: await computeControlPayloadDigestV1(actionDescriptor) };
      const candidate = RunnerPermissionRequestV1Schema.parse({ ...publication,
        requestId: `request_publication_${index}`,
        operationId: `operation_publication_${index}`,
        attempt: { ...publication.attempt, fencingToken: claim.attempt.fencingToken },
        permissionRequestDigest: await computePermissionRequestDigestV1(publication),
      });
      await expect(permissions.request({ principal, request: candidate }))
        .resolves.toEqual({ kind: "conflict" });
    }
    expect(RunnerPermissionRequestV1Schema.safeParse({ ...publicationRequest,
      actionDescriptor: "github.future.publish" }).success).toBe(false);
    const untrustedPolicyDigestInput = {
      ...digestInput,
      permissionRequestId: "permission_request_untrusted_policy",
      actionId: "action_untrusted_policy",
      policySnapshotDigest: `sha256:${"9".repeat(64)}`,
    };
    const untrustedPolicyRequest = RunnerPermissionRequestV1Schema.parse({
      ...untrustedPolicyDigestInput,
      requestId: "request_permission_untrusted_policy",
      operationId: "operation_permission_untrusted_policy",
      attempt: {
        ...untrustedPolicyDigestInput.attempt,
        fencingToken: claim.attempt.fencingToken,
      },
      permissionRequestDigest: await computePermissionRequestDigestV1(
        untrustedPolicyDigestInput,
      ),
    });
    await expect(permissions.request({
      principal,
      request: untrustedPolicyRequest,
    })).resolves.toEqual({ kind: "stale_fence" });

    const tamperDigestInput = { ...digestInput,
      permissionRequestId: "permission_request_tampered_approval",
      actionId: "action_tampered_approval" };
    const tamperRequest = RunnerPermissionRequestV1Schema.parse({
      ...tamperDigestInput, requestId: "request_tampered_approval",
      operationId: "operation_tampered_approval",
      attempt: { ...tamperDigestInput.attempt, fencingToken: claim.attempt.fencingToken },
      permissionRequestDigest: await computePermissionRequestDigestV1(tamperDigestInput),
    });
    await expect(permissions.request({ principal, request: tamperRequest }))
      .resolves.toMatchObject({ kind: "waiting" });
    await fixture.pool.query(
      `UPDATE cp_permission_request
       SET request = jsonb_set(request, '{actionDescriptor}', '"github.pull_request.create"'::jsonb)
       WHERE organization_id = $1 AND permission_request_id = $2`,
      [principal.organizationId, tamperRequest.permissionRequestId],
    );
    const tamperAllow = HumanPermissionDecisionRequestV1Schema.parse({
      schemaVersion: 1, protocolVersion: "1.0",
      requiredCapabilities: ["relay.permission.v1"],
      requestId: "request_tampered_allow", operationId: "operation_tampered_allow",
      organizationId: principal.organizationId, runId: tamperRequest.runId,
      attempt: digestInput.attempt, actionId: tamperRequest.actionId,
      permissionRequestId: tamperRequest.permissionRequestId,
      permissionRequestDigest: tamperRequest.permissionRequestDigest,
      policySnapshotDigest: tamperRequest.policySnapshotDigest,
      decisionId: "decision_tampered_allow", decision: "allow_once",
      decidedAt: now.toISOString(),
    });
    await expect(permissions.resolve({ principal: { organizationId: principal.organizationId,
      actorId: "api_key_approver" }, runnerId: principal.runnerId,
      decision: tamperAllow })).resolves.toEqual({ kind: "conflict" });

    const unrelatedDigestInput = { ...digestInput,
      permissionRequestId: "permission_request_unrelated_waiting",
      actionId: "action_unrelated_waiting",
      targetFingerprint: `sha256:${"6".repeat(64)}` };
    const unrelatedRequest = RunnerPermissionRequestV1Schema.parse({
      ...unrelatedDigestInput, requestId: "request_unrelated_waiting",
      operationId: "operation_unrelated_waiting",
      attempt: { ...unrelatedDigestInput.attempt, fencingToken: claim.attempt.fencingToken },
      permissionRequestDigest: await computePermissionRequestDigestV1(unrelatedDigestInput),
    });
    await expect(permissions.request({ principal, request: unrelatedRequest }))
      .resolves.toMatchObject({ kind: "waiting" });
    const unrelatedAllow = HumanPermissionDecisionRequestV1Schema.parse({
      schemaVersion: 1, protocolVersion: "1.0",
      requiredCapabilities: ["relay.permission.v1"],
      requestId: "request_unrelated_allow", operationId: "operation_unrelated_allow",
      organizationId: principal.organizationId, runId: unrelatedRequest.runId,
      attempt: digestInput.attempt, actionId: unrelatedRequest.actionId,
      permissionRequestId: unrelatedRequest.permissionRequestId,
      permissionRequestDigest: unrelatedRequest.permissionRequestDigest,
      policySnapshotDigest: unrelatedRequest.policySnapshotDigest,
      decisionId: "decision_unrelated_allow", decision: "allow_once",
      decidedAt: now.toISOString(),
    });
    await expect(permissions.resolve({ principal: { organizationId: principal.organizationId,
      actorId: "api_key_approver" }, runnerId: principal.runnerId,
      decision: unrelatedAllow })).resolves.toMatchObject({ kind: "resolved",
        receipt: { payload: { state: "authorized" } } });

    const resolveWorkspaceCase = async (caseName: string, mutate: () => Promise<void>, valid = false) => {
      const candidateInput = { ...digestInput,
        permissionRequestId: `permission_resolution_workspace_${caseName}`,
        actionId: `action_resolution_workspace_${caseName}` };
      const candidate = RunnerPermissionRequestV1Schema.parse({ ...candidateInput,
        requestId: `request_resolution_workspace_${caseName}`,
        operationId: `operation_resolution_workspace_${caseName}`,
        attempt: { ...candidateInput.attempt, fencingToken: claim.attempt.fencingToken },
        permissionRequestDigest: await computePermissionRequestDigestV1(candidateInput) });
      await expect(permissions.request({ principal, request: candidate }))
        .resolves.toMatchObject({ kind: "waiting" });
      const decision = HumanPermissionDecisionRequestV1Schema.parse({
        schemaVersion: 1, protocolVersion: "1.0",
        requiredCapabilities: ["relay.permission.v1"],
        requestId: `decision_request_resolution_workspace_${caseName}`,
        operationId: `decision_operation_resolution_workspace_${caseName}`,
        organizationId: principal.organizationId, runId: candidate.runId,
        attempt: digestInput.attempt, actionId: candidate.actionId,
        permissionRequestId: candidate.permissionRequestId,
        permissionRequestDigest: candidate.permissionRequestDigest,
        policySnapshotDigest: candidate.policySnapshotDigest,
        decisionId: `decision_resolution_workspace_${caseName}`,
        decision: "allow_once", decidedAt: now.toISOString(),
      });
      await mutate();
      const resolution = permissions.resolve({ principal: {
        organizationId: principal.organizationId, actorId: "api_key_approver" },
        runnerId: principal.runnerId, decision });
      if (valid) {
        await expect(resolution).resolves.toMatchObject({ kind: "resolved",
          receipt: { payload: { state: "authorized", workspaceAttestationDigest } } });
      } else {
        await expect(resolution).resolves.toEqual({ kind: "stale_fence" });
      }
      await fixture.pool.query(
        "UPDATE cp_hosted_attempt SET workspace_attestation=$4::jsonb WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3",
        [principal.organizationId, claim.runId, claim.attempt.id, JSON.stringify(workspaceAttestation)]);
      await fixture.pool.query(
        "UPDATE cp_hosted_run SET current_attempt_number=$3, state='assigned' WHERE organization_id=$1 AND run_id=$2",
        [principal.organizationId, claim.runId, claim.attempt.number]);
      return { candidate, decision };
    };
    await resolveWorkspaceCase("missing_request", async () => {
      await fixture.pool.query(
        "UPDATE cp_permission_request SET request=request-'workspaceAttestationDigest' WHERE organization_id=$1 AND permission_request_id=$2",
        [principal.organizationId, "permission_resolution_workspace_missing_request"]);
    });
    await resolveWorkspaceCase("missing_receipt", async () => {
      await fixture.pool.query(
        "UPDATE cp_permission_request SET current_receipt=jsonb_set(current_receipt, '{payload}', (current_receipt->'payload') - 'workspaceAttestationDigest'::text) WHERE organization_id=$1 AND permission_request_id=$2",
        [principal.organizationId, "permission_resolution_workspace_missing_receipt"]);
    });
    await resolveWorkspaceCase("request_receipt_mismatch", async () => {
      await fixture.pool.query(
        "UPDATE cp_permission_request SET current_receipt=jsonb_set(current_receipt, '{payload,workspaceAttestationDigest}', to_jsonb($3::text)) WHERE organization_id=$1 AND permission_request_id=$2",
        [principal.organizationId, "permission_resolution_workspace_request_receipt_mismatch", `sha256:${"f".repeat(64)}`]);
    });
    await resolveWorkspaceCase("null_canonical", async () => {
      await fixture.pool.query(
        "UPDATE cp_hosted_attempt SET workspace_attestation=NULL WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3",
        [principal.organizationId, claim.runId, claim.attempt.id]);
    });
    await resolveWorkspaceCase("mismatched_canonical", async () => {
      await fixture.pool.query(
        "UPDATE cp_hosted_attempt SET workspace_attestation=jsonb_set(workspace_attestation, '{workspaceId}', '\"different_workspace\"') WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3",
        [principal.organizationId, claim.runId, claim.attempt.id]);
    });
    await resolveWorkspaceCase("non_current", async () => {
      await fixture.pool.query(
        "UPDATE cp_hosted_run SET current_attempt_number=$3 WHERE organization_id=$1 AND run_id=$2",
        [principal.organizationId, claim.runId, claim.attempt.number + 1]);
    });
    const validResolution = await resolveWorkspaceCase("valid_control", async () => {}, true);
    await fixture.pool.query(
      "UPDATE cp_hosted_attempt SET workspace_attestation=NULL WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3",
      [principal.organizationId, claim.runId, claim.attempt.id]);
    await expect(permissions.resolve({ principal: { organizationId: principal.organizationId,
      actorId: "api_key_approver" }, runnerId: principal.runnerId,
      decision: validResolution.decision })).resolves.toEqual({ kind: "stale_fence" });
    await fixture.pool.query(
      "UPDATE cp_hosted_attempt SET workspace_attestation=$4::jsonb WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3",
      [principal.organizationId, claim.runId, claim.attempt.id, JSON.stringify(workspaceAttestation)]);

    const waiting = await permissions.request({ principal, request });
    expect(waiting.kind).toBe("waiting");
    if (waiting.kind !== "waiting") throw new Error("waiting receipt missing");
    expect(
      PermissionResolutionReceiptEnvelopeV1Schema.parse(waiting.receipt).payload,
    ).toMatchObject({ state: "waiting", nextAction: "wait_for_operator" });
    const needsHuman = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId, runnerId: principal.runnerId,
      runId: claim.runId, action: "complete", attempt: lifecycleAttempt,
      occurredAt: now.toISOString(), conclusion: "needs_human",
      reasonCode: "executor_needs_human", resultDigest: `sha256:${"0".repeat(64)}`,
      workspaceAttestation,
      artifactDigests: [], evidenceDigests: [], blockedPermission: {
        permissionRequestId: request.permissionRequestId,
        actionDescriptorDigest: request.actionDescriptorDigest,
        policySnapshotDigest: request.policySnapshotDigest },
    });
    await hosted.lifecycle({ principal, runId: claim.runId,
      action: "complete", request: needsHuman });
    const storedRequest = await fixture.pool.query<{ request: unknown }>(
      `SELECT request FROM cp_permission_request
       WHERE organization_id = $1 AND permission_request_id = $2`,
      [principal.organizationId, request.permissionRequestId],
    );
    expect(JSON.stringify(storedRequest.rows[0]?.request)).not.toContain(
      claim.attempt.fencingToken,
    );
    expect(JSON.stringify(storedRequest.rows[0]?.request)).toContain(
      claim.attempt.fencingTokenDigest,
    );
    const afterBlockedDigestInput = { ...digestInput,
      permissionRequestId: "permission_request_after_blocked",
      actionId: "action_after_blocked",
      targetFingerprint: `sha256:${"7".repeat(64)}` };
    const afterBlockedRequest = RunnerPermissionRequestV1Schema.parse({
      ...afterBlockedDigestInput, requestId: "request_after_blocked",
      operationId: "operation_after_blocked",
      attempt: { ...afterBlockedDigestInput.attempt, fencingToken: claim.attempt.fencingToken },
      permissionRequestDigest: await computePermissionRequestDigestV1(afterBlockedDigestInput),
    });
    await expect(permissions.request({ principal, request: afterBlockedRequest }))
      .resolves.toEqual({ kind: "stale_fence" });
    await expect(permissions.request({ principal, request: unrelatedRequest }))
      .resolves.toEqual({ kind: "stale_fence" });
    await expect(permissions.resolve({ principal: { organizationId: principal.organizationId,
      actorId: "api_key_approver" }, runnerId: principal.runnerId,
      decision: unrelatedAllow })).resolves.toEqual({ kind: "conflict" });
    await expect(createMaterialActionCoordinator({ pool: fixture.pool,
      clock: { now: () => now } }).begin({ principal,
      fencingToken: claim.attempt.fencingToken, runId: claim.runId,
      attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
      actionId: request.actionId,
      actionDescriptor: request.actionDescriptor,
      actionDescriptorDigest: request.actionDescriptorDigest,
      targetFingerprint: request.targetFingerprint,
      policySnapshotRef: request.policySnapshotRef,
      policySnapshotDigest: request.policySnapshotDigest,
      workspaceAttestationDigest,
      authority: { kind: "permission_resolution",
        permissionRequestId: request.permissionRequestId,
        permissionRequestDigest: request.permissionRequestDigest,
        resolutionReceiptId: waiting.receipt.receiptId,
        resolutionReceiptDigest: waiting.receipt.receiptDigest },
      idempotencyKey: "material_begin_during_approval",
    })).resolves.toEqual({ kind: "stale_fence" });
    const consolePermissions = await createConsoleReadModel({
      pool: fixture.pool,
    }).listPermissions({
      operatorId: "viewer_permission",
      organizationId: principal.organizationId,
      role: "viewer",
      email: "viewer@example.test",
      displayName: "Viewer",
    });
    expect(JSON.stringify(consolePermissions)).not.toContain(
      claim.attempt.fencingToken,
    );
    const query = RunnerPermissionCurrentQueryV1Schema.parse({
      organizationId: request.organizationId,
      runnerId: request.runnerId,
      runId: request.runId,
      attempt: digestInput.attempt,
      actionId: request.actionId,
      permissionRequestId: request.permissionRequestId,
      permissionRequestDigest: request.permissionRequestDigest,
    });
    await expect(permissions.current({ principal, query })).resolves.toMatchObject({
      kind: "waiting",
      receipt: { receiptDigest: waiting.receipt.receiptDigest },
    });

    const allow = HumanPermissionDecisionRequestV1Schema.parse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.permission.v1"],
      requestId: "request_permission_decision_allow",
      operationId: "operation_permission_decision_allow",
      organizationId: "org_permission",
      runId: "run_permission",
      attempt: digestInput.attempt,
      actionId: request.actionId,
      permissionRequestId: request.permissionRequestId,
      permissionRequestDigest: request.permissionRequestDigest,
      policySnapshotDigest: request.policySnapshotDigest,
      decisionId: "decision_allow_1",
      decision: "allow_once",
      decidedAt: now.toISOString(),
    });
    const wrongEpoch = HumanPermissionDecisionRequestV1Schema.parse({ ...allow,
      requestId: "request_permission_decision_wrong_epoch",
      operationId: "operation_permission_decision_wrong_epoch",
      decisionId: "decision_wrong_epoch" });
    await expect(permissions.resolve({ principal: { organizationId: "org_permission",
      actorId: "api_key_approver" }, runnerId: "runner_permission", decision: wrongEpoch,
      authorityAttemptEpoch: allow.attempt.epoch + 1 }))
      .resolves.toEqual({ kind: "conflict" });
    expect((await fixture.pool.query(`SELECT state FROM cp_permission_request
      WHERE organization_id='org_permission' AND permission_request_id=$1`,
    [request.permissionRequestId])).rows).toEqual([{ state: "waiting" }]);
    const approved = await permissions.resolve({
      principal: { organizationId: "org_permission", actorId: "api_key_approver" },
      runnerId: "runner_permission", decision: allow,
    });
    expect(approved).toMatchObject({ kind: "resolved",
      receipt: { payload: { state: "authorized" } } });
    if (approved.kind !== "resolved") throw new Error("approval resolution missing");
    await expect(hosted.inspect({ organizationId: "org_permission",
      runId: "run_permission" })).resolves.toMatchObject({ canonicalStatus: "running" });
    const current = await permissions.current({ principal, query });
    expect(current.kind).toBe("resolved");
    if (current.kind !== "resolved") throw new Error("resolution missing");
    expect(current.receipt.payload.state).toBe("authorized");
    expect(current.receipt.payload.decisionActorRef).toBe("api_key_approver");
    const material = createMaterialActionCoordinator({ pool: fixture.pool,
      clock: { now: () => now } });
    await expect(material.begin({ principal,
      fencingToken: claim.attempt.fencingToken, runId: claim.runId,
      attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
      actionId: request.actionId, actionDescriptor: request.actionDescriptor,
      actionDescriptorDigest: request.actionDescriptorDigest,
      targetFingerprint: request.targetFingerprint,
      policySnapshotRef: request.policySnapshotRef,
      policySnapshotDigest: request.policySnapshotDigest,
      workspaceAttestationDigest,
      authority: { kind: "permission_resolution",
        permissionRequestId: request.permissionRequestId,
        permissionRequestDigest: request.permissionRequestDigest,
        resolutionReceiptId: approved.receipt.receiptId,
        resolutionReceiptDigest: approved.receipt.receiptDigest,
        workspaceAttestationDigest },
      idempotencyKey: "material_begin_exact_approval",
    })).resolves.toEqual({ kind: "begun" });
    const success = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId, runnerId: principal.runnerId,
      runId: claim.runId, action: "complete", attempt: lifecycleAttempt,
      occurredAt: now.toISOString(), conclusion: "success",
      reasonCode: "executor_success", resultDigest: `sha256:${"2".repeat(64)}`,
      artifactDigests: [], evidenceDigests: [],
      workspaceAttestation,
    });
    await expect(hosted.lifecycle({ principal, runId: claim.runId,
      action: "complete", request: success })).resolves.toMatchObject({ kind: "accepted" });
    await expect(hosted.inspect({ organizationId: "org_permission",
      runId: "run_permission" })).resolves.toMatchObject({ canonicalStatus: "succeeded" });
  });

  it("terminally rejects an exact needs-approval denial", async () => {
    const hosted = createHostedRunCoordinator({ pool: fixture.pool,
      clock: { now: () => now }, leaseDurationMs: 60_000,
      idFactory: () => "attempt_permission_deny", tokenFactory: () => "fence_permission_deny",
      issueSourceContentGrantInTransaction: hostedGrantIssuerFixture });
    const admission = await hostedAdmissionFixture({ runId: "run_permission_deny",
      suffix: "permission_deny", organizationId: "org_permission",
      runnerId: "runner_permission", permissionActions: ["workspace.write"] });
    await hosted.admit({ runId: "run_permission_deny", admission: admission.admission,
      policy: admission.policy });
    const claimOutcome = await hosted.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_permission_deny",
      requestId: "request_claim_permission_deny", credentialId: "credential_permission" }) });
    if (claimOutcome.kind !== "claimed") throw new Error("claim failed");
    const claim = claimOutcome.claim;
    const denyWorkspaceAttestation = { workspaceId: "workspace_permission_deny",
      workspacePathDigest: `sha256:${"1".repeat(64)}`,
      repositoryPathDigest: `sha256:${"2".repeat(64)}`,
      worktreeIdentityDigest: `sha256:${"3".repeat(64)}`, baseRevision: "a".repeat(40),
      currentRevision: "a".repeat(40), currentTree: "b".repeat(40),
      workspaceStateDigest: `sha256:${"4".repeat(64)}`, attemptId: claim.attempt.id,
      attemptNumber: claim.attempt.number, fencingTokenDigest: claim.attempt.fencingTokenDigest,
      credentialId: claim.authority.credentialId, leaseExpiresAt: claim.attempt.leaseExpiresAt };
    await fixture.pool.query(
      "UPDATE cp_hosted_attempt SET workspace_attestation=$4::jsonb WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3",
      [claim.organizationId, claim.runId, claim.attempt.id, JSON.stringify(denyWorkspaceAttestation)]);
    const lifecycleAttempt = { attemptId: claim.attempt.id,
      attemptNumber: claim.attempt.number, epoch: claim.attempt.epoch,
      fencingToken: claim.attempt.fencingToken,
      fencingTokenDigest: claim.attempt.fencingTokenDigest };
    const digestInput = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.permission.v1"] as const,
      organizationId: principal.organizationId, runnerId: principal.runnerId,
      runId: claim.runId, attempt: { attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number, epoch: claim.attempt.epoch,
        fencingTokenDigest: claim.attempt.fencingTokenDigest },
      permissionRequestId: "permission_request_deny", actionId: "action_deny",
      actionDescriptor: "workspace.write" as const,
      actionDescriptorDigest: await computeControlPayloadDigestV1("workspace.write"),
      riskTier: "high" as const, targetFingerprint: `sha256:${"5".repeat(64)}`,
      policySnapshotRef: admission.policy.payload.snapshotId,
      policySnapshotDigest: admission.policy.receiptDigest,
      workspaceAttestationDigest: await computeControlPayloadDigestV1(denyWorkspaceAttestation),
      requestedAt: now.toISOString() };
    const request = RunnerPermissionRequestV1Schema.parse({ ...digestInput,
      requestId: "request_permission_deny", operationId: "operation_permission_deny",
      attempt: { ...digestInput.attempt, fencingToken: claim.attempt.fencingToken },
      permissionRequestDigest: await computePermissionRequestDigestV1(digestInput) });
    const permissions = createPermissionCoordinator({ pool: fixture.pool,
      clock: { now: () => now }, idFactory: (kind) => `${kind}_deny` });
    await permissions.request({ principal, request });
    const needsHuman = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId, runnerId: principal.runnerId,
      runId: claim.runId, action: "complete", attempt: lifecycleAttempt,
      occurredAt: now.toISOString(), conclusion: "needs_human",
      reasonCode: "executor_needs_human", resultDigest: `sha256:${"4".repeat(64)}`,
      artifactDigests: [], evidenceDigests: [], blockedPermission: {
        permissionRequestId: request.permissionRequestId,
        actionDescriptorDigest: request.actionDescriptorDigest,
        policySnapshotDigest: request.policySnapshotDigest },
      workspaceAttestation: denyWorkspaceAttestation });
    await hosted.lifecycle({ principal, runId: claim.runId,
      action: "complete", request: needsHuman });
    const deny = HumanPermissionDecisionRequestV1Schema.parse({ schemaVersion: 1,
      protocolVersion: "1.0", requiredCapabilities: ["relay.permission.v1"],
      requestId: "request_decision_deny", operationId: "operation_decision_deny",
      organizationId: principal.organizationId, runId: claim.runId,
      attempt: digestInput.attempt, actionId: request.actionId,
      permissionRequestId: request.permissionRequestId,
      permissionRequestDigest: request.permissionRequestDigest,
      policySnapshotDigest: request.policySnapshotDigest,
      decisionId: "decision_deny", decision: "deny", decidedAt: now.toISOString() });

    await expect(permissions.resolve({ principal: { organizationId: principal.organizationId,
      actorId: "api_key_approver" }, runnerId: principal.runnerId, decision: deny }))
      .resolves.toMatchObject({ kind: "resolved", receipt: { payload: { state: "denied" } } });
    await expect(hosted.inspect({ organizationId: principal.organizationId,
      runId: claim.runId })).resolves.toMatchObject({ canonicalStatus: "failed",
        terminalReason: "permission_denied" });
  });
});
