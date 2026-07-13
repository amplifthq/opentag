import { describe, expect, it } from "vitest";
import type { OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import { createExecutorRunResult, type ExecutorAdapter } from "@opentag/runner";
import { runOneDaemonIteration, type DaemonClient } from "../src/daemon.js";

function eventWithExecutorHint(executorHint?: string): OpenTagEvent {
  return {
    id: "evt_slack",
    source: "slack",
    sourceEventId: "source_slack",
    receivedAt: "2026-06-29T00:00:00.000Z",
    actor: { provider: "slack", providerUserId: "user_1", handle: "octocat" },
    target: { mention: "@opentag", agentId: "opentag", ...(executorHint ? { executorHint } : {}) },
    command: { rawText: "fix this", intent: "fix", args: {} },
    context: [],
    permissions: [{ scope: "repo:write", reason: "The executor needs to edit the local checkout for this run." }],
    callback: { provider: "slack", uri: "https://example.com/callback" },
    metadata: { teamId: "T123", channelId: "C456", repoProvider: "github", owner: "acme", repo: "demo" }
  };
}

function recordingExecutor(id: string, ran: string[]): ExecutorAdapter {
  return {
    id,
    displayName: `${id} recording executor`,
    async canRun() {
      return { ready: true };
    },
    async run(input) {
      ran.push(id);
      return createExecutorRunResult({
        executorName: id,
        runId: input.runId,
        branchName: `opentag/${input.runId}`,
        output: `ran:${id}`,
        changedFiles: []
      });
    },
    async cancel() {
      return;
    }
  };
}

async function iterate(input: { event: OpenTagEvent; defaultExecutor: string }) {
  const ran: string[] = [];
  const run: OpenTagRun = {
    id: "run_selection",
    eventId: input.event.id,
    status: "assigned",
    assignedRunnerId: "runner_local",
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z"
  };
  let completed: OpenTagRunResult | undefined;
  const client: DaemonClient = {
    claim: async () => ({ run, event: input.event, attemptId: "attempt_1", attemptNumber: 1, fencingToken: "fence_1" }),
    markRunning: async () => {},
    heartbeat: async () => {},
    progress: async () => {},
    complete: async (_runId, _lease, result) => {
      completed = result;
    }
  };

  await runOneDaemonIteration({
    runnerId: "runner_local",
    repositories: [
      {
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        defaultExecutor: input.defaultExecutor,
        baseBranch: "main",
        pushRemote: "origin",
        keepWorktree: "on_failure"
      }
    ],
    executors: {
      "claude-code": recordingExecutor("claude-code", ran),
      openclaw: recordingExecutor("openclaw", ran)
    },
    client
  });

  return { ran, completed };
}

describe("daemon executor selection", () => {
  it("prefers the source-thread executor hint over the binding default", async () => {
    const { ran, completed } = await iterate({
      event: eventWithExecutorHint("openclaw"),
      defaultExecutor: "claude-code"
    });

    expect(ran).toEqual(["openclaw"]);
    expect(completed?.conclusion).toBe("success");
  });

  it("falls back to the binding default executor when no hint is provided", async () => {
    const { ran, completed } = await iterate({
      event: eventWithExecutorHint(undefined),
      defaultExecutor: "claude-code"
    });

    expect(ran).toEqual(["claude-code"]);
    expect(completed?.conclusion).toBe("success");
  });

  it("reports needs_human when the hinted executor is not registered locally", async () => {
    const { ran, completed } = await iterate({
      event: eventWithExecutorHint("hermes"),
      defaultExecutor: "claude-code"
    });

    expect(ran).toEqual([]);
    expect(completed?.conclusion).toBe("needs_human");
    expect(completed?.summary).toContain("hermes");
  });

  it("cancels the executor when progress is rejected as a stale attempt", async () => {
    const event = eventWithExecutorHint("openclaw");
    const run: OpenTagRun = {
      id: "run_stale_attempt",
      eventId: event.id,
      status: "assigned",
      assignedRunnerId: "runner_local",
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z"
    };
    let cancelled = 0;
    let completed = 0;
    const executor: ExecutorAdapter = {
      id: "openclaw",
      displayName: "OpenClaw",
      async canRun() {
        return { ready: true };
      },
      async run(_input, sink) {
        await sink.emit({ type: "executor.progress", message: "late update", at: "2026-06-29T00:00:01.000Z" });
        return { conclusion: "success", summary: "late completion" };
      },
      async cancel() {
        cancelled += 1;
      }
    };
    const client: DaemonClient = {
      claim: async () => ({ run, event, attemptId: "attempt_stale", attemptNumber: 1, fencingToken: "fence_stale" }),
      markRunning: async () => {},
      heartbeat: async () => {},
      progress: async () => {
        throw new Error('progress failed: 409 {"error":"stale_attempt"}');
      },
      complete: async () => {
        completed += 1;
      }
    };

    await expect(
      runOneDaemonIteration({
        runnerId: "runner_local",
        repositories: [
          { provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo", defaultExecutor: "openclaw" }
        ],
        executors: { openclaw: executor },
        heartbeatIntervalMs: 0,
        client
      })
    ).resolves.toBe(true);
    expect(cancelled).toBe(1);
    expect(completed).toBe(0);
  });
});
