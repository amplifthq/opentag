import {
  computeEffectFencingTokenDigestV1,
  verifyEffectRequestV1,
} from "@opentag/control-protocol";
import { describe, expect, it } from "vitest";
import { buildPublicationEffectRequest } from "../src/effects/request.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const now = new Date("2026-09-05T01:00:00.000Z");

const settlement = {
  runId: "run_1",
  attemptId: "attempt_1",
  attemptNumber: 2,
  fencingToken: "local_fence",
  fencingTokenDigest: "",
  runnerGeneration: 3,
  projectTargetId: "target_1",
  targetBindingDigest: digest("a"),
  policySnapshotId: "policy_1",
  policySnapshotDigest: digest("b"),
  candidateId: "candidate_1",
  candidateDigest: digest("c"),
  branch: "opentag/run_1",
  baseRevision: "d".repeat(40),
  finalRevision: "e".repeat(40),
  finalTree: "f".repeat(40),
  proposalCreatedAt: now.toISOString(),
};

const target = {
  projectTargetId: "target_1",
  bindingDigest: digest("a"),
  bindingGeneration: 7,
  provider: "github" as const,
  owner: "acme",
  repo: "demo",
  defaultBranch: "main",
};

const binding = {
  projectTargetId: "target_1",
  provider: "github" as const,
  owner: "acme",
  repo: "demo",
  checkoutPath: "/private/local/checkout",
  defaultExecutor: "codex",
  baseBranch: "main",
  pushRemote: "origin",
  keepWorktree: "on_failure" as const,
};

async function validSettlement() {
  return {
    ...settlement,
    fencingTokenDigest: await computeEffectFencingTokenDigestV1(settlement.fencingToken),
  };
}

describe("publication Effect request", () => {
  it("is restart-stable and carries only sealed authority facts", async () => {
    const input = {
      organizationId: "org_1",
      runnerId: "runner_1",
      runnerGeneration: 3,
      settlement: await validSettlement(),
      target,
      binding,
      now,
    };
    const first = await buildPublicationEffectRequest(input);
    const replay = await buildPublicationEffectRequest({
      ...input,
      now: new Date(now.getTime() + 60_000),
    });
    expect(replay).toEqual(first);
    expect(await verifyEffectRequestV1(first)).toBe(true);
    expect(first).toMatchObject({
      work: { runId: "run_1", attemptId: "attempt_1", attemptNumber: 2, epoch: 2 },
      authority: {
        approvalPolicy: "human_approval_required",
        policySnapshotId: "policy_1",
        policySnapshotDigest: digest("b"),
        approvalExpiresAt: "2026-09-06T01:00:00.000Z",
      },
      target: {
        targetBindingGeneration: 7,
        remote: "origin",
        baseBranch: "main",
        branch: "opentag/run_1",
        expectedHeadSha: "e".repeat(40),
      },
    });
    expect(JSON.stringify(first)).not.toContain(binding.checkoutPath);
    expect(JSON.stringify(first)).not.toContain("githubToken");
  });

  it("fails visibly after the durable approval window instead of minting new identity", async () => {
    await expect(buildPublicationEffectRequest({
      organizationId: "org_1",
      runnerId: "runner_1",
      runnerGeneration: 3,
      settlement: await validSettlement(),
      target,
      binding,
      now: new Date(now.getTime() + 24 * 60 * 60_000),
    })).rejects.toThrow("publication_effect_request_stale");
  });

  it("rejects target generation and local binding drift", async () => {
    await expect(buildPublicationEffectRequest({
      organizationId: "org_1",
      runnerId: "runner_1",
      runnerGeneration: 3,
      settlement: await validSettlement(),
      target: { ...target, bindingDigest: digest("0") },
      binding,
      now,
    })).rejects.toThrow("publication_effect_local_authority_missing");
    await expect(buildPublicationEffectRequest({
      organizationId: "org_1",
      runnerId: "runner_1",
      runnerGeneration: 3,
      settlement: await validSettlement(),
      target,
      binding: { ...binding, baseBranch: "release" },
      now,
    })).rejects.toThrow("publication_effect_local_authority_missing");
  });
});
