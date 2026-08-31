import { describe, expect, it } from "vitest";
import {
  HumanPublicationApprovalV1Schema,
  RunnerBranchOwnershipAttestationV1Schema,
  RunnerPublicationCompletionV1Schema,
  PublicationOperationReceiptDigestInputV1Schema,
} from "../src/index.js";
import {
  compareWellFormedUnicodeStrings,
  ProposalReadinessAssessmentSchema,
  sortWellFormedUnicodeStrings,
  WellFormedUnicodeStringSchema,
} from "../src/completion.js";

describe("Task 8 canonical timestamp contract", () => {
  const assessment = {
    state: "proposal_ready" as const,
    accepted: true,
    candidateId: "candidate_1",
    reasonCodes: ["proposal_ready" as const],
    assessedAt: "2026-08-31T01:02:03.004Z",
  };

  it.each([
    ["year zero", "0000-01-01T00:00:00.000Z", false],
    ["minimum year", "0001-01-01T00:00:00.000Z", true],
    ["maximum year", "9999-12-31T23:59:59.999Z", true],
    ["extended year", "+010000-01-01T00:00:00.000Z", false],
    ["valid leap day", "2024-02-29T00:00:00.000Z", true],
    ["invalid leap day", "2025-02-29T00:00:00.000Z", false],
    ["leap second", "2024-12-31T23:59:60.000Z", false],
    ["24:00", "2024-01-01T24:00:00.000Z", false],
    ["offset", "2026-08-31T09:02:03.004+08:00", false],
    ["no fraction", "2026-08-31T01:02:03Z", false],
    ["one fraction digit", "2026-08-31T01:02:03.0Z", false],
    ["two fraction digits", "2026-08-31T01:02:03.00Z", false],
    ["four fraction digits", "2026-08-31T01:02:03.0000Z", false],
  ])("%s is accepted exactly as specified", (_label, assessedAt, expected) => {
    expect(ProposalReadinessAssessmentSchema.safeParse({ ...assessment, assessedAt }).success)
      .toBe(expected);
  });

  it("rejects malformed Candidate identities without throwing and accepts supplementary scalars", () => {
    for (const malformed of [String.fromCharCode(0xd800), String.fromCharCode(0xdc00)]) {
      expect(() => ProposalReadinessAssessmentSchema.safeParse({
        ...assessment,
        candidateId: malformed,
      })).not.toThrow();
      expect(ProposalReadinessAssessmentSchema.safeParse({
        ...assessment,
        candidateId: malformed,
      }).success).toBe(false);
    }
    expect(ProposalReadinessAssessmentSchema.safeParse({
      ...assessment,
      candidateId: "candidate_😀",
    }).success).toBe(true);
  });
});

describe("Task 8 Unicode scalar contract", () => {
  const high = String.fromCharCode(0xd800);
  const low = String.fromCharCode(0xdc00);
  const values = ["😀", "é", "e\u0301", "a", "ab"];

  it("rejects lone surrogates and preserves scalar order without mutating input", () => {
    expect(WellFormedUnicodeStringSchema.safeParse(high).success).toBe(false);
    expect(WellFormedUnicodeStringSchema.safeParse(low).success).toBe(false);
    expect(WellFormedUnicodeStringSchema.safeParse("😀").success).toBe(true);
    expect(sortWellFormedUnicodeStrings(values)).toEqual(["a", "ab", "e\u0301", "é", "😀"]);
    expect(values).toEqual(["😀", "é", "e\u0301", "a", "ab"]);
    expect(compareWellFormedUnicodeStrings("é", "e\u0301")).toBeGreaterThan(0);
    expect(() => sortWellFormedUnicodeStrings([high])).toThrow(TypeError);
  });
});

describe("Task 9 publication receipt digest schema", () => {
  it("loads a digest input schema without receiptDigest", () => {
    expect(PublicationOperationReceiptDigestInputV1Schema.safeParse({}).success).toBe(false);
  });
});

describe("Task 9 frozen branch ownership and approval boundary", () => {
  const ownership = {
    schemaVersion: 1 as const, protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.publication.v1"] as const,
    requestId: "request_ownership_1", organizationId: "org_1",
    runnerId: "runner_1", runnerGeneration: 2, runId: "run_1",
    attemptId: "attempt_1", attemptNumber: 1, fencingToken: "local_fence",
    candidateId: "candidate_1", candidateDigest: `sha256:${"a".repeat(64)}`,
    projectTargetId: "target_1", targetBindingDigest: `sha256:${"b".repeat(64)}`,
    remote: "origin", baseBranch: "main", frozenBaseRevision: "c".repeat(40),
    workspaceTreeDigest: "d".repeat(40), branch: "opentag/run_1",
    expectedHeadSha: "e".repeat(40), attestedAt: "2026-08-31T01:02:03.004Z",
  };

  it("accepts a credential-free Runner ownership attestation and rejects a non-deterministic branch", () => {
    expect(RunnerBranchOwnershipAttestationV1Schema.parse(ownership)).not.toHaveProperty("repository");
    expect(RunnerBranchOwnershipAttestationV1Schema.safeParse({
      ...ownership, branch: "opentag/another-run",
    }).success).toBe(false);
    expect(JSON.stringify(ownership)).not.toMatch(/ghp_|github_token|authorization: bearer/iu);
  });

  it("keeps repository, branch, head, Attempt, fence, and generation out of human approval", () => {
    const approval = {
      schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.publication.v1"] as const,
      requestId: "request_approval_1", organizationId: "org_1",
      runnerId: "runner_1", runId: "run_1", ownershipId: "ownership_1",
      ownershipDigest: `sha256:${"f".repeat(64)}`, candidateId: "candidate_1",
      candidateDigest: `sha256:${"a".repeat(64)}`, approvalId: "approval_1",
      approvedAt: "2026-08-31T01:03:03.004Z", expiresAt: "2026-08-31T01:08:03.004Z",
    };
    expect(HumanPublicationApprovalV1Schema.safeParse(approval).success).toBe(true);
    for (const injected of ["repository", "branch", "expectedHeadSha", "attemptId",
      "attemptNumber", "fencingToken", "runnerGeneration"]) {
      expect(HumanPublicationApprovalV1Schema.safeParse({ ...approval, [injected]: "malicious" }).success)
        .toBe(false);
    }
  });
});

describe("Task 9 publication completion observation", () => {
  it("accepts exact credential-free PR and check evidence", () => {
    const parsed = RunnerPublicationCompletionV1Schema.parse({
      schemaVersion: 1, protocolVersion: "1.0",
      requiredCapabilities: ["relay.publication.v1"],
      requestId: "request_complete_publication", organizationId: "org_1",
      runnerId: "runner_1", runnerGeneration: 2, runId: "run_1",
      attemptId: "attempt_1", attemptNumber: 1, fencingToken: "local_fence",
      candidateId: "candidate_1", candidateDigest: `sha256:${"a".repeat(64)}`,
      observation: {
        provider: "github", repository: { owner: "acme", repo: "widget" },
        remote: "origin", branch: "opentag/run_1", baseBranch: "main",
        pullRequestNumber: 7,
        pullRequestResourceRef: "github:acme/widget:pull_request:7",
        pullRequestUrl: "https://github.com/acme/widget/pull/7", draft: true,
        state: "open", headSha: "b".repeat(40), baseSha: "c".repeat(40),
        checks: { test: "passed" }, checksComplete: true,
        observedAt: "2026-08-31T01:02:03.004Z",
      },
    });
    // The fencing token is an opaque control-plane authority and is expected
    // in this Runner-authenticated message.  What must never cross this
    // protocol boundary is a provider credential.
    expect(parsed).not.toHaveProperty("githubToken");
    expect(parsed).not.toHaveProperty("credential");
    expect(JSON.stringify(parsed)).not.toMatch(/ghp_|github_token|authorization: bearer/iu);
  });
});
