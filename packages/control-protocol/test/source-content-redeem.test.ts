import { describe, expect, it } from "vitest";
import {
  AttemptInterruptionEvidenceV1Schema,
  AttemptWorkspaceAttestationV1Schema,
  HostedSourceContentRedeemRequestV1Schema,
  HostedSourceContentRedeemResponseV1Schema,
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

  it("returns plaintext only inside an exact immutable redemption envelope", () => {
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
      redeemedAt: "2026-08-30T00:00:00.000Z",
    };
    expect(HostedSourceContentRedeemResponseV1Schema.parse(response)).toEqual(response);
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
});
