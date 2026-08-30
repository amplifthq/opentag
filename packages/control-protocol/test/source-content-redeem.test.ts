import { describe, expect, it } from "vitest";
import {
  AttemptInterruptionEvidenceV1Schema,
  AttemptWorkspaceAttestationV1Schema,
  HostedCompleteRequestV1Schema,
  HostedLifecycleReceiptEnvelopeV1Schema,
  HostedRunningRequestV1Schema,
  HostedSourceContentRedeemRequestV1Schema,
  HostedSourceContentRedeemResponseV1Schema,
  RunnerMaterialActionBeginV1Schema,
  RunnerPermissionRequestV1Schema,
  verifyHostedSourceContentRedeemPayloadV1,
} from "../src/index.js";

const digest = (value: string) => `sha256:${value.repeat(64)}`;

describe("hosted source content redemption", () => {
  const request = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.source-content-redeem.v1"] as const,
    requestId: "request_redeem_1",
    operationId: "operation_redeem_1",
    organizationId: "org_1",
    runnerId: "runner_1",
    runId: "run_1",
    expectedAuthority: {
      credentialId: "credential_1",
      registrationGeneration: 2,
      credentialGeneration: 3,
    },
    attempt: {
      attemptId: "attempt_1",
      attemptNumber: 4,
      epoch: 4,
      fencingTokenDigest: digest("1"),
      leaseExpiresAt: "2026-08-30T01:00:00.000Z",
    },
    grant: {
      grantId: "grant_1",
      token: "one_time_secret",
      keyVersion: "relay-v1",
      fenceDigest: digest("1"),
      contentIds: ["content_1"],
      purpose: "source_context" as const,
      expiresAt: "2026-08-30T01:00:00.000Z",
    },
    admissionEnvelopeDigest: digest("2"),
    contentEnvelope: {
      contentId: "content_1",
      sourceVersionRef: "source_version_1",
      aadDigest: "a".repeat(64),
      keyVersion: "relay-v1",
      envelopeDigest: digest("3"),
      payloadDigest: "sha256:6369dcd08c8f2c8093877f811554aa9948cf1ac940699e6c807d913bf23818e8",
    },
  };

  it("binds redemption to the exact Attempt, grant, content, and Admission", () => {
    expect(HostedSourceContentRedeemRequestV1Schema.parse(request)).toEqual(request);
    expect(() => HostedSourceContentRedeemRequestV1Schema.parse({
      ...request,
      grant: { ...request.grant, fenceDigest: digest("4") },
    })).toThrow();
    expect(() => HostedSourceContentRedeemRequestV1Schema.parse({
      ...request,
      grant: { ...request.grant, contentIds: ["content_other"] },
    })).toThrow();
  });

  it("returns plaintext only inside an exact immutable redemption envelope", async () => {
    const response = {
      kind: "hosted_source_content_redeemed" as const,
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requestId: request.requestId,
      operationId: request.operationId,
      organizationId: request.organizationId,
      runnerId: request.runnerId,
      runId: request.runId,
      attempt: request.attempt,
      admissionEnvelopeDigest: request.admissionEnvelopeDigest,
      contentEnvelope: request.contentEnvelope,
      content: { contentId: "content_1", payload: { text: "private source" } },
      payloadDigest: request.contentEnvelope.payloadDigest,
      redeemedAt: "2026-08-30T00:00:00.000Z",
    };
    expect(HostedSourceContentRedeemResponseV1Schema.parse(response)).toEqual(response);
    await expect(verifyHostedSourceContentRedeemPayloadV1(response)).resolves.toBe(true);
    await expect(verifyHostedSourceContentRedeemPayloadV1({
      ...response,
      content: { contentId: "content_1", payload: { text: "tampered" } },
    })).resolves.toBe(false);
  });

  it("binds reconnect and interruption evidence without disclosing a workspace path", () => {
    const attestation = { workspaceId: "workspace_attempt_4",
      workspacePathDigest: digest("4"), repositoryPathDigest: digest("5"),
      worktreeIdentityDigest: digest("6"), baseRevision: "a".repeat(40),
      currentRevision: "b".repeat(40), currentTree: "c".repeat(40),
      workspaceStateDigest: digest("7"), attemptId: "attempt_4", attemptNumber: 4,
      fencingTokenDigest: digest("1"), credentialId: "credential_1",
      leaseExpiresAt: "2026-08-30T01:00:00.000Z" };
    expect(AttemptWorkspaceAttestationV1Schema.parse(attestation)).toEqual(attestation);
    const interruption = { state: "interrupted_evidence" as const, runId: "run_1",
      attemptId: "attempt_4", attemptNumber: 4, workspaceId: attestation.workspaceId,
      workspacePathDigest: attestation.workspacePathDigest,
      fencingTokenDigest: attestation.fencingTokenDigest,
      reason: "lease_expired" as const, observedAt: "2026-08-30T01:00:00.000Z",
      processStop: "observed" as const, materialOutcome: "outcome_unknown" as const };
    expect(AttemptInterruptionEvidenceV1Schema.parse(interruption)).toEqual(interruption);
    expect(JSON.stringify({ attestation, interruption })).not.toContain("/Users/");
  });

  it("carries exact workspace attestation and interruption evidence through lifecycle requests and receipts", () => {
    const attestation = { workspaceId: "workspace_attempt_4",
      workspacePathDigest: digest("4"), repositoryPathDigest: digest("5"),
      worktreeIdentityDigest: digest("6"), baseRevision: "a".repeat(40),
      currentRevision: "b".repeat(40), currentTree: "c".repeat(40),
      workspaceStateDigest: digest("7"), attemptId: "attempt_4", attemptNumber: 4,
      fencingTokenDigest: digest("1"), credentialId: "credential_1",
      leaseExpiresAt: "2026-08-30T01:00:00.000Z" };
    const interruption = { state: "interrupted_evidence" as const, runId: "run_1",
      attemptId: "attempt_4", attemptNumber: 4, workspaceId: attestation.workspaceId,
      workspacePathDigest: attestation.workspacePathDigest,
      fencingTokenDigest: attestation.fencingTokenDigest, reason: "cancelled" as const,
      observedAt: "2026-08-30T00:30:00.000Z", processStop: "observed" as const,
      materialOutcome: "outcome_unknown" as const };
    const base = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.lifecycle.v1"] as const,
      requestId: `req_${"1".repeat(64)}`, operationId: `op_${"2".repeat(64)}`,
      attempt: { attemptId: "attempt_4", attemptNumber: 4, epoch: 4,
        fencingToken: "fence_4", fencingTokenDigest: digest("1") },
      requestDigest: digest("8"), occurredAt: "2026-08-30T00:30:00.000Z" };
    expect(HostedRunningRequestV1Schema.parse({ ...base, executorId: "executor_1",
      executorCapabilityDigest: digest("9"), workspaceAttestation: attestation }))
      .toMatchObject({ workspaceAttestation: attestation });
    expect(HostedCompleteRequestV1Schema.parse({ ...base, conclusion: "interrupted",
      reasonCode: "executor_interrupted", resultDigest: digest("a"), artifactDigests: [],
      evidenceDigests: [], workspaceAttestation: attestation,
      interruptionEvidence: interruption })).toMatchObject({ interruptionEvidence: interruption });
    const receipt = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      receiptKind: "attempt_lifecycle" as const, receiptId: `lifecycle_${"3".repeat(64)}`,
      organizationId: "org_1", requestId: base.requestId, operationId: base.operationId,
      requestDigest: base.requestDigest, requiredCapabilities: base.requiredCapabilities,
      producer: { kind: "runner" as const, id: "runner_1", credentialId: "credential_1" },
      identity: { namespace: "opentag.control.receipt/attempt-lifecycle/v1" as const,
        parts: ["org_1", "run_1", "attempt_4", "executor_result", base.operationId] as const },
      observedAt: base.occurredAt, payloadDigest: digest("b"), receiptDigest: digest("c"),
      runId: "run_1", attempt: { attemptId: "attempt_4", attemptNumber: 4, epoch: 4,
        fencingTokenDigest: digest("1") }, payload: { operation: "executor_result" as const,
        occurredAt: base.occurredAt, conclusion: "interrupted" as const,
        reasonCode: "executor_interrupted" as const, resultDigest: digest("a"),
        artifactDigests: [], evidenceDigests: [], workspaceAttestation: attestation,
        interruptionEvidence: interruption } };
    expect(HostedLifecycleReceiptEnvelopeV1Schema.parse(receipt).payload)
      .toMatchObject({ workspaceAttestation: attestation, interruptionEvidence: interruption });
  });

  it("binds permission and material-begin authority to the accepted workspace attestation digest", () => {
    const workspaceAttestationDigest = digest("d");
    const permission = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.permission.v1"] as const, requestId: "request_permission",
      operationId: "operation_permission", organizationId: "org_1", runnerId: "runner_1",
      runId: "run_1", attempt: { attemptId: "attempt_1", attemptNumber: 1, epoch: 1,
        fencingToken: "fence_1", fencingTokenDigest: digest("1") },
      permissionRequestId: "permission_1", actionId: "action_1",
      actionDescriptor: "workspace.write" as const, actionDescriptorDigest: digest("2"),
      riskTier: "high" as const, targetFingerprint: digest("3"),
      policySnapshotRef: "policy_1", policySnapshotDigest: digest("4"),
      workspaceAttestationDigest, permissionRequestDigest: digest("5"),
      requestedAt: "2026-08-30T00:00:00.000Z" };
    expect(RunnerPermissionRequestV1Schema.parse(permission).workspaceAttestationDigest)
      .toBe(workspaceAttestationDigest);
    const material = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.material-receipt.v1"] as const,
      requestId: "material_1", operationId: "material_1", organizationId: "org_1",
      runnerId: "runner_1", runId: "run_1", attempt: permission.attempt,
      actionId: "action_1", actionDescriptor: "workspace.write" as const,
      actionDescriptorDigest: digest("2"), targetFingerprint: digest("3"),
      policySnapshotRef: "policy_1", policySnapshotDigest: digest("4"),
      workspaceAttestationDigest,
      authority: { kind: "permission_resolution" as const, permissionRequestId: "permission_1",
        permissionRequestDigest: digest("5"), resolutionReceiptId: "receipt_1",
        resolutionReceiptDigest: digest("6"), workspaceAttestationDigest },
      idempotencyKey: "material_1", begunAt: "2026-08-30T00:00:00.000Z" };
    expect(RunnerMaterialActionBeginV1Schema.parse(material).workspaceAttestationDigest)
      .toBe(workspaceAttestationDigest);
  });
});
