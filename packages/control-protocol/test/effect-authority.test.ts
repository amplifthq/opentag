import { describe, expect, it } from "vitest";
import {
  EffectEvidenceV1Schema,
  EffectEvidenceEnvelopeV1Schema,
  EffectExecutePermitV1Schema,
  EffectReconciliationPermitV1Schema,
  EffectRequestV1Schema,
  EffectViewV1Schema,
  GitBranchRefV1Schema,
  GitHubDraftPullRequestEffectTargetV1Schema,
  GitHubDraftPullRequestObservationV1Schema,
  computeEffectEvidenceDigestV1,
  computeEffectEvidencePayloadDigestV1,
  computeEffectFencingTokenDigestV1,
  computeEffectPermitDigestV1,
  computeEffectRequestDigestV1,
  computeEffectTargetDigestV1,
  verifyEffectEvidenceEnvelopeV1,
  verifyEffectPermitV1,
  verifyEffectRequestV1,
} from "../src/index.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

const requestInput = {
  schemaVersion: 1 as const,
  protocolVersion: "1.0" as const,
  requiredCapabilities: ["relay.effect-authority.v1"] as const,
  requestId: "request_1",
  effectId: "effect_1",
  idempotencyKey: "effect_request_1",
  organizationId: "org_1",
  runnerId: "runner_1",
  runnerGeneration: 2,
  work: {
    runId: "run_1",
    attemptId: "attempt_1",
    attemptNumber: 3,
    epoch: 3,
    fencingToken: "fence_1",
    fencingTokenDigest: digest("a"),
  },
  effectKind: "github.create_draft_pull_request" as const,
  candidate: {
    candidateId: "candidate_1",
    candidateDigest: digest("b"),
  },
  authority: {
    approvalPolicy: "human_approval_required" as const,
    policySnapshotId: "policy_1",
    policySnapshotDigest: digest("1"),
    approvalRequestId: "approval_request_1",
    approvalExpiresAt: "2026-09-05T01:17:03.004Z",
  },
  target: {
    projectTargetId: "target_1",
    targetBindingDigest: digest("c"),
    targetBindingGeneration: 4,
    provider: "github" as const,
    owner: "acme",
    repo: "demo",
    remote: "origin",
    baseBranch: "main",
    branch: "opentag/run_1",
    frozenBaseRevision: "d".repeat(40),
    workspaceTreeDigest: "e".repeat(40),
    expectedHeadSha: "f".repeat(40),
  },
  requestedAt: "2026-09-05T01:02:03.004Z",
};

const executePermitInput = {
  schemaVersion: 1 as const,
  protocolVersion: "1.0" as const,
  requiredCapabilities: ["relay.effect-authority.v1"] as const,
  permitId: "permit_1",
  permitKind: "execute" as const,
  effectId: "effect_1",
  effectAttemptNumber: 1,
  organizationId: "org_1",
  runnerId: "runner_1",
  runnerGeneration: 2,
  acquireRequestId: "acquire_1",
  acquireJournalDigest: digest("9"),
  runId: "run_1",
  runAttemptId: "attempt_1",
  runAttemptNumber: 3,
  fencingTokenDigest: digest("a"),
  effectKind: "github.create_draft_pull_request" as const,
  requestDigest: digest("b"),
  targetDigest: digest("c"),
  approvalDigest: digest("d"),
  candidate: {
    candidateId: "candidate_1",
    candidateDigest: digest("e"),
  },
  target: requestInput.target,
  issuedAt: "2026-09-05T01:02:03.004Z",
  expiresAt: "2026-09-05T01:07:03.004Z",
};

describe("Effect Authority V1 request", () => {
  it("binds the exact deterministic publication target into a stable digest", async () => {
    const first = await computeEffectRequestDigestV1(requestInput);
    const second = await computeEffectRequestDigestV1({ ...requestInput });
    const changed = await computeEffectRequestDigestV1({
      ...requestInput,
      target: { ...requestInput.target, expectedHeadSha: "0".repeat(40) },
    });
    const changedAuthority = await computeEffectRequestDigestV1({
      ...requestInput,
      authority: { ...requestInput.authority, policySnapshotDigest: digest("2") },
    });

    expect(first).toBe(second);
    expect(changed).not.toBe(first);
    expect(changedAuthority).not.toBe(first);
    expect(EffectRequestV1Schema.safeParse({ ...requestInput, requestDigest: first }).success)
      .toBe(true);
  });

  it("independently verifies the fence and request digests", async () => {
    const fencingTokenDigest = await computeEffectFencingTokenDigestV1(
      requestInput.work.fencingToken,
    );
    const digestInput = {
      ...requestInput,
      work: { ...requestInput.work, fencingTokenDigest },
    };
    const request = {
      ...digestInput,
      requestDigest: await computeEffectRequestDigestV1(digestInput),
    };

    await expect(verifyEffectRequestV1(request)).resolves.toBe(true);
    await expect(verifyEffectRequestV1({ ...request, requestDigest: digest("0") }))
      .resolves.toBe(false);
    const mismatchedFenceInput = {
      ...digestInput,
      work: { ...digestInput.work, fencingTokenDigest: digest("0") },
    };
    await expect(verifyEffectRequestV1({
      ...mismatchedFenceInput,
      requestDigest: await computeEffectRequestDigestV1(mismatchedFenceInput),
    })).resolves.toBe(false);
  });

  it("rejects a non-deterministic or target branch and credential-bearing extras", async () => {
    const requestDigest = await computeEffectRequestDigestV1(requestInput);
    expect(EffectRequestV1Schema.safeParse({
      ...requestInput,
      requestDigest,
      target: { ...requestInput.target, branch: "feature/manual" },
    }).success).toBe(false);
    expect(EffectRequestV1Schema.safeParse({
      ...requestInput,
      requestDigest,
      target: { ...requestInput.target, branch: "main" },
    }).success).toBe(false);
    expect(EffectRequestV1Schema.safeParse({
      ...requestInput,
      requestDigest,
      target: { ...requestInput.target, githubToken: "ghp_not_allowed" },
    }).success).toBe(false);
    expect(EffectRequestV1Schema.safeParse({
      ...requestInput,
      requestDigest,
      checkoutPath: "/tmp/repository",
    }).success).toBe(false);
    expect(EffectRequestV1Schema.safeParse({
      ...requestInput,
      requestDigest,
      authority: { ...requestInput.authority, approvalExpiresAt: requestInput.requestedAt },
    }).success).toBe(false);
    expect(GitHubDraftPullRequestEffectTargetV1Schema.safeParse({
      ...requestInput.target,
      owner: "ghp_12345678",
    }).success).toBe(false);
    expect(GitHubDraftPullRequestEffectTargetV1Schema.safeParse({
      ...requestInput.target,
      repo: "github_pat_1234567890abcdef",
    }).success).toBe(false);
  });

  it.each(["run:1", "feature branch", "feature..branch", "topic/@{bad", "topic.lock",
    "topic/", "topic\nnext"])("rejects unsafe Git branch input %j", (branch) => {
    expect(GitBranchRefV1Schema.safeParse(branch).success).toBe(false);
  });
});

describe("Effect Authority V1 permits", () => {
  it("keeps execute permits short-lived and credential-free", async () => {
    const permitInput = {
      ...executePermitInput,
      targetDigest: await computeEffectTargetDigestV1(executePermitInput.target),
    };
    const permitDigest = await computeEffectPermitDigestV1(permitInput);
    const permit = { ...permitInput, permitDigest };
    expect(EffectExecutePermitV1Schema.safeParse(permit).success)
      .toBe(true);
    await expect(verifyEffectPermitV1(permit)).resolves.toBe(true);
    await expect(verifyEffectPermitV1({ ...permit, permitDigest: digest("0") }))
      .resolves.toBe(false);
    await expect(verifyEffectPermitV1({
      ...permit,
      targetDigest: digest("0"),
      permitDigest: await computeEffectPermitDigestV1({ ...permitInput, targetDigest: digest("0") }),
    })).resolves.toBe(false);
    expect(await computeEffectPermitDigestV1({
      ...permitInput,
      predecessorEvidenceDigest: digest("7"),
    })).not.toBe(permitDigest);
    expect(JSON.stringify(executePermitInput)).not.toMatch(/githubToken|checkoutPath|authorization/iu);

    expect(EffectExecutePermitV1Schema.safeParse({
      ...executePermitInput,
      permitDigest,
      expiresAt: "2026-09-05T01:07:03.005Z",
    }).success).toBe(false);
  });

  it("makes reconciliation a closed readback-only permit", async () => {
    const reconciliation = {
      ...executePermitInput,
      permitId: "permit_2",
      permitKind: "reconcile" as const,
      originalExecutePermitId: "permit_1",
      predecessorEvidenceDigest: digest("8"),
      observationPolicy: "github.exact_draft_pr.v1" as const,
    };
    const permitDigest = await computeEffectPermitDigestV1(reconciliation);

    expect(EffectReconciliationPermitV1Schema.safeParse({
      ...reconciliation,
      permitDigest,
    }).success).toBe(true);
    expect(await computeEffectPermitDigestV1({
      ...reconciliation,
      predecessorEvidenceDigest: digest("7"),
    })).not.toBe(permitDigest);
    expect(EffectExecutePermitV1Schema.safeParse({
      ...executePermitInput,
      permitDigest,
      originalExecutePermitId: "permit_1",
    }).success).toBe(false);
  });
});

describe("Effect Authority V1 evidence", () => {
  const absentEvidence = {
    kind: "absent" as const,
    observationScope: {
      provider: "github" as const,
      repository: { owner: "acme", repo: "demo" },
      baseBranch: "main",
      headBranch: "opentag/run_1",
      expectedHeadSha: "f".repeat(40),
      bindingGeneration: 4,
      targetBindingDigest: digest("c"),
      observationPolicy: "github.exact_draft_pr.v1" as const,
      observedAt: "2026-09-05T01:08:03.004Z",
    },
  };

  it("requires exact scoped absence and rejects caller-selected outcomes", () => {
    expect(EffectEvidenceV1Schema.safeParse(absentEvidence).success).toBe(true);
    expect(EffectEvidenceV1Schema.safeParse({
      kind: "absent",
      observationScope: { provider: "github" },
    }).success).toBe(false);
    expect(EffectEvidenceV1Schema.safeParse({
      kind: "succeeded",
      retryAuthorized: true,
    }).success).toBe(false);
  });

  it("binds payload and predecessor evidence deterministically", async () => {
    const payloadDigest = await computeEffectEvidencePayloadDigestV1(absentEvidence);
    const envelope = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.effect-authority.v1"] as const,
      evidenceId: "evidence_1",
      effectId: "effect_1",
      permitId: "permit_2",
      effectAttemptNumber: 2,
      organizationId: "org_1",
      producer: {
        kind: "runner" as const,
        runnerId: "runner_1",
        runnerGeneration: 2,
      },
      predecessorEvidenceDigest: digest("a"),
      observedAt: "2026-09-05T01:08:03.004Z",
      evidence: absentEvidence,
      payloadDigest,
    };

    const first = await computeEffectEvidenceDigestV1(envelope);
    const replay = await computeEffectEvidenceDigestV1({ ...envelope });
    const successor = await computeEffectEvidenceDigestV1({
      ...envelope,
      predecessorEvidenceDigest: digest("b"),
    });
    expect(first).toBe(replay);
    expect(successor).not.toBe(first);
    await expect(verifyEffectEvidenceEnvelopeV1({ ...envelope, evidenceDigest: first }))
      .resolves.toBe(true);
    await expect(verifyEffectEvidenceEnvelopeV1({
      ...envelope,
      payloadDigest: digest("0"),
      evidenceDigest: first,
    })).resolves.toBe(false);
    await expect(verifyEffectEvidenceEnvelopeV1({
      ...envelope,
      evidenceDigest: digest("0"),
    })).resolves.toBe(false);
    expect(EffectEvidenceEnvelopeV1Schema.safeParse({
      ...envelope,
      evidenceDigest: first,
      observedAt: "2026-09-05T01:08:04.004Z",
    }).success).toBe(false);
  });
});

describe("Effect Authority V1 GitHub observations", () => {
  const observation = {
    provider: "github" as const,
    repository: { owner: "acme", repo: "demo" },
    remote: "origin",
    branch: "opentag/run_1",
    baseBranch: "main",
    pullRequestNumber: 7,
    pullRequestResourceRef: "github_pr_7",
    pullRequestUrl: "https://github.com/acme/demo/pull/7",
    draft: true as const,
    state: "open" as const,
    headSha: "f".repeat(40),
    headBranch: "opentag/run_1",
    headRepository: { owner: "acme", repo: "demo" },
    baseSha: "e".repeat(40),
    checks: { typecheck: "passed" as const },
    checksComplete: true,
    observedAt: "2026-09-05T01:08:03.004Z",
  };

  it("accepts only canonical, credential-safe durable provider evidence", () => {
    expect(GitHubDraftPullRequestObservationV1Schema.safeParse(observation).success).toBe(true);
    for (const candidate of [
      { ...observation, remote: "token=ghp_12345678" },
      { ...observation, pullRequestResourceRef: "token=ghp_12345678" },
      { ...observation, pullRequestUrl: "https://user:secret@github.com/acme/demo/pull/7" },
      { ...observation, pullRequestUrl: "https://github.com/acme/demo/pull/7?token=secret" },
      { ...observation, repository: { owner: "ghp_12345678", repo: "demo" } },
      { ...observation, branch: "opentag/run_1\nAuthorization: bearer secret" },
      { ...observation, checks: { "token=ghp_12345678": "passed" as const } },
    ]) {
      expect(GitHubDraftPullRequestObservationV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("binds the provider resource identity to its exact repository and number", () => {
    expect(GitHubDraftPullRequestObservationV1Schema.safeParse({
      ...observation,
      pullRequestUrl: "https://github.com/acme/demo/pull/8",
    }).success).toBe(false);
    expect(GitHubDraftPullRequestObservationV1Schema.safeParse({
      ...observation,
      pullRequestResourceRef: "github_pr_8",
    }).success).toBe(false);
    expect(GitHubDraftPullRequestObservationV1Schema.safeParse({
      ...observation,
      headRepository: { owner: "another", repo: "demo" },
    }).success).toBe(false);
  });
});

describe("Effect Authority V1 truthful views", () => {
  const common = {
    effectId: "effect_1",
    effectKind: "github.create_draft_pull_request" as const,
    updatedAt: "2026-09-05T01:08:03.004Z",
  };
  const externalResource = {
    provider: "github" as const,
    resourceRef: "github_pr_7",
    uri: "https://github.com/acme/demo/pull/7",
  };

  it.each([
    { ...common, state: "requested" as const, currentAttemptNumber: 0 },
    { ...common, state: "authorized" as const, currentAttemptNumber: 0 },
    { ...common, state: "permit_issued" as const, currentAttemptNumber: 1 },
    { ...common, state: "observing" as const, currentAttemptNumber: 1,
      currentEvidenceDigest: digest("1"), externalResource },
    { ...common, state: "outcome_unknown" as const, currentAttemptNumber: 1,
      currentEvidenceDigest: digest("1"), reasonCode: "provider_timeout" },
    { ...common, state: "retry_eligible" as const, currentAttemptNumber: 1,
      currentEvidenceDigest: digest("1"), reasonCode: "local.provider_io_not_begun" as const },
    { ...common, state: "succeeded" as const, currentAttemptNumber: 1,
      currentEvidenceDigest: digest("1"), externalResource },
    { ...common, state: "attention" as const, currentAttemptNumber: 0,
      reasonCode: "operator_review_required" },
    { ...common, state: "attention" as const, currentAttemptNumber: 1,
      currentEvidenceDigest: digest("1"), externalResource,
      reasonCode: "provider_review_required" },
    { ...common, state: "cancelled_before_permit" as const, currentAttemptNumber: 0,
      reasonCode: "work_cancelled" },
  ])("accepts a coherent $state view", (view) => {
    expect(EffectViewV1Schema.safeParse(view).success).toBe(true);
  });

  it.each([
    { ...common, state: "requested", currentAttemptNumber: 1 },
    { ...common, state: "requested", currentAttemptNumber: 0, externalResource },
    { ...common, state: "succeeded", currentAttemptNumber: 1, externalResource },
    { ...common, state: "outcome_unknown", currentAttemptNumber: 1,
      currentEvidenceDigest: digest("1") },
    { ...common, state: "retry_eligible", currentAttemptNumber: 1,
      currentEvidenceDigest: digest("1"), reasonCode: "caller_requested_retry" },
    { ...common, state: "attention", currentAttemptNumber: 0, externalResource,
      reasonCode: "operator_review_required" },
    { ...common, state: "attention", currentAttemptNumber: 1, externalResource,
      reasonCode: "operator_review_required" },
    { ...common, state: "cancelled_before_permit", currentAttemptNumber: 1,
      reasonCode: "work_cancelled" },
  ])("rejects a contradictory $state view", (view) => {
    expect(EffectViewV1Schema.safeParse(view).success).toBe(false);
  });
});
