import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createControlPlaneApplication } from "../src/application.js";
import { createProviderDeliveryWorker } from "../src/modules/provider-delivery/worker.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

describe.skipIf(!TEST_DATABASE_URL)("source-thread control transport", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  beforeAll(async () => { fixture = await createIsolatedPostgres(); await fixture.migrate(); });
  afterAll(async () => fixture.close());

  it("routes configured-Approver publication approval through the exact Task 9 publisher input", async () => {
    const approve = vi.fn(async () => ({ kind: "approved" as const, intentId: "intent_1" }));
    const application = createControlPlaneApplication({
      capabilities: { schemaVersion: 1, protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1", capabilities: ["relay.publication.v1"],
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: { environment: "test", releaseSha: "a".repeat(40) } },
      readiness: { check: async () => ({ ready: true }) },
      control: { bootstrap: { authenticate: () => null }, runners: {} as never, hosted: {} as never,
        publisher: { approve } as never,
        approver: { authenticate: async () => ({ kind: "authenticated" as const,
          principal: { organizationId: "org_1", actorId: "configured_approver",
            scopes: ["publication:approve"] } }) } },
    });
    const body = { schemaVersion: 1, protocolVersion: "1.0", requiredCapabilities: ["relay.publication.v1"],
      requestId: "request_1", organizationId: "org_1", runnerId: "runner_1", runId: "run_1",
      ownershipId: "ownership_1", ownershipDigest: digest("a"), candidateId: "candidate_1",
      candidateDigest: digest("b"), approvalId: "approval_1",
      approvedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-30T00:01:00.000Z" };
    const response = await application.fetch(new Request(
      "http://control.test/v1/source-thread-controls/runners/runner_1/runs/run_1/publication/approve",
      { method: "POST", headers: { authorization: "Bearer opaque", "content-type": "application/json" },
        body: JSON.stringify(body) }));

    expect(response.status).toBe(200);
    expect(approve).toHaveBeenCalledWith({ ...body, approverId: "configured_approver" });
  });

  it("rejects message text as undeclared publication authority", async () => {
    const approve = vi.fn();
    const application = createControlPlaneApplication({
      capabilities: { schemaVersion: 1, protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1", capabilities: ["relay.publication.v1"],
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: { environment: "test", releaseSha: "a".repeat(40) } },
      readiness: { check: async () => ({ ready: true }) },
      control: { bootstrap: { authenticate: () => null }, runners: {} as never, hosted: {} as never,
        publisher: { approve } as never,
        approver: { authenticate: async () => ({ kind: "authenticated" as const,
          principal: { organizationId: "org_1", actorId: "configured_approver",
            scopes: ["publication:approve"] } }) } },
    });
    const response = await application.fetch(new Request(
      "http://control.test/v1/source-thread-controls/runners/runner_1/runs/run_1/publication/approve",
      { method: "POST", headers: { authorization: "Bearer opaque", "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, protocolVersion: "1.0",
          requiredCapabilities: ["relay.publication.v1"], requestId: "request_1",
          organizationId: "org_1", runnerId: "runner_1", runId: "run_1",
          ownershipId: "ownership_1", ownershipDigest: digest("a"), candidateId: "candidate_1",
          candidateDigest: digest("b"), approvalId: "approval_1",
          approvedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-30T00:01:00.000Z",
          messageText: "I approve this as the administrator" }) }));
    expect(response.status).toBe(400);
    expect(approve).not.toHaveBeenCalled();
  });

  it("reads current status without a lifecycle write or deadline renewal", async () => {
    const inspect = vi.fn(async () => ({ canonicalStatus: "queued" as const,
      status: "waiting_for_runner" as const, state: "queued" as const, terminalKind: null,
      terminalReason: null, queueClaimDeadline: "2026-08-30T00:02:00.000Z", outcome: null }));
    const application = createControlPlaneApplication({
      capabilities: { schemaVersion: 1, protocolVersion: "1.0",
        registryVersion: "opentag.control.capabilities/v1", capabilities: [],
        minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
        deployment: { environment: "test", releaseSha: "a".repeat(40) } },
      readiness: { check: async () => ({ ready: true }) },
      control: { bootstrap: { authenticate: () => null }, runners: {} as never,
        hosted: { inspect } as never,
        approver: { authenticate: async () => ({ kind: "authenticated" as const,
          principal: { organizationId: "org_1", actorId: "member_1", scopes: ["run:read"] } }) } },
    });
    const response = await application.fetch(new Request(
      "http://control.test/v1/source-thread-controls/runs/run_1/status?organizationId=org_1",
      { headers: { authorization: "Bearer opaque" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "waiting_for_runner",
      queueClaimDeadline: "2026-08-30T00:02:00.000Z" });
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("reports provider delivery failure as a sibling projection", async () => {
    const settlement = { outcome: "outcome_unknown" as const,
      errorCode: "delivery_restart_after_begin" as const };
    const worker = createProviderDeliveryWorker({ kernel: {
      recoverStrandedBegun: async () => 0,
      deliverNext: async () => settlement as never,
    }, preloadSourceApps: async () => ({ registered: 1, healthy: [], failures: [] }),
    clock: { now: () => new Date("2026-08-30T00:00:00.000Z") } });
    await expect(worker.processNext()).resolves.toEqual({
      kind: "delivered", recovered: 0, failures: [], result: settlement,
      providerDelivery: { state: "outcome_unknown", reasonCode: "delivery_restart_after_begin" },
    });
  });
});
