import {
  AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeHostedAdmissionEnvelopeDigestV1,
  computePermissionRequestDigestV1,
  HostedAdmissionEnvelopeV1Schema,
  HostedClaimRequestV1Schema,
  HumanPermissionDecisionRequestV1Schema,
  RunnerPermissionRequestV1Schema,
  type HostedAdmissionEnvelopeV1,
  type PermissionActionDescriptorV1,
} from "@opentag/control-protocol";
import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { createPermissionCoordinator } from "../src/modules/hosted-runs/permissions.js";
import type { RuntimePrincipal } from "../src/modules/runners/index.js";

export const HOSTED_CAPABILITIES = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.readiness.v1",
  "relay.source-content-redeem.v1",
] as const;

export async function hostedGrantIssuerFixture(_client: PoolClient, input: {
  organizationId: string; runId: string; attemptId: string; fenceDigest: string;
  contentIds: string[]; purpose: string; expiresAt: Date;
}) {
  return {
    grantId: `grant_${input.attemptId}`,
    token: `grant_token_${input.attemptId}`,
    keyVersion: "test-v1",
    fenceDigest: input.fenceDigest,
    contentIds: [...new Set(input.contentIds)].sort(),
    purpose: "source_context" as const,
    expiresAt: input.expiresAt.toISOString(),
  };
}

const digest = (character: string) => `sha256:${character.repeat(64)}`;

export async function recordHostedReadiness(input: {
  pool: Pick<Pool, "query">;
  organizationId: string;
  runnerId: string;
  receiptId?: string;
  receiptDigest?: string;
}) {
  await input.pool.query(
    `INSERT INTO cp_runner_readiness(
       organization_id, runner_id, receipt_id, receipt_digest, observed_at,
       expires_at, receipt
     ) VALUES($1, $2, $3, $4, $5, $6, '{}'::jsonb)
     ON CONFLICT (organization_id, receipt_id) DO NOTHING`,
    [
      input.organizationId,
      input.runnerId,
      input.receiptId ?? "readiness_receipt_hosted",
      input.receiptDigest ?? digest("a"),
      "2026-08-15T07:00:00.000Z",
      "2030-08-15T07:00:00.000Z",
    ],
  );
}

export async function hostedAdmissionFixture(input: {
  runId: string;
  suffix: string;
  organizationId?: string;
  runnerId?: string;
  queueClaimDeadline?: string;
  contentId?: string;
  permissionActions?: HostedAdmissionEnvelopeV1["permissionCeiling"]["allowedActionDescriptors"];
  publicationMode?: "proposal_only" | "pull_request";
}) {
  const organizationId = input.organizationId ?? "org_hosted";
  const runnerId = input.runnerId ?? "runner_hosted";
  const observedAt = "2026-08-15T07:00:00.000Z";
  const readinessDigest = digest("a");
  const publicationMode = input.publicationMode ?? "proposal_only";
  const policyPayload = {
    snapshotId: `policy_${input.suffix}`,
    capturedAt: observedAt,
    tenant: { organizationId },
    actor: {
      provider: "github",
      providerUserId: "1001",
      login: "octocat",
      authorizationRef: `grant_${input.suffix}`,
    },
    target: {
      projectTargetId: `target_${input.suffix}`,
      bindingId: `binding_${input.suffix}`,
      providerRepositoryId: "123",
      defaultBranch: "main",
      authorizedPublicationModes: ["proposal_only", "pull_request"] as const,
    },
    runner: { runnerId, readinessReceiptDigest: readinessDigest },
    executor: {
      executorId: "executor_acp",
      capabilityDigest: digest("b"),
    },
    requiredRelayCapabilities: HOSTED_CAPABILITIES,
    admissionRules: {
      profile: "github-pr-exact-head/v1",
      requiredCheckNames: ["test"],
      mergeRequired: false,
      humanApprovalRequiredFor: ["merge"],
    },
  };
  const policySeed = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    receiptId: `policy_receipt_${input.suffix}`,
    organizationId,
    operationId: `operation_admit_${input.suffix}`,
    requiredCapabilities: HOSTED_CAPABILITIES,
    producer: { kind: "cloud" as const, id: "control_plane" },
    identity: {
      namespace: "opentag.control.receipt/admission-policy-snapshot/v1" as const,
      parts: [organizationId, input.runId, policyPayload.snapshotId],
    },
    observedAt,
    payloadDigest: await computeControlPayloadDigestV1(policyPayload),
    receiptDigest: digest("0"),
    receiptKind: "admission_policy_snapshot" as const,
    runId: input.runId,
    payload: policyPayload,
  };
  const { receiptDigest: _ignored, ...policyDigestInput } = policySeed;
  const policy = AdmissionPolicySnapshotReceiptEnvelopeV1Schema.parse({
    ...policySeed,
    receiptDigest: await computeControlReceiptDigestV1(policyDigestInput),
  });
  const admissionSeed = {
    kind: "hosted_admission" as const,
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.hosted-admission.v1"] as const,
    admissionId: `admission_${input.suffix}`,
    operationId: policy.operationId,
    organizationId,
    bindingId: policyPayload.target.bindingId,
    bindingSecretVersion: "secret-v1",
    provider: "github" as const,
    deliveryId: `delivery_${input.suffix}`,
    deliveryPayloadDigest: digest("c"),
    sourceIdentityDigest: `sha256:${createHash("sha256")
      .update(input.suffix, "utf8").digest("hex")}`,
    eventName: "issue_comment" as const,
    action: "created" as const,
    repository: {
      providerRepositoryId: "123",
      owner: "acme",
      repo: "demo",
    },
    sourceThread: {
      kind: "issue" as const,
      providerThreadId: "456",
      number: 7,
    },
    sourceEvent: {
      providerEventId: `${700 + Number.parseInt(input.suffix.replace(/\D/gu, "") || "1", 10)}`,
      kind: "issue_comment" as const,
    },
    verifiedActor: {
      providerUserId: "1001",
      login: "octocat",
      authorization: {
        decision: "allowed" as const,
        grantRef: policyPayload.actor.authorizationRef,
        grantVersion: 1,
        grantDigest: digest("d"),
      },
    },
    projectTarget: {
      projectTargetId: policyPayload.target.projectTargetId,
      version: 1,
      digest: digest("e"),
    },
    runnerId,
    sourceContextEnvelope: {
      contentId: input.contentId ?? `content_${input.suffix}`,
      sourceVersionRef: `source_version_${input.suffix}`,
      aadDigest: "a".repeat(64),
      keyVersion: "relay-v1",
      envelopeDigest: digest("f"),
      payloadDigest: digest("f"),
    },
    queueClaimDeadline: input.queueClaimDeadline ?? "2026-08-29T00:00:00.000Z",
    permissionCeiling: {
      allowedActionDescriptors: input.permissionActions ?? ["workspace.write"],
      digest: await computeControlPayloadDigestV1(
        input.permissionActions ?? ["workspace.write"]),
    },
    publicationPolicy: {
      mode: publicationMode,
      digest: digest("2"),
    },
    completionContract: {
      mode: publicationMode === "proposal_only" ? "proposal_ready" as const
        : "pull_request_ready" as const,
      digest: digest("3"),
    },
    admissionPolicySnapshot: {
      snapshotId: policyPayload.snapshotId,
      digest: policy.receiptDigest,
    },
    receivedAt: observedAt,
    envelopeDigest: digest("0"),
  };
  const admission = HostedAdmissionEnvelopeV1Schema.parse({
    ...admissionSeed,
    envelopeDigest: await computeHostedAdmissionEnvelopeDigestV1(admissionSeed),
  });
  return { admission, policy, readinessDigest };
}

export function hostedClaimRequest(input: {
  operationId: string;
  requestId: string;
  credentialId?: string;
  readinessDigest?: string;
}) {
  return HostedClaimRequestV1Schema.parse({
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: HOSTED_CAPABILITIES,
    requestId: input.requestId,
    operationId: input.operationId,
    expectedAuthority: {
      credentialId: input.credentialId ?? "credential_hosted",
      registrationGeneration: 1,
      credentialGeneration: 1,
      runnerReadinessReceiptId: "readiness_receipt_hosted",
      runnerReadinessReceiptDigest: input.readinessDigest ?? digest("a"),
    },
  });
}

export async function authorizeHostedMaterialActionFixture(input: {
  pool: Pool;
  clock: { now(): Date };
  principal: RuntimePrincipal;
  runId: string;
  attempt: {
    id: string;
    number: number;
    epoch: number;
    fencingToken: string;
    fencingTokenDigest: string;
  };
  actionId: string;
  actionDescriptor: PermissionActionDescriptorV1;
  targetFingerprint: string;
  policySnapshotRef: string;
  policySnapshotDigest: string;
  workspaceAttestationDigest?: string;
  suffix: string;
}) {
  const actionDescriptorDigest = await computeControlPayloadDigestV1(
    input.actionDescriptor,
  );
  const permissionRequestId = `permission_${input.suffix}`;
  const digestInput = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.permission.v1"] as const,
    organizationId: input.principal.organizationId,
    runnerId: input.principal.runnerId,
    runId: input.runId,
    attempt: {
      attemptId: input.attempt.id,
      attemptNumber: input.attempt.number,
      epoch: input.attempt.epoch,
      fencingTokenDigest: input.attempt.fencingTokenDigest,
    },
    permissionRequestId,
    actionId: input.actionId,
    actionDescriptor: input.actionDescriptor,
    actionDescriptorDigest,
    riskTier: "high" as const,
    targetFingerprint: input.targetFingerprint,
    policySnapshotRef: input.policySnapshotRef,
    policySnapshotDigest: input.policySnapshotDigest,
    ...(input.workspaceAttestationDigest
      ? { workspaceAttestationDigest: input.workspaceAttestationDigest } : {}),
    requestedAt: input.clock.now().toISOString(),
  };
  const permissionRequestDigest = await computePermissionRequestDigestV1(digestInput);
  const request = RunnerPermissionRequestV1Schema.parse({
    ...digestInput,
    requestId: `request_${input.suffix}`,
    operationId: `operation_permission_${input.suffix}`,
    attempt: { ...digestInput.attempt, fencingToken: input.attempt.fencingToken },
    permissionRequestDigest,
  });
  const permissions = createPermissionCoordinator({
    pool: input.pool,
    clock: input.clock,
    idFactory: (kind) => `${kind}_${input.suffix}`,
  });
  const waiting = await permissions.request({ principal: input.principal, request });
  if (waiting.kind !== "waiting") {
    throw new Error(`permission request failed: ${waiting.kind}`);
  }
  const decision = HumanPermissionDecisionRequestV1Schema.parse({
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.permission.v1"],
    requestId: `decision_request_${input.suffix}`,
    operationId: `operation_decision_${input.suffix}`,
    organizationId: input.principal.organizationId,
    runId: input.runId,
    attempt: digestInput.attempt,
    actionId: input.actionId,
    permissionRequestId,
    permissionRequestDigest,
    policySnapshotDigest: input.policySnapshotDigest,
    decisionId: `decision_${input.suffix}`,
    decision: "allow_once",
    decidedAt: input.clock.now().toISOString(),
  });
  const approved = await permissions.resolve({
    principal: { organizationId: input.principal.organizationId,
      actorId: `operator_${input.suffix}` },
    runnerId: input.principal.runnerId,
    decision,
  });
  if (approved.kind !== "resolved" || approved.receipt.payload.state !== "authorized") {
    throw new Error(`permission resolution failed: ${approved.kind}`);
  }
  return {
    actionDescriptorDigest,
    permissionRequestId,
    permissionRequestDigest,
    receipt: approved.receipt,
    authority: {
      kind: "permission_resolution" as const,
      permissionRequestId,
      permissionRequestDigest,
      resolutionReceiptId: approved.receipt.receiptId,
      resolutionReceiptDigest: approved.receipt.receiptDigest,
      ...(input.workspaceAttestationDigest
        ? { workspaceAttestationDigest: input.workspaceAttestationDigest } : {}),
    },
  };
}
