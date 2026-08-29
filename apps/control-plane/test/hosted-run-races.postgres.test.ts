import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createRunnerDirectory, type RuntimePrincipal } from "../src/modules/runners/index.js";
import { HOSTED_CAPABILITIES, hostedAdmissionFixture, hostedClaimRequest,
  recordHostedReadiness } from "./control-fixtures.js";
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
    tokenFactory: (context) => `fence_${context.attemptId}` });

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
