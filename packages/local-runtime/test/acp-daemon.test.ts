import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ActionPermissionResolution,
  MaterialActionReceipt,
  OpenTagEvent,
  OpenTagRunResult,
} from "@opentag/core";
import type { ExecutorAdapter, ExecutorRunInput } from "@opentag/runner";
import { describe, expect, it, vi } from "vitest";
import {
  executeClaimedRun,
  type ClaimedRun,
  type ClaimedRunExecutionClient,
} from "../src/daemon.js";

function event(input: { id: string; permissions?: OpenTagEvent["permissions"] }): OpenTagEvent {
  return {
    id: input.id,
    source: "slack",
    sourceEventId: `source_${input.id}`,
    receivedAt: "2026-07-12T00:00:00.000Z",
    actor: { provider: "slack", providerUserId: "U123", handle: "alice", organizationId: "T123" },
    target: { mention: "@opentag", agentId: "opentag", executorHint: "reviewer" },
    command: { rawText: "summarize the discussion", intent: "run", args: {} },
    context: [],
    permissions: input.permissions ?? [],
    callback: { provider: "slack", uri: "https://slack.com/api/chat.postMessage" },
    metadata: { teamId: "T123", channelId: "C123" },
  };
}

function claimed(sourceEvent: OpenTagEvent, attemptId = "attempt_acp"): ClaimedRun {
  return {
    run: {
      id: "run_acp",
      eventId: sourceEvent.id,
      status: "assigned",
      assignedRunnerId: "runner_local",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    },
    event: sourceEvent,
    attemptId,
    attemptNumber: 1,
    fencingToken: "fence_acp",
  };
}

function lifecycle(overrides: Partial<ClaimedRunExecutionClient> = {}) {
  const completed: OpenTagRunResult[] = [];
  const progress: Array<{ type: string; message: string }> = [];
  const client: ClaimedRunExecutionClient = {
    markRunning: vi.fn(async () => {}),
    rejectAttemptStart: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
    progress: vi.fn(async (_runId, _lease, item) => { progress.push(item); }),
    complete: vi.fn(async (_runId, _lease, result) => { completed.push(result); }),
    requestActionPermission: vi.fn(async () => { throw new Error("unexpected permission request"); }),
    resolveActionPermission: vi.fn(async () => { throw new Error("unexpected permission resolution"); }),
    recordMaterialActionReceipt: vi.fn(async () => { throw new Error("unexpected material receipt"); }),
    ...overrides,
  };
  return { client, completed, progress };
}

function scratchAttemptPath(root: string, attemptId: string): string {
  const segment = createHash("sha256").update(attemptId).digest("hex").slice(0, 24);
  return join(root, `attempt-${segment}`);
}

function action(status: "waiting_approval" | "authorized" | "executing" = "authorized") {
  return {
    id: "action_publish",
    runId: "run_acp",
    attemptId: "attempt_acp",
    actionFamily: "publish",
    capability: "publish",
    scope: { permissionScopes: ["report:publish"] },
    target: { title: "Publish report" },
    riskTier: "high" as const,
    status,
    idempotencyKey: "action:publish",
    attemptFenceDigest: "digest",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

describe("claimed ACP execution", () => {
  it("preserves the external Attempt fence across lifecycle calls without claiming", async () => {
    const sourceEvent = event({ id: "evt_fence" });
    const authoritativeClaim = {
      ...claimed(sourceEvent, "attempt_external"),
      fencingToken: "fence_external",
    };
    const scratchRoot = join(mkdtempSync(join(tmpdir(), "opentag-acp-fence-")), "scratch");
    const observed: Array<{ operation: string; runId: string; lease: { attemptId: string; fencingToken: string } }> = [];
    const record = (operation: string, runId: string, lease: { attemptId: string; fencingToken: string }) => {
      observed.push({ operation, runId, lease: { ...lease } });
    };
    const client: ClaimedRunExecutionClient = {
      async markRunning(runId, _executorId, lease) { record("running", runId, lease); },
      async heartbeat(runId, lease) { record("heartbeat", runId, lease); },
      async progress(runId, lease) { record("progress", runId, lease); },
      async complete(runId, lease) { record("complete", runId, lease); },
      async requestActionPermission() { throw new Error("unexpected permission request"); },
      async resolveActionPermission() { throw new Error("unexpected permission resolution"); },
      async recordMaterialActionReceipt() { throw new Error("unexpected material receipt"); },
    };
    const executor: ExecutorAdapter = {
      id: "reviewer",
      displayName: "Reviewer",
      async canRun(input) {
        expect(existsSync(input.workspace?.path ?? "")).toBe(true);
        return { ready: true };
      },
      async run(_input, sink) {
        await sink.emit({ type: "executor.progress", message: "working", at: "2026-07-12T00:00:01.000Z" });
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { conclusion: "success", summary: "done" };
      },
      async cancel() {},
    };

    await executeClaimedRun({
      runnerId: "runner_local",
      claimed: authoritativeClaim,
      repositories: [],
      executors: { reviewer: executor },
      scratchRoot,
      heartbeatIntervalMs: 1,
      client,
    });

    expect(observed.map((item) => item.operation)).toEqual(
      expect.arrayContaining(["running", "heartbeat", "progress", "complete"]),
    );
    expect(observed.every((item) => item.runId === "run_acp")).toBe(true);
    expect(observed.every((item) => item.lease.attemptId === "attempt_external" && item.lease.fencingToken === "fence_external")).toBe(true);
    expect("claim" in client).toBe(false);
    expect(existsSync(scratchAttemptPath(scratchRoot, "attempt_external"))).toBe(false);
  });

  it("cleans a newly created scratch workspace when readiness rejects the Attempt", async () => {
    const sourceEvent = event({ id: "evt_unready" });
    const authoritativeClaim = claimed(sourceEvent);
    const scratchRoot = join(mkdtempSync(join(tmpdir(), "opentag-acp-unready-")), "scratch");
    const run = vi.fn(async () => ({ conclusion: "success" as const, summary: "must not run" }));
    const rejectAttemptStart = vi.fn(async () => {});
    const state = lifecycle({ rejectAttemptStart });
    const executor: ExecutorAdapter = {
      id: "reviewer",
      displayName: "Reviewer",
      async canRun() { return { ready: false, reason: "local login unavailable" }; },
      run,
      async cancel() {},
    };

    await executeClaimedRun({
      runnerId: "runner_local",
      claimed: authoritativeClaim,
      repositories: [],
      executors: { reviewer: executor },
      scratchRoot,
      heartbeatIntervalMs: 0,
      client: state.client,
    });

    expect(rejectAttemptStart).toHaveBeenCalledWith(
      "run_acp",
      "reviewer",
      "local login unavailable",
      { attemptId: "attempt_acp", fencingToken: "fence_acp" },
    );
    expect(run).not.toHaveBeenCalled();
    expect(state.client.markRunning).not.toHaveBeenCalled();
    expect(existsSync(scratchAttemptPath(scratchRoot, "attempt_acp"))).toBe(false);
  });

  it("preserves scratch evidence when execution fails", async () => {
    const sourceEvent = event({ id: "evt_failed_scratch" });
    const scratchRoot = join(mkdtempSync(join(tmpdir(), "opentag-acp-failed-")), "scratch");
    const state = lifecycle();
    const executor: ExecutorAdapter = {
      id: "reviewer",
      displayName: "Reviewer",
      async canRun() { return { ready: true }; },
      async run() { return { conclusion: "failure", summary: "failed with evidence" }; },
      async cancel() {},
    };

    await executeClaimedRun({
      runnerId: "runner_local",
      claimed: claimed(sourceEvent),
      repositories: [],
      executors: { reviewer: executor },
      scratchRoot,
      keepScratch: "on_failure",
      heartbeatIntervalMs: 0,
      client: state.client,
    });

    expect(state.completed[0]).toEqual({ conclusion: "failure", summary: "failed with evidence" });
    expect(existsSync(scratchAttemptPath(scratchRoot, "attempt_acp"))).toBe(true);
  });

  it("cancels and records a timed-out Attempt", async () => {
    vi.useFakeTimers();
    const sourceEvent = event({ id: "evt_timeout" });
    const authoritativeClaim = claimed(sourceEvent);
    const cancel = vi.fn(async () => {});
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
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
        scratchRoot: join(mkdtempSync(join(tmpdir(), "opentag-acp-timeout-")), "scratch"),
        heartbeatIntervalMs: 0,
        runTimeoutMs: 1_000,
        client: state.client,
      });
      await running;
      await vi.advanceTimersByTimeAsync(1_000);
      await execution;
    } finally {
      vi.useRealTimers();
    }

    expect(cancel).toHaveBeenCalledWith("run_acp", "attempt_acp");
    expect(state.completed[0]).toMatchObject({
      conclusion: "timed_out",
      summary: "Reviewer exceeded the configured hard timeout of 1 second(s).",
    });
    expect(state.client.markRunning).toHaveBeenCalledWith(
      "run_acp",
      "reviewer",
      { attemptId: "attempt_acp", fencingToken: "fence_acp" },
      expect.objectContaining({ runTimeoutMs: 1_000 }),
    );
  });

  it("waits for durable permission and records the executor report as untrusted", async () => {
    const waitingAction = action("waiting_approval");
    const authorizedAction = action("authorized");
    const requestActionPermission = vi.fn(async (): Promise<ActionPermissionResolution> => ({
      state: "waiting",
      action: waitingAction,
    }));
    const resolveActionPermission = vi.fn(async (): Promise<ActionPermissionResolution> => ({
      state: "authorized",
      action: authorizedAction,
      decision: "allow_run",
    }));
    const receipts: MaterialActionReceipt[] = [];
    const recordMaterialActionReceipt = vi.fn(async (_runId, _lease, _actionId, receipt: MaterialActionReceipt): Promise<ActionPermissionResolution> => {
      receipts.push(receipt);
      return { state: "unknown", action: { ...authorizedAction, status: "unknown", receipt }, receipt };
    });
    const executor: ExecutorAdapter = {
      id: "reviewer",
      displayName: "Reviewer",
      async canRun() { return { ready: true }; },
      async run(input) {
        await expect(input.permissionResolver?.({
          toolCallId: "tool_publish",
          title: "Publish report",
          provider: "acp",
          permissionScopes: ["report:publish"],
        })).resolves.toMatchObject({ actionId: "action_publish", decision: "allow_run", material: true });
        await input.materialActionReporter?.({
          actionId: "action_publish",
          toolCallId: "tool_publish",
          provider: "acp",
          receiptRef: "acp:session:tool_publish",
          outcome: "unknown",
          reportedOutcome: "completed",
        });
        return { conclusion: "success", summary: "done" };
      },
      async cancel() {},
    };
    const state = lifecycle({ requestActionPermission, resolveActionPermission, recordMaterialActionReceipt });

    await executeClaimedRun({
      runnerId: "runner_local",
      claimed: claimed(event({ id: "evt_permission" })),
      repositories: [],
      executors: { reviewer: executor },
      scratchRoot: join(mkdtempSync(join(tmpdir(), "opentag-acp-permission-")), "scratch"),
      heartbeatIntervalMs: 0,
      client: state.client,
    });

    expect(requestActionPermission).toHaveBeenCalledTimes(1);
    expect(resolveActionPermission).toHaveBeenCalledTimes(1);
    expect(receipts).toEqual([expect.objectContaining({
      provider: "acp",
      outcome: "unknown",
      receiptRef: "acp:session:tool_publish",
      metadata: expect.objectContaining({ assurance: "reported", agentReportedOutcome: "completed" }),
    })]);
    expect(state.completed).toEqual([{ conclusion: "success", summary: "done" }]);
  });

  it("records a trusted provider receipt instead of promoting an ACP self-report", async () => {
    const authorizedAction = action("executing");
    const trustedReceipt: MaterialActionReceipt = {
      id: "receipt_provider",
      actionId: "action_publish",
      provider: "github",
      receiptRef: "github:pull_request:17",
      outcome: "succeeded",
      observedAt: "2026-07-12T00:02:00.000Z",
      metadata: { assurance: "trusted_provider", providerOperationId: "github-op-17" },
    };
    const recorded: MaterialActionReceipt[] = [];
    const requestActionPermission = vi.fn(async (): Promise<ActionPermissionResolution> => ({
      state: "authorized",
      action: authorizedAction,
      decision: "allow_once",
    }));
    const recordMaterialActionReceipt = vi.fn(async (_runId, _lease, _actionId, receipt: MaterialActionReceipt): Promise<ActionPermissionResolution> => {
      recorded.push(receipt);
      return { state: "reconciled", action: { ...authorizedAction, status: "succeeded", receipt }, decision: "deny", receipt };
    });
    const executor: ExecutorAdapter = {
      id: "reviewer",
      displayName: "Reviewer",
      async canRun() { return { ready: true }; },
      async run(input) {
        await input.permissionResolver?.({
          toolCallId: "tool_publish",
          title: "Publish report",
          provider: "acp",
          permissionScopes: ["report:publish"],
        });
        await input.materialActionReporter?.({
          actionId: "action_publish",
          toolCallId: "tool_publish",
          provider: "acp",
          receiptRef: "acp:session:tool_publish",
          outcome: "unknown",
          reportedOutcome: "completed",
        });
        return { conclusion: "success", summary: "done" };
      },
      async cancel() {},
    };
    const state = lifecycle({ requestActionPermission, recordMaterialActionReceipt });

    await executeClaimedRun({
      runnerId: "runner_local",
      claimed: claimed(event({ id: "evt_trusted_receipt" })),
      repositories: [],
      executors: { reviewer: executor },
      scratchRoot: join(mkdtempSync(join(tmpdir(), "opentag-acp-trusted-")), "scratch"),
      heartbeatIntervalMs: 0,
      trustedMaterialActionReceipt: async () => trustedReceipt,
      client: state.client,
    });

    expect(recorded).toEqual([trustedReceipt]);
    expect(JSON.stringify(recorded)).not.toContain("acp:session");
  });

  it("sanitizes progress, final output, logs, and the active fencing token", async () => {
    const providerToken = ["xoxb", "0000000000", "fixture-redaction-token-only"].join("-");
    const activeFence = "fence_acp";
    const logged: unknown[][] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => { logged.push(args); });
    const state = lifecycle();
    const executor: ExecutorAdapter = {
      id: "reviewer",
      displayName: "Reviewer",
      async canRun() { return { ready: true }; },
      async run(_input: ExecutorRunInput, sink) {
        await sink.emit({
          type: "executor.progress",
          message: `progress ${providerToken} ${activeFence}`,
          at: "2026-07-12T00:00:01.000Z",
        });
        return { conclusion: "success", summary: `result ${providerToken} ${activeFence}` };
      },
      async cancel() {},
    };
    try {
      await executeClaimedRun({
        runnerId: "runner_local",
        claimed: claimed(event({ id: "evt_redaction" })),
        repositories: [],
        executors: { reviewer: executor },
        scratchRoot: join(mkdtempSync(join(tmpdir(), "opentag-acp-redaction-")), "scratch"),
        heartbeatIntervalMs: 0,
        client: state.client,
      });
    } finally {
      log.mockRestore();
    }

    const serialized = JSON.stringify({ progress: state.progress, completed: state.completed, logged });
    expect(serialized).not.toContain(providerToken);
    expect(serialized).not.toContain(activeFence);
    expect(serialized).toContain("[redacted]");
  });
});
