import { createHmac } from "node:crypto";
import {
  HostedRunningRequestV1Schema,
  RunnerReadinessReceiptEnvelopeV1Schema,
  buildHostedLifecycleRequestV1,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeGitHubProjectTargetBindingDigestV1,
} from "../../packages/control-protocol/src/index.js";
import { createOpenTagClient } from "../../packages/client/src/index.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
};

const baseUrl = process.env.OPENTAG_SMOKE_URL
  ?? `http://127.0.0.1:${process.env.OPENTAG_PORT ?? "3000"}`;
const organizationId = required("OPENTAG_BOOTSTRAP_ORGANIZATION_ID");
const stamp = `${Date.now()}`;
const runnerId = process.env.OPENTAG_SMOKE_RUNNER_ID ?? `runner_smoke_${stamp}`;
const projectTargetId = required("OPENTAG_SMOKE_SLACK_PROJECT_TARGET_ID");
const capabilities = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.material-receipt.v1",
  "relay.permission.v1",
  "relay.readiness.v1",
  "relay.repository-binding.v1",
  "relay.source-content-redeem.v1",
] as const;
const hostedCapabilities = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.readiness.v1",
  "relay.source-content-redeem.v1",
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function json<T>(response: Response, expectedStatus: number): Promise<T> {
  if (response.status !== expectedStatus) {
    throw new Error(`unexpected_http_${response.status}:${await response.text()}`);
  }
  return await response.json() as T;
}

async function main(): Promise<void> {
  const discovery = await json<{
    capabilities: string[];
  }>(await fetch(`${baseUrl}/v1/relay/capabilities`), 200);
  for (const capability of [
    "relay.credential-reprovision.v1",
    "relay.material-receipt.v1",
    "relay.permission.v1",
    "relay.repository-binding.v1",
  ]) {
    assert(discovery.capabilities.includes(capability), `missing_${capability}`);
  }

  const bootstrapClient = createOpenTagClient({
    controlPlaneUrl: baseUrl,
    controlCredential: {
      kind: "bootstrap_pairing",
      token: required("OPENTAG_BOOTSTRAP_PAIRING_TOKEN"),
    },
  });
  const registered = await bootstrapClient.registerRunnerControlV1({
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.registration.v1"],
    requestId: `request_register_${stamp}`,
    operationId: `operation_register_${stamp}`,
    runnerId,
    capabilities: [...capabilities],
  });
  assert(!registered.replayed, "runner_registration_replayed");

  const runtimeClient = createOpenTagClient({
    controlPlaneUrl: baseUrl,
    controlCredential: { kind: "runtime", token: registered.runnerToken },
  });
  const context = await runtimeClient.getRunnerControlContextV1({ runnerId });
  assert(context.organizationId === organizationId, "wrong_runner_organization");

  const target = {
    projectTargetId,
    provider: "github" as const,
    owner: "smoke",
    repo: "control-plane",
    defaultExecutor: "executor_acp",
    defaultBranch: "main",
  };
  const targetBindingDigest = await computeGitHubProjectTargetBindingDigestV1(target);
  const targetContext = await runtimeClient.upsertRunnerProjectTargetControlV1({
    runnerId,
    projectTargetId,
    request: {
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.repository-binding.v1"],
      requestId: `request_target_${stamp}`,
      expectedAuthority: {
        credentialId: registered.credentialId,
        registrationGeneration: registered.registrationGeneration,
        credentialGeneration: registered.credentialGeneration,
      },
      target,
    },
  });
  assert(targetContext.targets.some((candidate) =>
    candidate.projectTargetId === projectTargetId
      && candidate.bindingDigest === targetBindingDigest), "target_readback_mismatch");

  const now = new Date();
  const readinessId = `readiness_smoke_${stamp}`;
  const executorCapabilityDigest = `sha256:${"c".repeat(64)}`;
  const readinessPayload = {
    readinessId,
    runnerId,
    registrationGeneration: registered.registrationGeneration,
    capabilities: [...capabilities],
    executors: [{
      executorId: "executor_acp",
      adapterVersion: "1.0.0",
      capabilityDigest: executorCapabilityDigest,
      state: "ready" as const,
    }],
    targets: [{
      projectTargetId,
      bindingDigest: targetBindingDigest,
      state: "ready" as const,
    }],
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
  };
  const readinessSeed = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    receiptId: readinessId,
    organizationId,
    operationId: `operation_readiness_${stamp}`,
    requiredCapabilities: ["relay.readiness.v1"] as const,
    producer: {
      kind: "runner" as const,
      id: runnerId,
      credentialId: registered.credentialId,
      registrationGeneration: registered.registrationGeneration,
    },
    identity: {
      namespace: "opentag.control.receipt/runner-readiness/v1" as const,
      parts: [organizationId, runnerId, `${registered.registrationGeneration}`, readinessId],
    },
    observedAt: now.toISOString(),
    payloadDigest: await computeControlPayloadDigestV1(readinessPayload),
    receiptDigest: `sha256:${"0".repeat(64)}`,
    receiptKind: "runner_readiness" as const,
    payload: readinessPayload,
  };
  const { receiptDigest: _readinessDigest, ...readinessDigestInput } = readinessSeed;
  const readiness = RunnerReadinessReceiptEnvelopeV1Schema.parse({
    ...readinessSeed,
    receiptDigest: await computeControlReceiptDigestV1(readinessDigestInput),
  });
  await runtimeClient.reportRunnerReadinessControlV1(readiness);

  const slackTimestamp = String(Math.floor(Date.now() / 1_000));
  const slackBody = JSON.stringify({
    type: "event_callback",
    team_id: required("OPENTAG_SMOKE_SLACK_TEAM_ID"),
    api_app_id: required("OPENTAG_SMOKE_SLACK_APP_ID"),
    event_id: `Ev_smoke_${stamp}`,
    event_time: Number(slackTimestamp),
    authorizations: [{ user_id: required("OPENTAG_SMOKE_SLACK_BOT_USER_ID") }],
    event: {
      type: "app_mention",
      user: required("OPENTAG_SMOKE_SLACK_ACTOR_USER_ID"),
      text: `<@${required("OPENTAG_SMOKE_SLACK_BOT_USER_ID")}> verify the clean control plane`,
      ts: `${slackTimestamp}.000100`,
      channel: required("OPENTAG_SMOKE_SLACK_CHANNEL_ID"),
    },
  });
  const slackSignature = `v0=${createHmac(
    "sha256",
    required("OPENTAG_SMOKE_SLACK_SIGNING_SECRET"),
  ).update(`v0:${slackTimestamp}:${slackBody}`).digest("hex")}`;
  await json<{ ok: true }>(await fetch(
    `${baseUrl}/v1/providers/slack/events/${required("OPENTAG_SMOKE_SLACK_ROUTE_IDENTITY")}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": slackTimestamp,
        "x-slack-signature": slackSignature,
      },
      body: slackBody,
    },
  ), 200);

  const claimRequest: Parameters<
    typeof runtimeClient.claimHostedRunControlV1
  >[0]["request"] = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: [...hostedCapabilities],
    requestId: `request_claim_${stamp}`,
    operationId: `operation_claim_${stamp}`,
    expectedAuthority: {
      credentialId: registered.credentialId,
      registrationGeneration: registered.registrationGeneration,
      credentialGeneration: registered.credentialGeneration,
      runnerReadinessReceiptId: readiness.receiptId,
      runnerReadinessReceiptDigest: readiness.receiptDigest,
    },
  };
  let claim = await runtimeClient.claimHostedRunControlV1({ runnerId, request: claimRequest });
  const claimDeadline = Date.now() + 30_000;
  while (!claim && Date.now() < claimDeadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    claim = await runtimeClient.claimHostedRunControlV1({ runnerId, request: claimRequest });
  }
  assert(claim, "hosted_claim_missing_after_slack_admission");
  const admitted = { runId: claim.runId };

  const workspaceAttestation = {
    workspaceId: `workspace_smoke_${stamp}`,
    workspacePathDigest: `sha256:${"1".repeat(64)}`,
    repositoryPathDigest: `sha256:${"2".repeat(64)}`,
    worktreeIdentityDigest: `sha256:${"3".repeat(64)}`,
    baseRevision: "a".repeat(40),
    currentRevision: "a".repeat(40),
    currentTree: "b".repeat(40),
    workspaceStateDigest: `sha256:${"4".repeat(64)}`,
    attemptId: claim.attempt.id,
    attemptNumber: claim.attempt.number,
    fencingTokenDigest: claim.attempt.fencingTokenDigest,
    credentialId: claim.authority.credentialId,
    leaseExpiresAt: claim.attempt.leaseExpiresAt,
  };
  const running = HostedRunningRequestV1Schema.parse(
    await buildHostedLifecycleRequestV1({
      organizationId,
      runnerId,
      runId: admitted.runId,
      action: "running",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      occurredAt: new Date().toISOString(),
      executorId: claim.executorId,
      executorCapabilityDigest: claim.authority.executorCapabilityDigest,
      workspaceAttestation,
    }),
  );
  const runningResult = await runtimeClient.markHostedRunRunningControlV1({
    organizationId,
    credentialId: claim.authority.credentialId,
    runnerId,
    runId: admitted.runId,
    request: running,
  });
  assert(runningResult.status === 201, "hosted_running_not_recorded");

  const recoveryClient = createOpenTagClient({
    controlPlaneUrl: baseUrl,
    controlCredential: {
      kind: "recovery_pairing",
      token: required("OPENTAG_RECOVERY_PAIRING_TOKEN"),
    },
  });
  const reprovisioned = await recoveryClient.reprovisionRunnerControlV1({
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.credential-reprovision.v1"],
    requestId: `request_reprovision_${stamp}`,
    operationId: `operation_reprovision_${stamp}`,
    runnerId,
    recoveryCredentialId: registered.credentialId,
    expectedRegistrationGeneration: registered.registrationGeneration,
    expectedCredentialGeneration: registered.credentialGeneration,
  });
  assert(!reprovisioned.replayed, "credential_reprovision_replayed");
  let oldCredentialStatus = 0;
  try {
    await runtimeClient.getRunnerControlContextV1({ runnerId });
  } catch (error) {
    oldCredentialStatus = (error as { status?: number }).status ?? 0;
  }
  assert(oldCredentialStatus === 401, "old_runtime_credential_still_valid");
  const recoveredClient = createOpenTagClient({
    controlPlaneUrl: baseUrl,
    controlCredential: {
      kind: "runtime",
      token: reprovisioned.runnerToken,
    },
  });
  const recoveredContext = await recoveredClient.getRunnerControlContextV1({
    runnerId,
  });
  assert(recoveredContext.credentialGeneration === 2, "credential_generation_not_advanced");

  console.log(JSON.stringify({
    status: "ok",
    runnerId,
    runId: admitted.runId,
    registrationGeneration: recoveredContext.registrationGeneration,
    credentialGeneration: recoveredContext.credentialGeneration,
    lifecycle: runningResult.receipt.payload.operation,
  }));
}

await main();
