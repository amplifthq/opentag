import {
  computeControlPayloadDigestV1,
  computeMaterialActionAdmissionPreauthorizationDigestV1,
  computeMaterialActionFencingTokenDigestV1,
  computeMaterialActionPayloadDigestV1,
  computeMaterialActionReceiptDigestV1,
  MaterialActionReceiptEnvelopeV1Schema,
  RunnerMaterialActionReconcileRequestV1Schema,
} from "@opentag/control-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createMaterialActionCoordinator } from "../src/modules/hosted-runs/material-actions.js";
import { classifyAttemptMaterialActionTruth } from "../src/modules/hosted-runs/material-actions.js";
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

describe.skipIf(!TEST_DATABASE_URL)("material action PostgreSQL module", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let principal: RuntimePrincipal;
  const now = new Date("2026-08-15T15:00:00.000Z");

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    const runners = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => now },
      idFactory: () => "credential_material",
      tokenFactory: () => "runtime_material_secret",
    });
    const registration = await runners.register({
      organizationId: "org_material",
      organizationName: "Material actions",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_register_material",
        operationId: "operation_register_material",
        runnerId: "runner_material",
        capabilities: [
          "relay.claim-fence.v1",
          "relay.hosted-admission.v1",
          "relay.hosted-claim.v1",
          "relay.lifecycle.v1",
          "relay.material-receipt.v1",
          "relay.readiness.v1",
        ],
      },
    });
    if (registration.kind !== "created") throw new Error("registration failed");
    const authenticated = await runners.authenticate("runtime_material_secret");
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

  it("fails closed without a durable Attempt/fence-bound negative-start proof", async () => {
    const truth = await classifyAttemptMaterialActionTruth(fixture.pool, {
      organizationId: "org_material",
      runId: "run_without_material_receipt",
      attemptId: "attempt_without_material_receipt",
    });
    expect(truth).toMatchObject({ kind: "started_or_ambiguous" });
  });

  it("keeps an append-only receipt chain and reconciles the current evidence", async () => {
    const hosted = createHostedRunCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      leaseDurationMs: 60_000,
      idFactory: () => "attempt_material",
      tokenFactory: () => "fence_material",
      issueSourceContentGrantInTransaction: hostedGrantIssuerFixture,
    });
    const admission = await hostedAdmissionFixture({
      runId: "run_material",
      suffix: "94",
      organizationId: "org_material",
      runnerId: "runner_material",
      permissionActions: ["github.pull_request.merge"],
      publicationMode: "pull_request",
    });
    await hosted.admit({
      runId: "run_material",
      admission: admission.admission,
      policy: admission.policy,
    });
    const claimOutcome = await hosted.claim({
      principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_material",
        requestId: "request_claim_material",
        credentialId: "credential_material",
      }),
    });
    if (claimOutcome.kind !== "claimed") throw new Error("claim failed");
    const claim = claimOutcome.claim;
    const coordinator = createMaterialActionCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
    });
    const actionDescriptorDigest = await computeControlPayloadDigestV1(
      "github.pull_request.merge",
    );
    const targetFingerprint = `sha256:${"4".repeat(64)}`;
    const preauthorizationDigest = await computeMaterialActionAdmissionPreauthorizationDigestV1({
      organizationId: principal.organizationId, runId: claim.runId,
      admissionId: admission.admission.admissionId,
      attempt: { attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch, fencingTokenDigest: claim.attempt.fencingTokenDigest },
      actionId: "action_material", actionDescriptor: "github.pull_request.merge",
      actionDescriptorDigest, targetFingerprint,
      policySnapshotRef: admission.policy.payload.snapshotId,
      policySnapshotDigest: admission.policy.receiptDigest,
      permissionCeilingDigest: admission.admission.permissionCeiling.digest,
      publicationPolicyDigest: admission.admission.publicationPolicy.digest,
    });
    await expect(coordinator.begin({ principal,
      fencingToken: claim.attempt.fencingToken, runId: claim.runId,
      attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
      actionId: "action_material",
      actionDescriptor: "github.pull_request.merge",
      actionDescriptorDigest, targetFingerprint,
      policySnapshotRef: admission.policy.payload.snapshotId,
      policySnapshotDigest: admission.policy.receiptDigest,
      authority: { kind: "admission_preauthorization",
        admissionId: admission.admission.admissionId, preauthorizationDigest },
      idempotencyKey: "material_action_material" }))
      .resolves.toEqual({ kind: "begun" });
    const receiptFor = async (input: {
      receiptId: string;
      operationId: string;
      outcome: "succeeded" | "outcome_unknown";
      predecessorReceiptDigests?: string[];
    }) => {
      const payload = {
        actionId: "action_material",
        actionDescriptor: "github.pull_request.merge" as const,
        actionDescriptorDigest: await computeControlPayloadDigestV1(
          "github.pull_request.merge"),
        idempotencyKey: "material_action_material",
        provider: "github",
        connectionRef: "connection_material",
        targetFingerprint,
        operationId: input.operationId,
        requestDigest: `sha256:${"5".repeat(64)}`,
        actionPayloadDigest: `sha256:${"6".repeat(64)}`,
        outcome: input.outcome,
        ...(input.outcome === "succeeded"
          ? {
              externalId: "pr_42",
              externalUri: "https://github.com/example/repo/pull/42",
              reasonCode: "provider_accepted" as const,
            }
          : {
              reasonCode: "provider_timeout" as const,
              nextAction: "reconcile_provider",
              owner: "runner_material",
            }),
        observedAt: now.toISOString(),
      };
      const seed = {
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        receiptId: input.receiptId,
        organizationId: "org_material",
        operationId: input.operationId,
        requiredCapabilities: ["relay.material-receipt.v1"] as const,
        producer: { kind: "local_opentag" as const, id: "runner_material" },
        identity: {
          namespace: "opentag.control.receipt/material-action/v1" as const,
          parts: [
            "org_material",
            "run_material",
            claim.attempt.id,
            "action_material",
            input.receiptId,
          ],
        },
        ...(input.predecessorReceiptDigests
          ? { predecessorReceiptDigests: input.predecessorReceiptDigests }
          : {}),
        observedAt: now.toISOString(),
        payloadDigest: await computeMaterialActionPayloadDigestV1(payload),
        receiptDigest: `sha256:${"0".repeat(64)}`,
        receiptKind: "material_action" as const,
        runId: "run_material",
        attempt: {
          attemptId: claim.attempt.id,
          attemptNumber: claim.attempt.number,
          epoch: claim.attempt.epoch,
          fencingTokenDigest: claim.attempt.fencingTokenDigest,
        },
        payload,
      };
      const { receiptDigest: _ignored, ...digestInput } = seed;
      return MaterialActionReceiptEnvelopeV1Schema.parse({
        ...seed,
        receiptDigest: await computeMaterialActionReceiptDigestV1(digestInput),
      });
    };
    const unknown = await receiptFor({
      receiptId: "receipt_material_unknown",
      operationId: "operation_material_unknown",
      outcome: "outcome_unknown",
    });
    await expect(coordinator.record({
      principal,
      fencingToken: claim.attempt.fencingToken,
      receipt: unknown,
    })).resolves.toMatchObject({ kind: "recorded" });
    await expect(classifyAttemptMaterialActionTruth(fixture.pool, {
      organizationId: principal.organizationId, runId: claim.runId,
      attemptId: claim.attempt.id })).resolves.toMatchObject({ kind: "started_or_ambiguous" });
    await expect(coordinator.record({
      principal,
      fencingToken: claim.attempt.fencingToken,
      receipt: unknown,
    })).resolves.toMatchObject({ kind: "replayed" });
    const reconcile = RunnerMaterialActionReconcileRequestV1Schema.parse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.material-receipt.v1"],
      requestId: "request_reconcile_material",
      organizationId: "org_material",
      runnerId: "runner_material",
      runId: "run_material",
      actionId: "action_material",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      expectedCurrentReceiptId: unknown.receiptId,
      expectedCurrentReceiptDigest: unknown.receiptDigest,
    });
    await expect(coordinator.reconcile({ principal, request: reconcile }))
      .resolves.toMatchObject({ kind: "outcome_unknown" });

    const terminal = await receiptFor({
      receiptId: "receipt_material_terminal",
      operationId: "operation_material_terminal",
      outcome: "succeeded",
      predecessorReceiptDigests: [unknown.receiptDigest],
    });
    await expect(coordinator.record({
      principal,
      fencingToken: claim.attempt.fencingToken,
      receipt: terminal,
    })).resolves.toMatchObject({ kind: "recorded" });
    await expect(coordinator.reconcile({
      principal,
      request: { ...reconcile, requestId: "request_reconcile_terminal",
        expectedCurrentReceiptId: terminal.receiptId,
        expectedCurrentReceiptDigest: terminal.receiptDigest },
    })).resolves.toMatchObject({
      kind: "resolved",
      receipt: { payload: { outcome: "succeeded" } },
    });
    const rows = await fixture.pool.query<{ receipt_id: string }>(
      `SELECT receipt_id FROM cp_material_action_receipt
       WHERE organization_id = $1 ORDER BY created_at, receipt_id`,
      ["org_material"],
    );
    expect(rows.rows.map((row) => row.receipt_id)).toEqual([
      "receipt_material_terminal",
      "receipt_material_unknown",
    ]);

    await fixture.pool.query(
      `UPDATE cp_hosted_attempt SET lease_expires_at = $3
       WHERE organization_id = $1 AND run_id = $2`,
      ["org_material", "run_material", new Date(now.getTime() - 1)],
    );
    await expect(hosted.reconcileExpiredAttempts("org_material"))
      .resolves.toEqual({ expired: 1 });
    await expect(hosted.inspect({ organizationId: "org_material", runId: "run_material" }))
      .resolves.toMatchObject({ canonicalStatus: "interrupted", outcome: "outcome_unknown",
        terminalReason: "attempt_lease_expired_after_material_start" });
    await expect(hosted.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_material_replacement",
      requestId: "request_claim_material_replacement",
      credentialId: "credential_material",
    }) })).resolves.toEqual({ kind: "empty" });
  });

  it("requires frozen server authority and permits distinct authorized actions per Attempt", async () => {
    let attemptIdentity = 0;
    const hosted = createHostedRunCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      leaseDurationMs: 60_000,
      idFactory: () => `attempt_material_multi_${++attemptIdentity}`,
      tokenFactory: ({ attemptId }) => `fence_${attemptId}`,
      issueSourceContentGrantInTransaction: hostedGrantIssuerFixture,
    });
    const admission = await hostedAdmissionFixture({
      runId: "run_material_multi",
      suffix: "material_multi",
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      permissionActions: ["git.push", "github.pull_request.create"],
      publicationMode: "pull_request",
    });
    await hosted.admit({ runId: "run_material_multi", admission: admission.admission,
      policy: admission.policy });
    const claimOutcome = await hosted.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_material_multi",
      requestId: "request_claim_material_multi",
      credentialId: principal.credentialId,
    }) });
    if (claimOutcome.kind !== "claimed") throw new Error("claim failed");
    const materials = createMaterialActionCoordinator({ pool: fixture.pool,
      clock: { now: () => now } });
    const pushDescriptorDigest = await computeControlPayloadDigestV1("git.push");
    const prDescriptorDigest = await computeControlPayloadDigestV1(
      "github.pull_request.create",
    );
    const authorityFor = async (actionId: string,
      actionDescriptor: "workspace.write" | "git.push" | "github.pull_request.create",
      actionDescriptorDigest: string, targetFingerprint: string) => ({
      kind: "admission_preauthorization" as const,
      admissionId: admission.admission.admissionId,
      preauthorizationDigest: await computeMaterialActionAdmissionPreauthorizationDigestV1({
        organizationId: principal.organizationId, runId: claimOutcome.claim.runId,
        admissionId: admission.admission.admissionId,
        attempt: { attemptId: claimOutcome.claim.attempt.id,
          attemptNumber: claimOutcome.claim.attempt.number,
          epoch: claimOutcome.claim.attempt.epoch,
          fencingTokenDigest: claimOutcome.claim.attempt.fencingTokenDigest },
        actionId, actionDescriptor, actionDescriptorDigest, targetFingerprint,
        policySnapshotRef: admission.policy.payload.snapshotId,
        policySnapshotDigest: admission.policy.receiptDigest,
        permissionCeilingDigest: admission.admission.permissionCeiling.digest,
        publicationPolicyDigest: admission.admission.publicationPolicy.digest,
      }),
    });
    const outsideTarget = `sha256:${"5".repeat(64)}`;

    await expect(materials.begin({
      principal,
      fencingToken: claimOutcome.claim.attempt.fencingToken,
      runId: claimOutcome.claim.runId,
      attemptId: claimOutcome.claim.attempt.id,
      attemptNumber: claimOutcome.claim.attempt.number,
      actionId: "action_outside_ceiling",
      actionDescriptor: "workspace.write",
      actionDescriptorDigest: await computeControlPayloadDigestV1("workspace.write"),
      targetFingerprint: outsideTarget,
      policySnapshotRef: admission.policy.payload.snapshotId,
      policySnapshotDigest: admission.policy.receiptDigest,
      authority: await authorityFor("action_outside_ceiling", "workspace.write",
        await computeControlPayloadDigestV1("workspace.write"), outsideTarget),
      idempotencyKey: "material_begin_outside_ceiling",
    })).resolves.toEqual({ kind: "conflict" });

    const pushTarget = `sha256:${"6".repeat(64)}`;
    const push = {
      principal,
      fencingToken: claimOutcome.claim.attempt.fencingToken,
      runId: claimOutcome.claim.runId,
      attemptId: claimOutcome.claim.attempt.id,
      attemptNumber: claimOutcome.claim.attempt.number,
      actionId: "action_push",
      actionDescriptor: "git.push",
      actionDescriptorDigest: pushDescriptorDigest,
      targetFingerprint: pushTarget,
      policySnapshotRef: admission.policy.payload.snapshotId,
      policySnapshotDigest: admission.policy.receiptDigest,
      authority: await authorityFor("action_push", "git.push",
        pushDescriptorDigest, pushTarget),
      idempotencyKey: "material_begin_push",
    } as const;
    await expect(materials.begin({ ...push,
      policySnapshotDigest: `sha256:${"9".repeat(64)}` }))
      .resolves.toEqual({ kind: "conflict" });
    await expect(materials.begin({ ...push,
      authority: { ...push.authority,
        preauthorizationDigest: `sha256:${"8".repeat(64)}` } }))
      .resolves.toEqual({ kind: "conflict" });
    const pullRequestTarget = `sha256:${"7".repeat(64)}`;
    const pullRequest = {
      ...push,
      actionId: "action_pull_request",
      actionDescriptor: "github.pull_request.create",
      actionDescriptorDigest: prDescriptorDigest,
      targetFingerprint: pullRequestTarget,
      authority: await authorityFor("action_pull_request", "github.pull_request.create",
        prDescriptorDigest, pullRequestTarget),
      idempotencyKey: "material_begin_pull_request",
    } as const;
    await expect(materials.begin(push)).resolves.toEqual({ kind: "begun" });
    await expect(materials.begin(push)).resolves.toEqual({ kind: "replayed" });
    await expect(materials.begin(pullRequest)).resolves.toEqual({ kind: "begun" });
    expect((await fixture.pool.query<{ action_descriptor: string }>(
      `SELECT action_descriptor FROM cp_material_action_begin_intent
       WHERE organization_id = $1 AND run_id = $2 ORDER BY action_descriptor`,
      [principal.organizationId, claimOutcome.claim.runId],
    )).rows).toEqual([
      { action_descriptor: "github.pull_request.create" },
      { action_descriptor: "git.push" },
    ]);

    const proposalAdmission = await hostedAdmissionFixture({
      runId: "run_material_proposal_only",
      suffix: "material_proposal_only",
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      permissionActions: ["git.push"],
      publicationMode: "proposal_only",
    });
    await hosted.admit({ runId: "run_material_proposal_only",
      admission: proposalAdmission.admission, policy: proposalAdmission.policy });
    const proposalClaim = await hosted.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_claim_material_proposal_only",
      requestId: "request_claim_material_proposal_only",
      credentialId: principal.credentialId,
    }) });
    if (proposalClaim.kind !== "claimed") throw new Error("proposal claim failed");
    const proposalTarget = `sha256:${"a".repeat(64)}`;
    const proposalActionDigest = await computeControlPayloadDigestV1("git.push");
    const proposalPreauthorization =
      await computeMaterialActionAdmissionPreauthorizationDigestV1({
        organizationId: principal.organizationId, runId: proposalClaim.claim.runId,
        admissionId: proposalAdmission.admission.admissionId,
        attempt: { attemptId: proposalClaim.claim.attempt.id,
          attemptNumber: proposalClaim.claim.attempt.number,
          epoch: proposalClaim.claim.attempt.epoch,
          fencingTokenDigest: proposalClaim.claim.attempt.fencingTokenDigest },
        actionId: "action_proposal_push", actionDescriptor: "git.push",
        actionDescriptorDigest: proposalActionDigest,
        targetFingerprint: proposalTarget,
        policySnapshotRef: proposalAdmission.policy.payload.snapshotId,
        policySnapshotDigest: proposalAdmission.policy.receiptDigest,
        permissionCeilingDigest: proposalAdmission.admission.permissionCeiling.digest,
        publicationPolicyDigest: proposalAdmission.admission.publicationPolicy.digest,
      });
    await expect(materials.begin({ principal,
      fencingToken: proposalClaim.claim.attempt.fencingToken,
      runId: proposalClaim.claim.runId, attemptId: proposalClaim.claim.attempt.id,
      attemptNumber: proposalClaim.claim.attempt.number, actionId: "action_proposal_push",
      actionDescriptor: "git.push", actionDescriptorDigest: proposalActionDigest,
      targetFingerprint: proposalTarget,
      policySnapshotRef: proposalAdmission.policy.payload.snapshotId,
      policySnapshotDigest: proposalAdmission.policy.receiptDigest,
      authority: { kind: "admission_preauthorization",
        admissionId: proposalAdmission.admission.admissionId,
        preauthorizationDigest: proposalPreauthorization },
      idempotencyKey: "material_begin_proposal_push",
    })).resolves.toEqual({ kind: "conflict" });
  });
});
