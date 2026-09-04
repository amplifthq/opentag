import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenTagEvent, OpenTagRunResult } from "@opentag/core";
import type { ExecutorAdapter, ExecutorRunInput } from "@opentag/runner";
import { describe, expect, it, vi } from "vitest";
import {
  executeClaimedRun,
  type ClaimedRun,
  type ClaimedRunExecutionClient,
} from "../src/daemon.js";

function claimed(id: string): ClaimedRun {
  const event: OpenTagEvent = {
    id: `evt_${id}`,
    source: "slack",
    sourceEventId: `Ev${id}`,
    receivedAt: "2026-08-10T00:00:00.000Z",
    actor: { provider: "slack", providerUserId: "U123", handle: "alice", organizationId: "T123" },
    target: { mention: "@opentag", agentId: "opentag", executorHint: "reviewer" },
    command: { rawText: "inspect this", intent: "run", args: {} },
    context: [],
    permissions: [],
    callback: { provider: "slack", uri: "https://slack.com/api/chat.postMessage" },
    metadata: { teamId: "T123", channelId: "C123" },
  };
  return {
    run: {
      id: `run_${id}`,
      eventId: event.id,
      status: "assigned",
      assignedRunnerId: "runner_local",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
    event,
    attemptId: `attempt_${id}`,
    attemptNumber: 1,
    fencingToken: `fence_${id}`,
  };
}

function lifecycle() {
  const complete = vi.fn(async () => {});
  const requestActionPermission = vi.fn<ClaimedRunExecutionClient["requestActionPermission"]>();
  const resolveActionPermission = vi.fn<ClaimedRunExecutionClient["resolveActionPermission"]>();
  const recordMaterialActionReceipt = vi.fn<ClaimedRunExecutionClient["recordMaterialActionReceipt"]>();
  const client: ClaimedRunExecutionClient = {
    markRunning: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
    progress: vi.fn(async () => {}),
    complete,
    requestActionPermission,
    resolveActionPermission,
    recordMaterialActionReceipt,
  };
  return { client, complete, requestActionPermission, resolveActionPermission, recordMaterialActionReceipt };
}

function scratchRoot(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `opentag-authority-${label}-`)), "scratch");
}

describe("claimed Run execution authority", () => {
  it("cancels before executor start when the supplied authority is no longer current", async () => {
    const authoritativeClaim = claimed("stale_before_start");
    const run = vi.fn(async () => ({ conclusion: "success" as const, summary: "must not run" }));
    const cancel = vi.fn(async () => {});
    const executor: ExecutorAdapter = {
      id: "reviewer",
      displayName: "Reviewer",
      async canRun() { return { ready: true }; },
      run,
      cancel,
    };
    const state = lifecycle();

    await executeClaimedRun({
      runnerId: "runner_local",
      claimed: authoritativeClaim,
      repositories: [],
      executors: { reviewer: executor },
      scratchRoot: scratchRoot("stale"),
      heartbeatIntervalMs: 0,
      hostedExecutionAuthority: {
        leaseExpiresAt: "2099-08-10T00:00:00.000Z",
        assertCurrent: async () => false,
      },
      client: state.client,
    });

    expect(run).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("run_stale_before_start", "attempt_stale_before_start");
    expect(state.complete).not.toHaveBeenCalled();
    expect("claim" in state.client).toBe(false);
  });

  it("cancels at the immutable local lease deadline without completing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const authoritativeClaim = claimed("deadline");
    const cancel = vi.fn(async () => {});
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const executor: ExecutorAdapter = {
      id: "reviewer",
      displayName: "Reviewer",
      async canRun() { return { ready: true }; },
      async run() {
        started();
        return new Promise<OpenTagRunResult>(() => {});
      },
      cancel,
    };
    const state = lifecycle();
    try {
      const execution = executeClaimedRun({
        runnerId: "runner_local",
        claimed: authoritativeClaim,
        repositories: [],
        executors: { reviewer: executor },
        scratchRoot: scratchRoot("deadline"),
        heartbeatIntervalMs: 0,
        hostedExecutionAuthority: {
          leaseExpiresAt: "2026-08-10T00:00:01.000Z",
          assertCurrent: async () => true,
          now: () => new Date(),
        },
        client: state.client,
      });
      await didStart;
      await vi.advanceTimersByTimeAsync(999);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await execution;
    } finally {
      vi.useRealTimers();
    }

    expect(cancel).toHaveBeenCalledWith("run_deadline", "attempt_deadline");
    expect(state.complete).not.toHaveBeenCalled();
  });

  it("extends the local deadline only from an accepted heartbeat lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const authoritativeClaim = claimed("renewed");
    const cancel = vi.fn(async () => {});
    let acceptedLease = "2026-08-10T00:00:01.000Z";
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const executor: ExecutorAdapter = {
      id: "reviewer",
      displayName: "Reviewer",
      async canRun() { return { ready: true }; },
      async run() {
        started();
        return new Promise<OpenTagRunResult>(() => {});
      },
      cancel,
    };
    const state = lifecycle();
    state.client.heartbeat = vi.fn(async () => {
      acceptedLease = "2026-08-10T00:00:02.000Z";
    });
    try {
      const execution = executeClaimedRun({
        runnerId: "runner_local",
        claimed: authoritativeClaim,
        repositories: [],
        executors: { reviewer: executor },
        scratchRoot: scratchRoot("renewed"),
        heartbeatIntervalMs: 100,
        hostedExecutionAuthority: {
          leaseExpiresAt: acceptedLease,
          assertCurrent: async () => true,
          readAcceptedLeaseExpiresAt: async () => acceptedLease,
          now: () => new Date(),
        },
        client: state.client,
      });
      await didStart;
      await vi.advanceTimersByTimeAsync(1_999);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await execution;
    } finally {
      vi.useRealTimers();
    }

    expect(state.client.heartbeat).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(state.complete).not.toHaveBeenCalled();
  });

  it("latches authority revocation across permission and material callbacks", async () => {
    const authoritativeClaim = claimed("revoked");
    const current = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const cancel = vi.fn(async () => {});
    const executor: ExecutorAdapter = {
      id: "reviewer",
      displayName: "Reviewer",
      async canRun() { return { ready: true }; },
      async run(input: ExecutorRunInput) {
        await expect(input.permissionResolver?.({
          toolCallId: "tool_revoked",
          title: "Publish",
          provider: "acp",
          permissionScopes: ["report:publish"],
        })).resolves.toMatchObject({ decision: "deny" });
        await expect(input.materialActionReporter?.({
          actionId: "action_revoked",
          toolCallId: "tool_revoked",
          provider: "acp",
          receiptRef: "acp:revoked",
          outcome: "unknown",
        })).rejects.toThrow("hosted_execution_authority_expired");
        return { conclusion: "success", summary: "must not settle" };
      },
      cancel,
    };
    const state = lifecycle();

    await executeClaimedRun({
      runnerId: "runner_local",
      claimed: authoritativeClaim,
      repositories: [],
      executors: { reviewer: executor },
      scratchRoot: scratchRoot("revoked"),
      heartbeatIntervalMs: 0,
      hostedExecutionAuthority: {
        leaseExpiresAt: "2099-08-10T00:00:00.000Z",
        assertCurrent: current,
      },
      client: state.client,
    });

    expect(state.requestActionPermission).not.toHaveBeenCalled();
    expect(state.resolveActionPermission).not.toHaveBeenCalled();
    expect(state.recordMaterialActionReceipt).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("run_revoked", "attempt_revoked");
    expect(state.complete).not.toHaveBeenCalled();
  });
});
