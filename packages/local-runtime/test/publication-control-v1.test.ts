import { describe, expect, it, vi } from "vitest";
import { runPublicationControlV1Iteration } from "../src/control-v1.js";
import { executePublicationControlV1, executePublicationOperation } from "../src/pr.js";

const capability = {
  schemaVersion: 1 as const, protocolVersion: "1.0" as const,
  capabilityId: "publication_capability_1", organizationId: "org_1",
  runId: "run_1", attemptId: "attempt_1", attemptNumber: 1, epoch: 1,
  fencingTokenDigest: `sha256:${"1".repeat(64)}`,
  candidateId: "candidate_1", candidateDigest: `sha256:${"2".repeat(64)}`,
  approvalId: "approval_1", approverId: "operator_1",
  repository: { provider: "github" as const, owner: "acme", repo: "widget",
    remote: "origin", baseBranch: "main" },
  branch: "opentag/run_1", expectedHeadSha: "a".repeat(40),
  step: "create_draft_pull_request" as const,
  operationId: "publication_operation_1", idempotencyKey: "publication_idempotency_1",
  runnerId: "runner_1", runnerGeneration: 3,
  issuedAt: "2026-08-10T00:00:00.000Z", expiresAt: "2026-08-10T00:01:00.000Z",
};

describe("publication Control V1 local execution", () => {
  it("fails closed before provider or relay mutation when the exact local fence is absent", async () => {
    const begin = vi.fn();
    const record = vi.fn();
    const push = vi.fn();
    const createDraftPullRequest = vi.fn();
    const didWork = await runPublicationControlV1Iteration({
      organizationId: "org_1", runnerId: "runner_1", runnerGeneration: 3,
      now: () => new Date("2026-08-10T00:00:30.000Z"),
      client: {
        claimNextPublicationOperationControlV1: vi.fn(async () => ({
          capability: { ...capability, step: "push_owned_branch" as const },
          completionPending: false,
        })),
        beginPublicationOperationControlV1: begin,
        recordPublicationOperationReceiptControlV1: record,
        reconcilePublicationOperationControlV1: vi.fn(),
        completePublicationControlV1: vi.fn(),
      },
      getLocalAuthority: vi.fn(async () => null),
      pushOwnedBranch: push,
      createDraftPullRequest,
      reconcileOperation: vi.fn(),
      observeCompletion: vi.fn(),
    });
    expect(didWork).toBe(false);
    expect(begin).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(createDraftPullRequest).not.toHaveBeenCalled();
  });

  it("completes from the immutable prior PR receipt without replaying either publication effect", async () => {
    const priorReceipt = {
      schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      receiptId: "receipt_publication_capability_1", capabilityId: capability.capabilityId,
      operationId: capability.operationId, organizationId: capability.organizationId,
      runId: capability.runId, attemptId: capability.attemptId,
      candidateId: capability.candidateId, candidateDigest: capability.candidateDigest,
      step: "create_draft_pull_request" as const, runnerId: capability.runnerId,
      runnerGeneration: capability.runnerGeneration,
      fencingTokenDigest: capability.fencingTokenDigest,
      observation: { kind: "present" as const, headSha: capability.expectedHeadSha,
        externalId: "github_pr_7", externalUri: "https://github.com/acme/widget/pull/7",
        draft: true as const },
      outcome: "succeeded" as const, observedAt: "2026-08-10T00:00:20.000Z",
      receiptDigest: `sha256:${"5".repeat(64)}`,
    };
    const complete = vi.fn(async (request) => {
      expect(JSON.stringify(request)).not.toContain("ghs_local_only");
      expect(JSON.stringify(request)).not.toContain("source plaintext");
      return { status: 200 as const, outcome: "ready" as const };
    });
    const push = vi.fn();
    const createDraftPullRequest = vi.fn();
    const didWork = await runPublicationControlV1Iteration({
      organizationId: "org_1", runnerId: "runner_1", runnerGeneration: 3,
      now: () => new Date("2026-08-10T00:00:30.000Z"),
      client: {
        claimNextPublicationOperationControlV1: vi.fn(async () => ({
          capability, completionPending: true, completionReceipt: priorReceipt,
        })),
        beginPublicationOperationControlV1: vi.fn(),
        recordPublicationOperationReceiptControlV1: vi.fn(),
        reconcilePublicationOperationControlV1: vi.fn(),
        completePublicationControlV1: complete,
      },
      getLocalAuthority: vi.fn(async () => ({ fencingToken: "fence_local_only", attemptNumber: 1 })),
      pushOwnedBranch: push,
      createDraftPullRequest,
      reconcileOperation: vi.fn(),
      observeCompletion: vi.fn(async () => ({ provider: "github" as const,
        repository: { owner: "acme", repo: "widget" }, remote: "origin",
        branch: "opentag/run_1", baseBranch: "main", pullRequestNumber: 7,
        pullRequestResourceRef: "github://acme/widget/pull/7",
        pullRequestUrl: "https://github.com/acme/widget/pull/7", draft: true as const,
        state: "open" as const, headSha: "a".repeat(40), baseSha: "b".repeat(40),
        checks: { test: "passed" as const }, checksComplete: true,
        observedAt: "2026-08-10T00:00:30.000Z" })),
    });
    expect(didWork).toBe(true);
    expect(push).not.toHaveBeenCalled();
    expect(createDraftPullRequest).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("reconciles an ambiguous effect once and never blindly retries it", async () => {
    const push = vi.fn(async () => ({ kind: "ambiguous" as const }));
    const reconcileOperation = vi.fn(async () => ({ kind: "present" as const,
      headSha: capability.expectedHeadSha }));
    const reconcile = vi.fn(async () => ({ status: 200 as const, outcome: "settled" as const }));
    const didWork = await runPublicationControlV1Iteration({
      organizationId: "org_1", runnerId: "runner_1", runnerGeneration: 3,
      now: () => new Date("2026-08-10T00:00:30.000Z"),
      client: {
        claimNextPublicationOperationControlV1: vi.fn(async () => ({
          capability: { ...capability, step: "push_owned_branch" as const },
          completionPending: false,
        })),
        beginPublicationOperationControlV1: vi.fn(async () => ({ status: 201 as const,
          replayed: false, outcome: "accepted" as const })),
        recordPublicationOperationReceiptControlV1: vi.fn(async (request) => ({ status: 201 as const,
          replayed: false, receipt: request.receipt })),
        reconcilePublicationOperationControlV1: reconcile,
        completePublicationControlV1: vi.fn(),
      },
      getLocalAuthority: vi.fn(async () => ({ fencingToken: "fence_local_only", attemptNumber: 1 })),
      pushOwnedBranch: push,
      createDraftPullRequest: vi.fn(),
      reconcileOperation,
      observeCompletion: vi.fn(),
    });
    expect(didWork).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(reconcileOperation).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("restarts from control-plane state at every push → PR → completion boundary", async () => {
    const pushCapability = { ...capability, capabilityId: "publication_capability_push",
      operationId: "publication_operation_push", step: "push_owned_branch" as const };
    const prCapability = { ...capability, capabilityId: "publication_capability_pr",
      operationId: "publication_operation_pr" };
    const prReceipt = {
      schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      receiptId: "receipt_publication_capability_pr", capabilityId: prCapability.capabilityId,
      operationId: prCapability.operationId, organizationId: prCapability.organizationId,
      runId: prCapability.runId, attemptId: prCapability.attemptId,
      candidateId: prCapability.candidateId, candidateDigest: prCapability.candidateDigest,
      step: "create_draft_pull_request" as const, runnerId: prCapability.runnerId,
      runnerGeneration: prCapability.runnerGeneration,
      fencingTokenDigest: prCapability.fencingTokenDigest,
      observation: { kind: "present" as const, headSha: prCapability.expectedHeadSha,
        externalId: "github_pr_7", externalUri: "https://github.com/acme/widget/pull/7",
        draft: true as const }, outcome: "succeeded" as const,
      observedAt: "2026-08-10T00:00:20.000Z", receiptDigest: `sha256:${"5".repeat(64)}`,
    };
    const claims = [
      { capability: pushCapability, completionPending: false as const },
      { capability: prCapability, completionPending: false as const },
      { capability: prCapability, completionPending: true as const, completionReceipt: prReceipt },
      null,
    ];
    const push = vi.fn(async () => ({ kind: "present" as const,
      headSha: capability.expectedHeadSha }));
    const createDraftPullRequest = vi.fn(async () => ({ kind: "present" as const,
      pullRequestNumber: 7, pullRequestUrl: "https://github.com/acme/widget/pull/7",
      headSha: capability.expectedHeadSha, draft: true as const }));
    const complete = vi.fn(async () => ({ status: 200 as const, outcome: "ready" as const }));
    const client = {
      claimNextPublicationOperationControlV1: vi.fn(async () => claims.shift() ?? null),
      beginPublicationOperationControlV1: vi.fn(async () => ({ status: 201 as const,
        replayed: false, outcome: "accepted" as const })),
      recordPublicationOperationReceiptControlV1: vi.fn(async (request) => ({ status: 201 as const,
        replayed: false, receipt: request.receipt })),
      reconcilePublicationOperationControlV1: vi.fn(),
      completePublicationControlV1: complete,
    };
    const iteration = () => runPublicationControlV1Iteration({
      organizationId: "org_1", runnerId: "runner_1", runnerGeneration: 3,
      now: () => new Date("2026-08-10T00:00:30.000Z"), client,
      getLocalAuthority: vi.fn(async () => ({ fencingToken: "fence_local_only", attemptNumber: 1 })),
      pushOwnedBranch: push, createDraftPullRequest,
      reconcileOperation: vi.fn(),
      observeCompletion: vi.fn(async () => ({ provider: "github" as const,
        repository: { owner: "acme", repo: "widget" }, remote: "origin",
        branch: "opentag/run_1", baseBranch: "main", pullRequestNumber: 7,
        pullRequestResourceRef: "github:acme/widget:pull_request:7",
        pullRequestUrl: "https://github.com/acme/widget/pull/7", draft: true as const,
        state: "open" as const, headSha: "a".repeat(40), baseSha: "b".repeat(40),
        checks: { test: "passed" as const }, checksComplete: true,
        observedAt: "2026-08-10T00:00:30.000Z" })),
    });
    await expect(iteration()).resolves.toBe(true);
    await expect(iteration()).resolves.toBe(true);
    await expect(iteration()).resolves.toBe(true);
    await expect(iteration()).resolves.toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
    expect(createDraftPullRequest).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("durably begins before the local provider call and records the receipt before returning", async () => {
    const order: string[] = [];
    const result = await executePublicationOperation({ capability,
      localAuthority: { organizationId: "org_1", runId: "run_1", attemptId: "attempt_1",
        attemptNumber: 1, epoch: 1, fencingTokenDigest: capability.fencingTokenDigest,
        candidateId: "candidate_1", candidateDigest: capability.candidateDigest,
        runnerId: "runner_1", runnerGeneration: 3, now: "2026-08-10T00:00:30.000Z" },
      credential: { githubToken: "ghs_never_transport" },
      begin: async () => { order.push("begin"); return { kind: "begun" }; },
      createDraftPullRequest: async () => { order.push("provider"); return {
        kind: "present", pullRequestNumber: 7,
        pullRequestUrl: "https://github.com/acme/widget/pull/7",
        headSha: "a".repeat(40), draft: true,
      }; },
      record: async (receipt) => { order.push("record"); return receipt; },
    });
    expect(order).toEqual(["begin", "provider", "record"]);
    expect(result.outcome).toBe("succeeded");
    expect(JSON.stringify(result)).not.toContain("ghs_never_transport");
  });

  it.each([
    ["candidateDigest", `sha256:${"3".repeat(64)}`], ["runnerGeneration", 4],
    ["attemptId", "attempt_2"], ["fencingTokenDigest", `sha256:${"4".repeat(64)}`],
  ] as const)("rejects mismatched exact %s before begin", async (key, value) => {
    const begin = vi.fn();
    await expect(executePublicationOperation({ capability,
      localAuthority: { organizationId: "org_1", runId: "run_1", attemptId: "attempt_1",
        attemptNumber: 1, epoch: 1, fencingTokenDigest: capability.fencingTokenDigest,
        candidateId: "candidate_1", candidateDigest: capability.candidateDigest,
        runnerId: "runner_1", runnerGeneration: 3, now: "2026-08-10T00:00:30.000Z",
        [key]: value }, credential: { githubToken: "secret" }, begin,
      createDraftPullRequest: vi.fn(), record: vi.fn(),
    })).rejects.toThrow("publication_capability_identity_mismatch");
    expect(begin).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous operation outcome_unknown without a blind retry", async () => {
    const provider = vi.fn(async () => ({ kind: "ambiguous" as const }));
    const receipt = await executePublicationOperation({ capability,
      localAuthority: { organizationId: "org_1", runId: "run_1", attemptId: "attempt_1",
        attemptNumber: 1, epoch: 1, fencingTokenDigest: capability.fencingTokenDigest,
        candidateId: "candidate_1", candidateDigest: capability.candidateDigest,
        runnerId: "runner_1", runnerGeneration: 3, now: "2026-08-10T00:00:30.000Z" },
      credential: { githubToken: "secret" }, begin: async () => ({ kind: "begun" }),
      createDraftPullRequest: provider, record: async (value) => value,
    });
    expect(receipt.outcome).toBe("outcome_unknown");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("uses the Control V1 begin → local push → receipt order without putting its token in a relay payload", async () => {
    const order: string[] = [];
    const begin = vi.fn(async (request) => { order.push("begin");
      expect(JSON.stringify(request)).not.toContain("ghs_local_only");
      return { status: 201 as const, replayed: false, outcome: "accepted" as const }; });
    const record = vi.fn(async (request) => { order.push("receipt");
      expect(JSON.stringify(request)).not.toContain("ghs_local_only");
      return { status: 201 as const, replayed: false, receipt: request.receipt }; });
    const receipt = await executePublicationControlV1({
      client: { beginPublicationOperationControlV1: begin,
        recordPublicationOperationReceiptControlV1: record },
      capability: { ...capability, step: "push_owned_branch" }, fencingToken: "fence_local_only",
      now: () => "2026-08-10T00:00:30.000Z",
      pushOwnedBranch: async () => { order.push("push"); return { kind: "present",
        pullRequestNumber: 7, pullRequestUrl: "https://github.com/acme/widget/pull/7",
        headSha: "a".repeat(40), draft: true }; },
      createDraftPullRequest: async () => ({ kind: "ambiguous" }),
    });
    expect(order).toEqual(["begin", "push", "receipt"]);
    expect(receipt.outcome).toBe("succeeded");
  });
});
