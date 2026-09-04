import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenTagEvent, OpenTagRunResult } from "@opentag/core";
import type { ExecutorAdapter } from "@opentag/runner";
import { describe, expect, it, vi } from "vitest";
import {
  executeClaimedRun,
  type ClaimedRun,
  type ClaimedRunExecutionClient,
} from "../src/daemon.js";

function eventWithExecutorHint(executorHint?: string): OpenTagEvent {
  return {
    id: "evt_slack_selection",
    source: "slack",
    sourceEventId: "EvSlackSelection",
    receivedAt: "2026-06-29T00:00:00.000Z",
    actor: { provider: "slack", providerUserId: "U123", handle: "alice", organizationId: "T123" },
    target: { mention: "@opentag", agentId: "opentag", ...(executorHint ? { executorHint } : {}) },
    command: { rawText: "fix this", intent: "fix", args: {} },
    context: [],
    permissions: [{ scope: "repo:write", reason: "edit the bound checkout" }],
    callback: { provider: "slack", uri: "https://slack.com/api/chat.postMessage" },
    metadata: { teamId: "T123", channelId: "C456", repoProvider: "github", owner: "acme", repo: "demo" },
  };
}

function claimed(event: OpenTagEvent, executorId?: string): ClaimedRun {
  return {
    run: {
      id: "run_selection",
      eventId: event.id,
      status: "assigned",
      assignedRunnerId: "runner_local",
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z",
    },
    event,
    attemptId: "attempt_selection",
    attemptNumber: 1,
    fencingToken: "fence_selection",
    ...(executorId ? { executorId } : {}),
  };
}

function lifecycle() {
  const completed: OpenTagRunResult[] = [];
  const rejected: string[] = [];
  const client: ClaimedRunExecutionClient = {
    markRunning: vi.fn(async () => {}),
    rejectAttemptStart: vi.fn(async (_runId, _executorId, reason) => { rejected.push(reason); }),
    heartbeat: vi.fn(async () => {}),
    progress: vi.fn(async () => {}),
    complete: vi.fn(async (_runId, _lease, result) => { completed.push(result); }),
    requestActionPermission: vi.fn(async () => { throw new Error("unexpected permission request"); }),
    resolveActionPermission: vi.fn(async () => { throw new Error("unexpected permission resolution"); }),
    recordMaterialActionReceipt: vi.fn(async () => { throw new Error("unexpected material receipt"); }),
  };
  return { client, completed, rejected };
}

function recordingExecutor(id: string, ran: string[]): ExecutorAdapter {
  return {
    id,
    displayName: id,
    async canRun() { return { ready: true }; },
    async run() {
      ran.push(id);
      return { conclusion: "success", summary: `ran:${id}` };
    },
    async cancel() {},
  };
}

async function execute(input: { hint?: string; placement?: string; defaultExecutor: string }) {
  const ran: string[] = [];
  const state = lifecycle();
  const sourceEvent = eventWithExecutorHint(input.hint);
  const checkoutPath = mkdtempSync(join(tmpdir(), "opentag-selection-"));
  await executeClaimedRun({
    runnerId: "runner_local",
    claimed: claimed(sourceEvent, input.placement),
    repositories: [{
      projectTargetId: "target_1",
      provider: "github",
      owner: "acme",
      repo: "demo",
      checkoutPath,
      defaultExecutor: input.defaultExecutor,
    }],
    executors: {
      codex: recordingExecutor("codex", ran),
      "claude-code": recordingExecutor("claude-code", ran),
      openclaw: recordingExecutor("openclaw", ran),
    },
    heartbeatIntervalMs: 0,
    client: state.client,
  });
  return { ran, ...state };
}

describe("claimed Run executor selection", () => {
  it("uses the authoritative placement before the source hint and binding default", async () => {
    const result = await execute({ placement: "codex", hint: "openclaw", defaultExecutor: "claude-code" });
    expect(result.ran).toEqual(["codex"]);
    expect(result.completed[0]).toMatchObject({ conclusion: "success", summary: "ran:codex" });
  });

  it("uses the source hint when placement is absent", async () => {
    const result = await execute({ hint: "openclaw", defaultExecutor: "claude-code" });
    expect(result.ran).toEqual(["openclaw"]);
  });

  it("falls back to the binding default when placement and hint are absent", async () => {
    const result = await execute({ defaultExecutor: "claude-code" });
    expect(result.ran).toEqual(["claude-code"]);
  });

  it("rejects an authoritative placement that is unavailable locally", async () => {
    const result = await execute({ placement: "hermes", hint: "openclaw", defaultExecutor: "claude-code" });
    expect(result.ran).toEqual([]);
    expect(result.rejected).toEqual(["No local executor is configured for 'hermes'."]);
    expect(result.completed).toEqual([]);
  });

  it("cancels the exact Attempt when progress loses its fence", async () => {
    const sourceEvent = eventWithExecutorHint("openclaw");
    const authoritativeClaim = claimed(sourceEvent);
    const cancel = vi.fn(async () => {});
    const complete = vi.fn(async () => {});
    const executor: ExecutorAdapter = {
      id: "openclaw",
      displayName: "OpenClaw",
      async canRun() { return { ready: true }; },
      async run(_input, sink) {
        await sink.emit({ type: "executor.progress", message: "late", at: "2026-06-29T00:00:01.000Z" });
        return { conclusion: "success", summary: "must not settle" };
      },
      cancel,
    };
    const state = lifecycle();
    state.client.progress = vi.fn(async () => { throw new Error("progress failed: 409 stale_attempt"); });
    state.client.complete = complete;

    await executeClaimedRun({
      runnerId: "runner_local",
      claimed: authoritativeClaim,
      repositories: [{
        projectTargetId: "target_1",
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: mkdtempSync(join(tmpdir(), "opentag-stale-selection-")),
        defaultExecutor: "openclaw",
      }],
      executors: { openclaw: executor },
      heartbeatIntervalMs: 0,
      client: state.client,
    });

    expect(cancel).toHaveBeenCalledWith("run_selection", "attempt_selection");
    expect(complete).not.toHaveBeenCalled();
    expect("claim" in state.client).toBe(false);
  });
});
