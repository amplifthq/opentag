import { createOpenTagClient } from "@opentag/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createControlPlaneApplication } from "../src/application.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const capability = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
  capabilityId: "capability_transport", organizationId: "org_transport", runId: "run_transport",
  attemptId: "attempt_transport", attemptNumber: 1, epoch: 1, fencingTokenDigest: `sha256:${"a".repeat(64)}`,
  candidateId: "candidate_transport", candidateDigest: `sha256:${"b".repeat(64)}`,
  approvalId: "approval_transport", approverId: "operator_injected", repository: { provider: "github" as const,
    owner: "acme", repo: "demo", remote: "origin", baseBranch: "main" }, branch: "opentag/run_transport",
  expectedHeadSha: "c".repeat(40), step: "push_owned_branch" as const, operationId: "operation_transport",
  idempotencyKey: "idempotency_transport", runnerId: "runner_transport", runnerGeneration: 1,
  issuedAt: "2026-08-15T12:00:00.000Z", expiresAt: "2026-08-15T12:01:00.000Z" };

describe.skipIf(!TEST_DATABASE_URL)("publication Control V1 transport", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  beforeAll(async () => { fixture = await createIsolatedPostgres(); await fixture.migrate(); });
  afterAll(async () => { if (fixture) await fixture.close(); });

  it("keeps publication ownership and completion payloads credential-free", async () => {
    const attestOwnership = vi.fn(async () => ({ kind: "recorded" as const,
      ownershipId: "ownership_transport", ownershipDigest: `sha256:${"d".repeat(64)}` }));
    const claimNext = vi.fn(async () => ({ kind: "issued" as const, capability }));
    const application = createControlPlaneApplication({ capabilities: { schemaVersion: 1, protocolVersion: "1.0",
      registryVersion: "opentag.control.capabilities/v1", capabilities: ["relay.publication.v1"],
      minimumClient: { schemaVersion: 1, protocolVersion: "1.0" }, deployment: { environment: "local", releaseSha: "local" } },
      readiness: { check: async () => ({ ready: true }) }, control: { bootstrap: { authenticate: () => null },
        runners: { authenticate: async () => ({ kind: "authenticated" as const,
          principal: { organizationId: "org_transport", runnerId: "runner_transport" } }) } as never, hosted: {} as never, permissions: {} as never,
        publisher: { attestOwnership, claim: async () => ({ kind: "issued" as const, capability }), begin: async () => ({ kind: "begun" as const }),
          record: async ({ receipt }: { receipt: unknown }) => ({ kind: "recorded" as const, receipt }),
          reconcile: async () => ({ kind: "outcome_unknown" as const }),
          claimNextForRunner: claimNext,
          complete: async () => ({ kind: "ready" as const, projection: "ready_for_review" as const }) } as never } });
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      if (typeof init?.body === "string") bodies.push(init.body);
      const response = await application.fetch(new Request(String(url), init));
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    };
    const runtimeClient = createOpenTagClient({ controlPlaneUrl: "http://control.test",
      controlCredential: { kind: "runtime", token: "opaque_runtime_token" }, fetchImpl });
    await expect(runtimeClient.attestPublicationBranchOwnershipControlV1({
      schemaVersion: 1, protocolVersion: "1.0", requiredCapabilities: ["relay.publication.v1"],
      requestId: "request_ownership_transport", organizationId: "org_transport",
      runnerId: "runner_transport", runnerGeneration: 1, runId: "run_transport",
      attemptId: "attempt_transport", attemptNumber: 1, fencingToken: "fence_transport",
      candidateId: "candidate_transport", candidateDigest: `sha256:${"b".repeat(64)}`,
      projectTargetId: "target_transport", targetBindingDigest: `sha256:${"a".repeat(64)}`,
      remote: "origin", baseBranch: "main", frozenBaseRevision: "a".repeat(40),
      workspaceTreeDigest: "b".repeat(40), branch: "opentag/run_transport",
      expectedHeadSha: "c".repeat(40), attestedAt: "2026-08-15T12:00:00.000Z",
    })).resolves.toEqual({ ownershipId: "ownership_transport",
      ownershipDigest: `sha256:${"d".repeat(64)}`, replayed: false });
    await expect(runtimeClient.claimNextPublicationOperationControlV1({ schemaVersion: 1,
      protocolVersion: "1.0", requiredCapabilities: ["relay.publication.v1"],
      requestId: "request_poll_transport", organizationId: "org_transport",
      runnerId: "runner_transport" })).resolves.toEqual({ capability, completionPending: false });
    expect(claimNext).toHaveBeenCalledWith(expect.objectContaining({ principal: expect.objectContaining({
      organizationId: "org_transport", runnerId: "runner_transport" }) }));
    await expect(runtimeClient.completePublicationControlV1({ schemaVersion: 1, protocolVersion: "1.0",
      requiredCapabilities: ["relay.publication.v1"], requestId: "request_complete_transport",
      organizationId: "org_transport", runnerId: "runner_transport", runnerGeneration: 1,
      runId: "run_transport", attemptId: "attempt_transport", attemptNumber: 1,
      fencingToken: "fence_transport", candidateId: "candidate_transport",
      candidateDigest: `sha256:${"b".repeat(64)}`, observation: { provider: "github",
        repository: { owner: "acme", repo: "demo" }, remote: "origin", branch: "opentag/run_transport",
        baseBranch: "main", pullRequestNumber: 7,
        pullRequestResourceRef: "github:acme/demo:pull_request:7",
        pullRequestUrl: "https://github.com/acme/demo/pull/7", draft: true, state: "open",
        headSha: "c".repeat(40), headBranch: "opentag/run_transport",
        headRepository: { owner: "acme", repo: "demo" }, baseSha: "d".repeat(40), checks: {}, checksComplete: true,
        observedAt: "2026-08-15T12:00:00.000Z" } })).resolves.toEqual({ status: 200, outcome: "ready" });
    expect(attestOwnership).toHaveBeenCalledWith(expect.objectContaining({ principal: expect.objectContaining({
      organizationId: "org_transport", runnerId: "runner_transport" }) }));
    expect(JSON.stringify(bodies)).not.toContain("githubToken");
    expect(JSON.stringify(bodies)).not.toContain("ghp_");
  });
});
