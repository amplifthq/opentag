import { describe, expect, it, vi } from "vitest";
import { buildRunnerReadinessReceipt, createHostedControlLoop } from "../src/control-v1.js";

const now = new Date("2026-08-15T07:00:00.000Z");
const sha = (character: string) => `sha256:${character.repeat(64)}`;

describe("paired relay recovery certification", () => {
  it("recovers a durable assignment after restart without adopting a relay workspace and fences stale execution", async () => {
    const localCheckout = process.cwd();
    const repository = { projectTargetId: "target_1", provider: "github", owner: "acme", repo: "widget",
      checkoutPath: localCheckout, defaultExecutor: "reviewer", baseBranch: "main",
      pushRemote: "origin", keepWorktree: "on_failure" as const };
    const executor = { id: "reviewer", displayName: "Review Agent",
      capability: { id: "reviewer", protocol: "acp" }, canRun: vi.fn(async () => ({ ready: true })) } as never;
    const context = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      contextKind: "runner_control" as const, organizationId: "org_1", runnerId: "runner_1",
      credentialId: "credential_1", registrationGeneration: 1, credentialGeneration: 1,
      capabilities: ["relay.claim-fence.v1", "relay.hosted-admission.v1", "relay.hosted-claim.v1",
        "relay.lifecycle.v1", "relay.readiness.v1", "relay.source-content-redeem.v1"] as const,
      targets: [{ projectTargetId: "target_1", bindingDigest: sha("a"), provider: "github" as const,
        owner: "acme", repo: "widget", defaultExecutor: "reviewer", defaultBranch: "main" }],
      observedAt: now.toISOString() };
    const readiness = await buildRunnerReadinessReceipt({ context, executors: { reviewer: executor },
      repositories: [repository], now: () => now });
    const cloudClaim = { run: { id: "run_1" }, attemptId: "attempt_1", fencingToken: "stale_fence",
      workspacePath: "/relay/must/not/be/adopted" };
    let recoveryAvailable = true;
    const repo = {
      getHostedProposalSettlementForRetry: vi.fn(async () => null),
      recoverExpiredHostedLifecycleOperations: vi.fn(async () => 0),
      claimDueHostedLifecycleOperations: vi.fn(async () => []),
      acknowledgeHostedLifecycleOperation: vi.fn(), retryHostedLifecycleOperation: vi.fn(),
      markHostedLifecycleOperationAttention: vi.fn(),
      recoverExpiredControlPlaneProjectionLeases: vi.fn(async () => ({ recovered: 0, entries: [] })),
      claimDueControlPlaneProjections: vi.fn(async () => ({ entries: [] })),
      acknowledgeControlPlaneProjection: vi.fn(), retryControlPlaneProjection: vi.fn(),
      markControlPlaneProjectionAttention: vi.fn(),
      getHostedPreImportAuthorityRecovery: vi.fn(async () => null),
      getHostedClaimOperationForRetry: vi.fn(async () => null),
      getLatestRunnerReadinessProjection: vi.fn(async () => null),
      getHostedAssignedRunForRecovery: vi.fn(async () => recoveryAvailable ? {
        claimed: cloudClaim,
        leaseExpiresAt: "2026-08-15T07:05:00.000Z",
        hostedAuthority: { organizationId: "org_1", runnerId: "runner_1", runId: "run_1",
          credentialId: "credential_1", registrationGeneration: 1, credentialGeneration: 1,
          projectTargetId: "target_1", targetBindingDigest: sha("a"), executorId: "reviewer",
          executorCapabilityDigest: readiness.payload.executors[0]!.capabilityDigest,
          attemptId: "attempt_1", attemptNumber: 1, epoch: 1, fencingTokenDigest: sha("f"),
          admissionPolicySnapshotId: "policy_1", policyReceiptDigest: sha("b"),
          importedAt: now.toISOString() },
      } : null),
      isHostedExecutionCurrent: vi.fn(async () => false),
      getHostedExecutionLease: vi.fn(async () => null),
    } as never;
    const controlClient = {
      claimNextPublicationOperationControlV1: vi.fn(async () => null),
      getRunnerControlContextV1: vi.fn(async () => context),
    } as never;
    const config = { runnerId: "runner_1", relayUrl: "https://control.example",
      runnerToken: "local_runtime_secret", repositories: [repository], agents: {},
      scratchRoot: "/tmp/opentag-cert", keepScratch: "on_failure", approvalMode: "auto",
      controlRegistration: { kind: "hosted_control_v1", state: "paired", operationId: "pair_1",
        registration: { schemaVersion: 1, protocolVersion: "1.0", organizationId: "org_1",
          runnerId: "runner_1", credentialId: "credential_1", registrationGeneration: 1,
          credentialGeneration: 1, credentialPurpose: "runtime", createdAt: now.toISOString() } } } as never;
    const workspaceMutation = vi.fn();
    const execute = vi.fn(async (input) => {
      expect(input.repositories[0]?.checkoutPath).toBe(localCheckout);
      expect((input.claimed as typeof cloudClaim).workspacePath).toBe("/relay/must/not/be/adopted");
      if (await input.hostedExecutionAuthority.assertCurrent()) workspaceMutation();
      recoveryAvailable = false;
      return false;
    });
    const beforeRestart = createHostedControlLoop({ config, databasePath: ":memory:",
      executors: { reviewer: executor }, now: () => now, controlClient,
      governanceStore: { repo, close: vi.fn() }, executeClaimedRunImpl: execute as never });
    await beforeRestart?.close();
    expect(execute).not.toHaveBeenCalled();

    const restarted = createHostedControlLoop({ config, databasePath: ":memory:",
      executors: { reviewer: executor }, now: () => now, controlClient,
      governanceStore: { repo, close: vi.fn() }, executeClaimedRunImpl: execute as never });
    await expect(restarted?.beforeIteration()).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(repo.isHostedExecutionCurrent).toHaveBeenCalledWith({ runId: "run_1",
      attemptId: "attempt_1", fencingToken: "stale_fence" });
    expect(workspaceMutation).not.toHaveBeenCalled();
    await restarted?.close();
  });

});
