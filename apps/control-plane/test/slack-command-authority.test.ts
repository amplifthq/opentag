import { describe, expect, it, vi } from "vitest";
import { createControlPlaneSourceThreadAuthority } from "../src/modules/slack-ingress/authority.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const authorityEnvelope = {
  organizationId: "org_1", installationId: "install_1", bindingId: "binding_1",
  sourceThreadId: "C1:1700000000.1", runId: "run_1", pendingRequestId: "permission_1",
  approvalEpoch: "1", runnerId: "runner_1", attemptId: "attempt_1", attemptNumber: 1,
  attemptEpoch: 1, fencingTokenDigest: digest("a"), permissionRequestDigest: digest("b"),
  actionId: "pending_action_1", actionDescriptorDigest: digest("c"),
  frozenCeilingDigest: digest("d"), policyDigest: digest("e"), actionTokenIdentity: digest("f"),
  selectedDecision: "allow_once" as const, allowedDecisions: ["allow_once" as const]
};

describe("production Source Thread command authority", () => {
  it("maps the exact authority envelope into a coordinator-revalidated permission decision", async () => {
    const resolve = vi.fn(async () => ({ kind: "resolved" as const, receipt: { ok: true } }));
    const authority = createControlPlaneSourceThreadAuthority({
      hosted: { inspect: vi.fn(), cancelRun: vi.fn() } as any,
      permissions: { resolve } as any, clock: { now: () => new Date("2026-08-30T00:00:00.000Z") }
    });
    await expect(authority.approve({ type: "approve", commandId: "decision_1",
      actor: { provider: "slack", id: "U_APPROVER" }, requestId: "permission_1",
      decision: "allow_once", authority: authorityEnvelope })).resolves.toMatchObject({ outcome: "completed" });
    expect(resolve).toHaveBeenCalledWith({ principal: { organizationId: "org_1", actorId: "U_APPROVER" },
      runnerId: "runner_1", authorityAttemptEpoch: 1,
      decision: expect.objectContaining({ organizationId: "org_1", runId: "run_1",
        permissionRequestId: "permission_1", permissionRequestDigest: digest("b"),
        policySnapshotDigest: digest("e"), actionId: "pending_action_1",
        attempt: { attemptId: "attempt_1", attemptNumber: 1, epoch: 1,
          fencingTokenDigest: digest("a") }, decision: "allow_once" }) });
  });

  it("fails closed for request mismatch and unsupported allow-for-run semantics", async () => {
    const resolve = vi.fn();
    const authority = createControlPlaneSourceThreadAuthority({
      hosted: {} as any, permissions: { resolve } as any, clock: { now: () => new Date() } });
    await expect(authority.approve({ type: "approve", commandId: "mismatch",
      actor: { provider: "slack", id: "U" }, requestId: "other", decision: "allow_once",
      authority: authorityEnvelope })).resolves.toEqual({ outcome: "rejected", reason: "authority_invalid" });
    await expect(authority.approve({ type: "approve", commandId: "allow_run",
      actor: { provider: "slack", id: "U" }, requestId: "permission_1", decision: "allow_run",
      authority: { ...authorityEnvelope, selectedDecision: "allow_run",
        allowedDecisions: ["allow_run"] } })).resolves.toEqual({ outcome: "rejected",
        reason: "allow_run_not_supported" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects selected or allowed decision tampering before the permission writer", async () => {
    const resolve = vi.fn();
    const authority = createControlPlaneSourceThreadAuthority({ hosted: {} as any,
      permissions: { resolve } as any, clock: { now: () => new Date() } });
    for (const tampered of [
      { ...authorityEnvelope, selectedDecision: "deny" as const,
        allowedDecisions: ["allow_once" as const, "deny" as const] },
      { ...authorityEnvelope, selectedDecision: "allow_once" as const,
        allowedDecisions: ["deny" as const] }
    ]) {
      await expect(authority.approve({ type: "approve", commandId: "tampered",
        actor: { provider: "slack", id: "U" }, requestId: "permission_1",
        decision: "allow_once", authority: tampered })).resolves.toEqual({
          outcome: "rejected", reason: "authority_invalid" });
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});
