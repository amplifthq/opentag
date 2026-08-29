import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeControlPayloadDigestV1,
  computePermissionRequestDigestV1,
  RunnerPermissionRequestV1Schema } from "@opentag/control-protocol";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createMaterialActionCoordinator } from "../src/modules/hosted-runs/material-actions.js";
import { createPermissionCoordinator } from "../src/modules/hosted-runs/permissions.js";
import { createRunnerDirectory, type RuntimePrincipal } from "../src/modules/runners/index.js";
import { authorizeHostedMaterialActionFixture, HOSTED_CAPABILITIES,
  hostedAdmissionFixture, hostedClaimRequest,
  hostedGrantIssuerFixture, recordHostedReadiness } from "./control-fixtures.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("Hosted Run PostgreSQL races", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let principal: RuntimePrincipal;
  let now = new Date("2026-08-15T07:00:00.000Z");
  let sequence = 0;
  const clock = { now: () => new Date(now) };

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    const runners = createRunnerDirectory({ pool: fixture.pool, clock,
      tokenFactory: () => "runtime_race_secret",
      idFactory: () => "credential_race" });
    const registered = await runners.register({ organizationId: "org_race",
      organizationName: "Race", request: { schemaVersion: 1, protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"], requestId: "request_register_race",
        operationId: "operation_register_race", runnerId: "runner_race",
        capabilities: [...HOSTED_CAPABILITIES] } });
    if (registered.kind !== "created") throw new Error("registration failed");
    const authenticated = await runners.authenticate("runtime_race_secret");
    if (authenticated.kind !== "authenticated") throw new Error("authentication failed");
    principal = authenticated.principal;
    await recordHostedReadiness({ pool: fixture.pool, organizationId: "org_race",
      runnerId: "runner_race", receiptId: "readiness_receipt_hosted" });
  });

  afterAll(async () => fixture.close());

  const coordinator = () => createHostedRunCoordinator({ pool: fixture.pool, clock,
    leaseDurationMs: 60_000, idFactory: () => `attempt_race_${++sequence}`,
    tokenFactory: (context) => `fence_${context.attemptId}`,
    issueSourceContentGrantInTransaction: hostedGrantIssuerFixture });

  async function releaseTwoClientBarrier() {
    const left = await fixture.pool.connect();
    const right = await fixture.pool.connect();
    try {
      await Promise.all([
        left.query("SELECT pg_advisory_xact_lock($1)", [8_240_001]),
        right.query("SELECT pg_advisory_xact_lock($1)", [8_240_002]),
      ]);
    } finally {
      left.release();
      right.release();
    }
  }

  it("gives claim or finite deadline expiry one database winner and never revives", async () => {
    const service = coordinator();
    const deadline = "2026-08-15T07:00:01.000Z";
    const candidate = await hostedAdmissionFixture({ runId: "run_deadline_race",
      suffix: "deadlinerace", organizationId: "org_race", runnerId: "runner_race",
      queueClaimDeadline: deadline });
    await service.admit({ runId: "run_deadline_race", admission: candidate.admission,
      policy: candidate.policy });
    now = new Date(deadline);
    await releaseTwoClientBarrier();

    const [claim, expiry] = await Promise.all([
      service.claim({ principal, request: hostedClaimRequest({
        operationId: "operation_claim_deadline_race",
        requestId: "request_claim_deadline_race",
        credentialId: "credential_race",
      }) }),
      service.expireQueued("org_race"),
    ]);

    expect(Number(claim.kind === "claimed") + expiry.expired).toBe(1);
    const view = await service.inspect({ organizationId: "org_race", runId: "run_deadline_race" });
    expect(view?.canonicalStatus).toBe(claim.kind === "claimed" ? "assigned" : "timed_out");
    if (view?.canonicalStatus === "timed_out") {
      now = new Date("2026-08-15T07:01:00.000Z");
      await expect(service.claim({ principal, request: hostedClaimRequest({
        operationId: "operation_claim_deadline_late", requestId: "request_claim_deadline_late",
        credentialId: "credential_race" }) })).resolves.toEqual({ kind: "empty" });
    }
  });

  it("serializes source deletion against claim and fences whichever authority remains", async () => {
    now = new Date("2026-08-15T08:00:00.000Z");
    const service = coordinator();
    const candidate = await hostedAdmissionFixture({ runId: "run_delete_race",
      suffix: "edeleterace", organizationId: "org_race", runnerId: "runner_race",
      queueClaimDeadline: "2026-08-15T09:00:00.000Z" });
    await service.admit({ runId: "run_delete_race", admission: candidate.admission,
      policy: candidate.policy });
    await releaseTwoClientBarrier();

    const [claim, receipt] = await Promise.all([
      service.claim({ principal, request: hostedClaimRequest({
        operationId: "operation_claim_delete_race", requestId: "request_claim_delete_race",
        credentialId: "credential_race" }) }),
      service.invalidate({ organizationId: "org_race",
        sourceVersionRef: candidate.admission.sourceContextEnvelope.sourceVersionRef,
        contentIds: [candidate.admission.sourceContextEnvelope.contentId],
        reason: "source_content_deleted", commandId: "command_delete_race" }),
    ]);

    expect(receipt).toMatchObject({ commandId: "command_delete_race",
      reason: "source_content_deleted" });
    const view = await service.inspect({ organizationId: "org_race", runId: "run_delete_race" });
    expect(view?.canonicalStatus).toBe(claim.kind === "claimed" ? "interrupted" : "cancelled");
    await expect(service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_delete_late", requestId: "request_claim_delete_late",
      credentialId: "credential_race" }) })).resolves.toEqual({ kind: "empty" });
    await expect(service.invalidate({ organizationId: "org_race",
      sourceVersionRef: candidate.admission.sourceContextEnvelope.sourceVersionRef,
      contentIds: [candidate.admission.sourceContextEnvelope.contentId],
      reason: "source_content_deleted", commandId: "command_delete_race" }))
      .resolves.toEqual(receipt);
  });

  it("never replaces an expired unstarted Attempt after the original claim deadline", async () => {
    now = new Date("2026-08-15T07:30:00.000Z");
    const service = coordinator();
    const candidate = await hostedAdmissionFixture({ runId: "run_attempt_deadline",
      suffix: "aattemptdeadline", organizationId: "org_race", runnerId: "runner_race",
      queueClaimDeadline: "2026-08-15T07:30:30.000Z" });
    await service.admit({ runId: "run_attempt_deadline", admission: candidate.admission,
      policy: candidate.policy });
    const claim = await service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_attempt_deadline",
      requestId: "request_claim_attempt_deadline", credentialId: "credential_race" }) });
    if (claim.kind !== "claimed") throw new Error("claim failed");
    const materialAuthority = createMaterialActionCoordinator({ pool: fixture.pool, clock });
    await materialAuthority.recordNotStarted({
      principal, fencingToken: claim.claim.attempt.fencingToken,
      runId: claim.claim.runId, attemptId: claim.claim.attempt.id,
      attemptNumber: claim.claim.attempt.number, proofId: "proof_attempt_deadline",
      proofDigest: `sha256:${"6".repeat(64)}`,
    });
    await fixture.pool.query(
      "UPDATE cp_hosted_attempt SET lease_expires_at = $3 WHERE organization_id = $1 AND run_id = $2",
      ["org_race", "run_attempt_deadline", new Date("2026-08-15T07:30:20.000Z")],
    );
    now = new Date("2026-08-15T07:30:31.000Z");
    await expect(service.reconcileExpiredAttempts("org_race"))
      .resolves.toMatchObject({ expired: expect.any(Number) });
    await expect(service.inspect({ organizationId: "org_race", runId: "run_attempt_deadline" }))
      .resolves.toMatchObject({ canonicalStatus: "timed_out",
        terminalReason: "original_claim_deadline_expired" });
    await expect(service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_attempt_replacement_late",
      requestId: "request_claim_attempt_replacement_late",
      credentialId: "credential_race" }) })).resolves.toEqual({ kind: "empty" });
  });

  it("reconciles in deterministic Run then Attempt lock order without deadlock", async () => {
    now = new Date("2026-08-15T07:45:00.000Z");
    const service = coordinator();
    const candidate = await hostedAdmissionFixture({ runId: "run_lock_order",
      suffix: "lock_order", organizationId: "org_race", runnerId: "runner_race",
      queueClaimDeadline: "2026-08-15T08:45:00.000Z" });
    await service.admit({ runId: "run_lock_order", admission: candidate.admission,
      policy: candidate.policy });
    const claim = await service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_lock_order", requestId: "request_claim_lock_order",
      credentialId: "credential_race" }) });
    if (claim.kind !== "claimed") throw new Error("claim failed");
    await fixture.pool.query(
      "UPDATE cp_hosted_attempt SET lease_expires_at = $3 WHERE organization_id = $1 AND run_id = $2",
      ["org_race", "run_lock_order", new Date(now.getTime() - 1)],
    );
    const lifecycleClient = await fixture.pool.connect();
    try {
      await lifecycleClient.query("BEGIN");
      await lifecycleClient.query("SET LOCAL lock_timeout = '3s'");
      await lifecycleClient.query(
        "SELECT 1 FROM cp_hosted_run WHERE organization_id = $1 AND run_id = $2 FOR UPDATE",
        ["org_race", "run_lock_order"],
      );
      const reconciliation = service.reconcileExpiredAttempts("org_race");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(lifecycleClient.query(
        `SELECT 1 FROM cp_hosted_attempt WHERE organization_id = $1 AND run_id = $2
         AND attempt_number = $3 FOR UPDATE`,
        ["org_race", "run_lock_order", claim.claim.attempt.number],
      )).resolves.toBeDefined();
      await lifecycleClient.query("COMMIT");
      await expect(reconciliation).resolves.toMatchObject({ expired: expect.any(Number) });
    } finally {
      await lifecycleClient.query("ROLLBACK").catch(() => undefined);
      lifecycleClient.release();
    }
  });

  it("blocks replacement when external start may have crashed before any receipt", async () => {
    now = new Date("2026-08-15T09:00:00.000Z");
    const service = coordinator();
    const candidate = await hostedAdmissionFixture({ runId: "run_start_crash",
      suffix: "start_crash", organizationId: "org_race", runnerId: "runner_race",
      queueClaimDeadline: "2026-08-15T10:00:00.000Z" });
    await service.admit({ runId: "run_start_crash", admission: candidate.admission,
      policy: candidate.policy });
    const claim = await service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_start_crash", requestId: "request_claim_start_crash",
      credentialId: "credential_race" }) });
    if (claim.kind !== "claimed") throw new Error("claim failed");
    await fixture.pool.query(
      "UPDATE cp_hosted_attempt SET lease_expires_at = $3 WHERE organization_id = $1 AND run_id = $2",
      ["org_race", "run_start_crash", new Date(now.getTime() - 1)],
    );

    await expect(service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_start_crash_direct",
      requestId: "request_claim_start_crash_direct",
      credentialId: "credential_race" }) })).resolves.toEqual({ kind: "empty" });

    await service.reconcileExpiredAttempts("org_race");

    await expect(service.inspect({ organizationId: "org_race", runId: "run_start_crash" }))
      .resolves.toMatchObject({ canonicalStatus: "interrupted", outcome: "outcome_unknown",
        terminalReason: "attempt_lease_expired_after_material_start" });
    await expect(service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_start_crash_replacement",
      requestId: "request_claim_start_crash_replacement",
      credentialId: "credential_race" }) })).resolves.toEqual({ kind: "empty" });
  });

  it("serializes exact negative proof against replacement claim and rejects stale proof", async () => {
    now = new Date("2026-08-15T09:30:00.000Z");
    const service = coordinator();
    const candidate = await hostedAdmissionFixture({ runId: "run_proof_claim_race",
      suffix: "proof_claim_race", organizationId: "org_race", runnerId: "runner_race",
      queueClaimDeadline: "2026-08-15T10:30:00.000Z" });
    await service.admit({ runId: "run_proof_claim_race", admission: candidate.admission,
      policy: candidate.policy });
    const claim = await service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_proof_race", requestId: "request_claim_proof_race",
      credentialId: "credential_race" }) });
    if (claim.kind !== "claimed") throw new Error("claim failed");
    const materials = createMaterialActionCoordinator({ pool: fixture.pool, clock });
    await expect(materials.recordNotStarted({ principal, fencingToken: "stale_fence",
      runId: claim.claim.runId, attemptId: claim.claim.attempt.id,
      attemptNumber: claim.claim.attempt.number, proofId: "proof_stale",
      proofDigest: `sha256:${"8".repeat(64)}` })).resolves.toEqual({ kind: "stale_fence" });

    const [proof, replacement] = await Promise.all([
      materials.recordNotStarted({ principal,
        fencingToken: claim.claim.attempt.fencingToken,
        runId: claim.claim.runId, attemptId: claim.claim.attempt.id,
        attemptNumber: claim.claim.attempt.number, proofId: "proof_claim_race",
        proofDigest: `sha256:${"9".repeat(64)}` }),
      service.claim({ principal, request: hostedClaimRequest({
        operationId: "operation_claim_proof_race_replacement",
        requestId: "request_claim_proof_race_replacement",
        credentialId: "credential_race" }) }),
    ]);
    expect(proof).toEqual({ kind: "recorded" });
    expect(["claimed", "empty"]).toContain(replacement.kind);
    if (replacement.kind === "empty") {
      const afterProof = await service.claim({ principal, request: hostedClaimRequest({
        operationId: "operation_claim_proof_race_after_proof",
        requestId: "request_claim_proof_race_after_proof",
        credentialId: "credential_race" }) });
      expect(afterProof.kind).toBe("claimed");
    }
    const attempts = await fixture.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM cp_hosted_attempt WHERE run_id = $1",
      [claim.claim.runId],
    );
    expect(attempts.rows[0]?.count).toBe(2);
    await service.cancelRun({ organizationId: principal.organizationId,
      runId: claim.claim.runId, reason: "proof_claim_race_complete" });
  });

  it("gives proof or server-authoritative material begin one CAS winner", async () => {
    now = new Date("2026-08-15T09:45:00.000Z");
    const service = coordinator();
    const candidate = await hostedAdmissionFixture({ runId: "run_proof_begin_race",
      suffix: "proof_begin_race", organizationId: "org_race", runnerId: "runner_race",
      queueClaimDeadline: "2026-08-15T10:45:00.000Z",
      permissionActions: ["github.pull_request.merge"], publicationMode: "pull_request" });
    await service.admit({ runId: "run_proof_begin_race", admission: candidate.admission,
      policy: candidate.policy });
    const claim = await service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_proof_begin", requestId: "request_claim_proof_begin",
      credentialId: "credential_race" }) });
    if (claim.kind !== "claimed") throw new Error("claim failed");
    const materials = createMaterialActionCoordinator({ pool: fixture.pool, clock });
    const actionDescriptor = "github.pull_request.merge" as const;
    const actionDescriptorDigest = await computeControlPayloadDigestV1(actionDescriptor);
    const targetFingerprint = `sha256:${"b".repeat(64)}`;
    const authorization = await authorizeHostedMaterialActionFixture({
      pool: fixture.pool, clock, principal, runId: claim.claim.runId,
      attempt: claim.claim.attempt, actionId: "action_proof_begin_race",
      actionDescriptor, targetFingerprint,
      policySnapshotRef: candidate.policy.payload.snapshotId,
      policySnapshotDigest: candidate.policy.receiptDigest,
      suffix: "proof_begin_race",
    });

    const [proof, begin] = await Promise.all([
      materials.recordNotStarted({ principal, fencingToken: claim.claim.attempt.fencingToken,
        runId: claim.claim.runId, attemptId: claim.claim.attempt.id,
        attemptNumber: claim.claim.attempt.number, proofId: "proof_begin_race",
        proofDigest: `sha256:${"a".repeat(64)}` }),
      materials.begin({ principal, fencingToken: claim.claim.attempt.fencingToken,
        runId: claim.claim.runId, attemptId: claim.claim.attempt.id,
        attemptNumber: claim.claim.attempt.number,
        actionId: "action_proof_begin_race", actionDescriptor,
        actionDescriptorDigest, targetFingerprint,
        policySnapshotRef: candidate.policy.payload.snapshotId,
        policySnapshotDigest: candidate.policy.receiptDigest,
        authority: authorization.authority,
        idempotencyKey: "begin_proof_race" }),
    ]);

    expect([proof.kind, begin.kind].filter((kind) => kind === "recorded" || kind === "begun"))
      .toHaveLength(1);
    const state = await fixture.pool.query<{ material_start_state: string }>(
      "SELECT material_start_state FROM cp_hosted_attempt WHERE run_id = $1",
      [claim.claim.runId]);
    expect(["proven_not_started", "started_or_ambiguous"])
      .toContain(state.rows[0]?.material_start_state);
    await service.cancelRun({ organizationId: principal.organizationId,
      runId: claim.claim.runId, reason: "proof_begin_race_complete" });
  });

  it("moves linked approval-pending work to safe replacement only when proof wins", async () => {
    now = new Date("2026-08-15T10:00:00.000Z");
    const service = coordinator();
    const candidate = await hostedAdmissionFixture({ runId: "run_approval_proof",
      suffix: "approval_proof", organizationId: "org_race", runnerId: "runner_race",
      queueClaimDeadline: "2026-08-15T11:00:00.000Z" });
    await service.admit({ runId: "run_approval_proof", admission: candidate.admission,
      policy: candidate.policy });
    const claim = await service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_approval_proof",
      requestId: "request_claim_approval_proof", credentialId: "credential_race" }) });
    if (claim.kind !== "claimed") throw new Error("claim failed");
    const actionDescriptorDigest = await computeControlPayloadDigestV1("workspace.write");
    const beginAuthorization = await authorizeHostedMaterialActionFixture({
      pool: fixture.pool, clock, principal, runId: claim.claim.runId,
      attempt: claim.claim.attempt, actionId: "action_approval_after_proof",
      actionDescriptor: "workspace.write", targetFingerprint: `sha256:${"e".repeat(64)}`,
      policySnapshotRef: candidate.policy.payload.snapshotId,
      policySnapshotDigest: candidate.policy.receiptDigest,
      suffix: "approval_after_proof",
    });
    await fixture.pool.query(
      `INSERT INTO cp_permission_request(organization_id, permission_request_id,
         run_id, runner_id, attempt_id, attempt_number, action_id, resolution_id,
         permission_request_digest, policy_snapshot_digest, state, request,
         current_receipt, created_at, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'waiting',$11::jsonb,'{}',$12,$12)`,
      ["org_race", "permission_approval_proof", claim.claim.runId, "runner_race",
        claim.claim.attempt.id, claim.claim.attempt.number, "action_approval_proof",
        "resolution_approval_proof", `sha256:${"b".repeat(64)}`,
        claim.claim.admissionPolicySnapshot.receiptDigest,
        JSON.stringify({ actionDescriptorDigest,
          attempt: { fencingTokenDigest: claim.claim.attempt.fencingTokenDigest } }), now]);
    const waiting = await import("@opentag/control-protocol").then(({ buildHostedLifecycleRequestV1 }) =>
      buildHostedLifecycleRequestV1({ organizationId: "org_race", runnerId: "runner_race",
        runId: claim.claim.runId, action: "complete", attempt: {
          attemptId: claim.claim.attempt.id, attemptNumber: claim.claim.attempt.number,
          epoch: claim.claim.attempt.epoch, fencingToken: claim.claim.attempt.fencingToken,
          fencingTokenDigest: claim.claim.attempt.fencingTokenDigest }, occurredAt: now.toISOString(),
        conclusion: "needs_human", reasonCode: "executor_needs_human",
        resultDigest: `sha256:${"c".repeat(64)}`, artifactDigests: [], evidenceDigests: [],
        blockedPermission: { permissionRequestId: "permission_approval_proof",
          actionDescriptorDigest,
          policySnapshotDigest: claim.claim.admissionPolicySnapshot.receiptDigest } }));
    await service.lifecycle({ principal, runId: claim.claim.runId,
      action: "complete", request: waiting });
    const materialAuthority = createMaterialActionCoordinator({ pool: fixture.pool, clock });
    await materialAuthority.recordNotStarted({
      principal, fencingToken: claim.claim.attempt.fencingToken,
      runId: claim.claim.runId, attemptId: claim.claim.attempt.id,
      attemptNumber: claim.claim.attempt.number, proofId: "proof_approval_pending",
      proofDigest: `sha256:${"d".repeat(64)}` });
    const heartbeat = await import("@opentag/control-protocol").then(
      ({ buildHostedLifecycleRequestV1 }) => buildHostedLifecycleRequestV1({
        organizationId: "org_race", runnerId: "runner_race", runId: claim.claim.runId,
        action: "heartbeat", attempt: { attemptId: claim.claim.attempt.id,
          attemptNumber: claim.claim.attempt.number, epoch: claim.claim.attempt.epoch,
          fencingToken: claim.claim.attempt.fencingToken,
          fencingTokenDigest: claim.claim.attempt.fencingTokenDigest },
        occurredAt: now.toISOString(),
        expectedLeaseExpiresAt: claim.claim.attempt.leaseExpiresAt }));
    await expect(service.lifecycle({ principal, runId: claim.claim.runId,
      action: "heartbeat", request: heartbeat })).resolves.toEqual({ kind: "stale_fence" });
    await expect(materialAuthority.begin({ principal,
      fencingToken: claim.claim.attempt.fencingToken, runId: claim.claim.runId,
      attemptId: claim.claim.attempt.id, attemptNumber: claim.claim.attempt.number,
      actionId: "action_approval_after_proof",
      actionDescriptor: "workspace.write", actionDescriptorDigest,
      targetFingerprint: `sha256:${"e".repeat(64)}`,
      policySnapshotRef: candidate.policy.payload.snapshotId,
      policySnapshotDigest: candidate.policy.receiptDigest,
      authority: beginAuthorization.authority,
      idempotencyKey: "begin_after_proof" })).resolves.toEqual({ kind: "stale_fence" });

    const replacement = await service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_approval_proof_replacement",
      requestId: "request_claim_approval_proof_replacement",
      credentialId: "credential_race" }) });
    expect(replacement.kind).toBe("claimed");
    expect((await fixture.pool.query(
      "SELECT state FROM cp_permission_request WHERE permission_request_id = $1",
      ["permission_approval_proof"])).rows).toEqual([{ state: "revoked" }]);
    await service.cancelRun({ organizationId: principal.organizationId,
      runId: claim.claim.runId, reason: "approval_proof_complete" });
  });

  it("rejects lifecycle authority when replayed proof encounters a fabricated future lease", async () => {
    now = new Date("2026-08-15T10:45:00.000Z");
    const service = coordinator();
    const candidate = await hostedAdmissionFixture({ runId: "run_proof_future_lease",
      suffix: "proof_future_lease", organizationId: "org_race", runnerId: "runner_race",
      queueClaimDeadline: "2026-08-15T11:45:00.000Z" });
    await service.admit({ runId: "run_proof_future_lease", admission: candidate.admission,
      policy: candidate.policy });
    const claim = await service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_proof_future_lease",
      requestId: "request_claim_proof_future_lease", credentialId: "credential_race" }) });
    if (claim.kind !== "claimed") throw new Error("claim failed");
    const materials = createMaterialActionCoordinator({ pool: fixture.pool, clock });
    const actionDescriptor = "workspace.write" as const;
    const actionDescriptorDigest = await computeControlPayloadDigestV1(actionDescriptor);
    const targetFingerprint = `sha256:${"3".repeat(64)}`;
    const beginAuthorization = await authorizeHostedMaterialActionFixture({
      pool: fixture.pool, clock, principal, runId: claim.claim.runId,
      attempt: claim.claim.attempt, actionId: "action_future_lease_proof",
      actionDescriptor, targetFingerprint,
      policySnapshotRef: candidate.policy.payload.snapshotId,
      policySnapshotDigest: candidate.policy.receiptDigest,
      suffix: "future_lease_proof_begin",
    });
    const proof = { principal, fencingToken: claim.claim.attempt.fencingToken,
      runId: claim.claim.runId, attemptId: claim.claim.attempt.id,
      attemptNumber: claim.claim.attempt.number, proofId: "proof_future_lease",
      proofDigest: `sha256:${"1".repeat(64)}` };
    await expect(materials.recordNotStarted(proof)).resolves.toEqual({ kind: "recorded" });
    const fabricatedLease = new Date(now.getTime() + 60_000);
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt SET state = 'running', lease_expires_at = $3
       WHERE organization_id = $1 AND run_id = $2`,
      [principal.organizationId, claim.claim.runId, fabricatedLease],
    );
    await fixture.pool.query(
      `UPDATE cp_hosted_run SET state = 'running'
       WHERE organization_id = $1 AND run_id = $2`,
      [principal.organizationId, claim.claim.runId],
    );
    const heartbeat = await import("@opentag/control-protocol").then(
      ({ buildHostedLifecycleRequestV1 }) => buildHostedLifecycleRequestV1({
        organizationId: principal.organizationId, runnerId: principal.runnerId,
        runId: claim.claim.runId, action: "heartbeat", attempt: {
          attemptId: claim.claim.attempt.id, attemptNumber: claim.claim.attempt.number,
          epoch: claim.claim.attempt.epoch, fencingToken: claim.claim.attempt.fencingToken,
          fencingTokenDigest: claim.claim.attempt.fencingTokenDigest },
        occurredAt: now.toISOString(), expectedLeaseExpiresAt: fabricatedLease.toISOString(),
      }));
    const complete = await import("@opentag/control-protocol").then(
      ({ buildHostedLifecycleRequestV1 }) => buildHostedLifecycleRequestV1({
        organizationId: principal.organizationId, runnerId: principal.runnerId,
        runId: claim.claim.runId, action: "complete", attempt: {
          attemptId: claim.claim.attempt.id, attemptNumber: claim.claim.attempt.number,
          epoch: claim.claim.attempt.epoch, fencingToken: claim.claim.attempt.fencingToken,
          fencingTokenDigest: claim.claim.attempt.fencingTokenDigest },
        occurredAt: now.toISOString(), conclusion: "success",
        reasonCode: "executor_success", resultDigest: `sha256:${"2".repeat(64)}`,
        artifactDigests: [], evidenceDigests: [],
      }));

    await expect(service.lifecycle({ principal, runId: claim.claim.runId,
      action: "heartbeat", request: heartbeat })).resolves.toEqual({ kind: "stale_fence" });
    await expect(service.lifecycle({ principal, runId: claim.claim.runId,
      action: "complete", request: complete })).resolves.toEqual({ kind: "stale_fence" });
    const permissionDigestInput = { schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.permission.v1"] as const,
      organizationId: principal.organizationId, runnerId: principal.runnerId,
      runId: claim.claim.runId,
      attempt: { attemptId: claim.claim.attempt.id,
        attemptNumber: claim.claim.attempt.number, epoch: claim.claim.attempt.epoch,
        fencingTokenDigest: claim.claim.attempt.fencingTokenDigest },
      permissionRequestId: "permission_future_lease_proof",
      actionId: "action_future_lease_proof", actionDescriptor, actionDescriptorDigest,
      riskTier: "high" as const, targetFingerprint: `sha256:${"3".repeat(64)}`,
      policySnapshotRef: candidate.policy.payload.snapshotId,
      policySnapshotDigest: candidate.policy.receiptDigest,
      requestedAt: now.toISOString() };
    const permissionRequest = RunnerPermissionRequestV1Schema.parse({
      ...permissionDigestInput, requestId: "request_future_lease_proof",
      operationId: "operation_future_lease_proof",
      attempt: { ...permissionDigestInput.attempt,
        fencingToken: claim.claim.attempt.fencingToken },
      permissionRequestDigest: await computePermissionRequestDigestV1(permissionDigestInput),
    });
    await expect(createPermissionCoordinator({ pool: fixture.pool, clock,
      idFactory: (kind) => `${kind}_future_lease_proof` }).request({
      principal, request: permissionRequest,
    })).resolves.toEqual({ kind: "stale_fence" });
    await expect(materials.begin({ principal,
      fencingToken: claim.claim.attempt.fencingToken, runId: claim.claim.runId,
      attemptId: claim.claim.attempt.id, attemptNumber: claim.claim.attempt.number,
      actionId: permissionDigestInput.actionId, actionDescriptor, actionDescriptorDigest,
      targetFingerprint, policySnapshotRef: candidate.policy.payload.snapshotId,
      policySnapshotDigest: candidate.policy.receiptDigest,
      authority: beginAuthorization.authority,
      idempotencyKey: "begin_future_lease_proof",
    })).resolves.toEqual({ kind: "stale_fence" });
    await expect(materials.recordNotStarted(proof)).resolves.toEqual({ kind: "replayed" });
    expect((await fixture.pool.query<{ state: string; lease_open: boolean }>(
      `SELECT state, lease_expires_at > $3 AS lease_open FROM cp_hosted_attempt
       WHERE organization_id = $1 AND run_id = $2`,
      [principal.organizationId, claim.claim.runId, now],
    )).rows).toEqual([{ state: "expired", lease_open: false }]);
    await service.cancelRun({ organizationId: principal.organizationId,
      runId: claim.claim.runId, reason: "future_lease_proof_complete" });
  });

  it("interrupts approval-pending work on lease expiry without proof", async () => {
    now = new Date("2026-08-15T11:30:00.000Z");
    const service = coordinator();
    const candidate = await hostedAdmissionFixture({ runId: "run_approval_expiry",
      suffix: "approval_expiry", organizationId: "org_race", runnerId: "runner_race",
      queueClaimDeadline: "2026-08-15T12:30:00.000Z" });
    await service.admit({ runId: "run_approval_expiry", admission: candidate.admission,
      policy: candidate.policy });
    const claim = await service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_approval_expiry",
      requestId: "request_claim_approval_expiry", credentialId: "credential_race" }) });
    if (claim.kind !== "claimed") throw new Error("claim failed");
    const descriptorDigest = await computeControlPayloadDigestV1("workspace.write");
    await fixture.pool.query(
      `INSERT INTO cp_permission_request(organization_id, permission_request_id,
         run_id, runner_id, attempt_id, attempt_number, action_id, resolution_id,
         permission_request_digest, policy_snapshot_digest, state, request,
         current_receipt, created_at, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'waiting',$11::jsonb,'{}',$12,$12)`,
      ["org_race", "permission_approval_expiry", claim.claim.runId, "runner_race",
        claim.claim.attempt.id, claim.claim.attempt.number, "action_approval_expiry",
        "resolution_approval_expiry", `sha256:${"e".repeat(64)}`,
        claim.claim.admissionPolicySnapshot.receiptDigest,
        JSON.stringify({ actionDescriptorDigest: descriptorDigest,
          attempt: { fencingTokenDigest: claim.claim.attempt.fencingTokenDigest } }), now]);
    const complete = await import("@opentag/control-protocol").then(({ buildHostedLifecycleRequestV1 }) =>
      buildHostedLifecycleRequestV1({ organizationId: "org_race", runnerId: "runner_race",
        runId: claim.claim.runId, action: "complete", attempt: {
          attemptId: claim.claim.attempt.id, attemptNumber: claim.claim.attempt.number,
          epoch: claim.claim.attempt.epoch, fencingToken: claim.claim.attempt.fencingToken,
          fencingTokenDigest: claim.claim.attempt.fencingTokenDigest }, occurredAt: now.toISOString(),
        conclusion: "needs_human", reasonCode: "executor_needs_human",
        resultDigest: `sha256:${"f".repeat(64)}`, artifactDigests: [], evidenceDigests: [],
        blockedPermission: { permissionRequestId: "permission_approval_expiry",
          actionDescriptorDigest: descriptorDigest,
          policySnapshotDigest: claim.claim.admissionPolicySnapshot.receiptDigest } }));
    await service.lifecycle({ principal, runId: claim.claim.runId,
      action: "complete", request: complete });
    await fixture.pool.query(
      "UPDATE cp_hosted_attempt SET lease_expires_at = $3 WHERE organization_id = $1 AND run_id = $2",
      ["org_race", claim.claim.runId, new Date(now.getTime() - 1)]);

    await service.reconcileExpiredAttempts("org_race");

    await expect(service.inspect({ organizationId: "org_race", runId: claim.claim.runId }))
      .resolves.toMatchObject({ canonicalStatus: "interrupted", outcome: "outcome_unknown" });
    await expect(service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_approval_expiry_replacement",
      requestId: "request_claim_approval_expiry_replacement",
      credentialId: "credential_race" }) })).resolves.toEqual({ kind: "empty" });
  });

  it("makes cancellation terminal before any later claim", async () => {
    now = new Date("2026-08-15T10:00:00.000Z");
    const service = coordinator();
    const candidate = await hostedAdmissionFixture({ runId: "run_cancel_before_claim",
      suffix: "cancelbeforeclaim", organizationId: "org_race", runnerId: "runner_race",
      queueClaimDeadline: "2026-08-15T11:00:00.000Z" });
    await service.admit({ runId: "run_cancel_before_claim", admission: candidate.admission,
      policy: candidate.policy });
    await expect(service.cancelRun({ organizationId: "org_race",
      runId: "run_cancel_before_claim", reason: "actor_cancelled" }))
      .resolves.toEqual({ kind: "cancelled" });
    await expect(service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_cancelled", requestId: "request_claim_cancelled",
      credentialId: "credential_race" }) })).resolves.toEqual({ kind: "empty" });
    const terminalInvalidation = { organizationId: "org_race",
      sourceVersionRef: candidate.admission.sourceContextEnvelope.sourceVersionRef,
      contentIds: [candidate.admission.sourceContextEnvelope.contentId],
      reason: "source_content_deleted" as const, commandId: "command_delete_terminal" };
    const replays = await Promise.all([
      service.invalidate(terminalInvalidation), service.invalidate(terminalInvalidation),
    ]);
    expect(replays[0]).toMatchObject({ commandId: "command_delete_terminal" });
    expect(replays[1]).toEqual(replays[0]);
    await expect(service.inspect({ organizationId: "org_race",
      runId: "run_cancel_before_claim" })).resolves.toMatchObject({
        canonicalStatus: "cancelled", terminalReason: "actor_cancelled",
      });
  });

  it("preserves outcome_unknown and reconciliation identity when deletion follows material start", async () => {
    now = new Date("2026-08-15T12:00:00.000Z");
    const service = coordinator();
    const candidate = await hostedAdmissionFixture({ runId: "run_delete_material",
      suffix: "fdeletematerial", organizationId: "org_race", runnerId: "runner_race",
      queueClaimDeadline: "2026-08-15T13:00:00.000Z" });
    await service.admit({ runId: "run_delete_material", admission: candidate.admission,
      policy: candidate.policy });
    const claim = await service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_delete_material",
      requestId: "request_claim_delete_material", credentialId: "credential_race" }) });
    if (claim.kind !== "claimed") throw new Error("claim failed");
    await fixture.pool.query(
      `INSERT INTO cp_material_action_receipt(organization_id, receipt_id, operation_id,
         run_id, runner_id, attempt_id, attempt_number, action_id, receipt_digest,
         outcome, receipt, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'outcome_unknown','{}'::jsonb,$10)`,
      ["org_race", "receipt_delete_material", "operation_delete_material",
        "run_delete_material", "runner_race", claim.claim.attempt.id,
        claim.claim.attempt.number, "action_delete_material", `sha256:${"7".repeat(64)}`, now],
    );
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt SET material_start_state = 'started_or_ambiguous'
       WHERE organization_id = $1 AND run_id = $2 AND attempt_number = $3`,
      ["org_race", "run_delete_material", claim.claim.attempt.number],
    );

    await service.invalidate({ organizationId: "org_race",
      sourceVersionRef: candidate.admission.sourceContextEnvelope.sourceVersionRef,
      contentIds: [candidate.admission.sourceContextEnvelope.contentId],
      reason: "source_content_deleted", commandId: "command_delete_material" });

    const view = await service.inspect({ organizationId: "org_race", runId: "run_delete_material" });
    expect(view).toMatchObject({ canonicalStatus: "interrupted", outcome: "outcome_unknown",
      terminalReason: "source_content_deleted" });
    const row = await fixture.pool.query<{ reconciliation_identity: string }>(
      "SELECT reconciliation_identity FROM cp_hosted_run WHERE run_id = $1",
      ["run_delete_material"],
    );
    expect(row.rows[0]?.reconciliation_identity).toContain("receipt_delete_material");
    await expect(service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_delete_material_replacement",
      requestId: "request_claim_delete_material_replacement",
      credentialId: "credential_race" }) })).resolves.toEqual({ kind: "empty" });
  });
});
