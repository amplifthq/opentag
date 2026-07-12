import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import type { ExecutorAdapter, ExecutorRunInput } from "@opentag/runner";
import { runOneDaemonIteration, type DaemonClient } from "../src/daemon.js";

function event(input: { id: string; project?: { provider: string; owner: string; repo: string } }): OpenTagEvent {
  return {
    id: input.id,
    source: "slack",
    sourceEventId: `source_${input.id}`,
    receivedAt: "2026-07-12T00:00:00.000Z",
    actor: { provider: "slack", providerUserId: "user_1", handle: "alice" },
    target: { mention: "@opentag", agentId: "opentag", executorHint: "reviewer" },
    command: { rawText: "summarize the discussion", intent: "run", args: {} },
    context: [],
    permissions: [{ scope: "repo:write", reason: "Allow the configured local agent to work in its isolated attempt workspace." }],
    callback: { provider: "slack", uri: "https://example.com/callback" },
    metadata: {
      teamId: "T123",
      channelId: "C456",
      ...(input.project
        ? { repoProvider: input.project.provider, owner: input.project.owner, repo: input.project.repo }
        : {})
    }
  };
}

function claimed(input: { event: OpenTagEvent; attemptId?: string }) {
  const run: OpenTagRun = {
    id: "run_acp",
    eventId: input.event.id,
    status: "assigned",
    assignedRunnerId: "runner_local",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z"
  };
  return {
    run,
    event: input.event,
    attemptId: input.attemptId ?? "attempt_01J_TEST",
    attemptNumber: 1,
    fencingToken: "fence_1"
  };
}

function clientFor(input: {
  claimed: ReturnType<typeof claimed>;
  progress?: DaemonClient["progress"];
  completed: OpenTagRunResult[];
}): DaemonClient {
  return {
    claim: async () => input.claimed,
    markRunning: async () => {},
    heartbeat: async () => {},
    progress: input.progress ?? (async () => {}),
    complete: async (_runId, _lease, result) => {
      input.completed.push(result);
    }
  };
}

function recordingExecutor(input: {
  runs: ExecutorRunInput[];
  cancellations?: Array<{ runId: string; attemptId: string | undefined }>;
  result?: OpenTagRunResult;
  emitProgress?: boolean;
}): ExecutorAdapter {
  return {
    id: "reviewer",
    displayName: "Review Agent",
    async canRun(run) {
      expect(existsSync(run.workspace?.path ?? "")).toBe(true);
      return { ready: true };
    },
    async run(run, sink) {
      input.runs.push(run);
      if (input.emitProgress) {
        await sink.emit({ type: "executor.progress", message: "working", at: "2026-07-12T00:00:01.000Z" });
      }
      return input.result ?? { conclusion: "success", summary: "done" };
    },
    async cancel(runId, attemptId) {
      input.cancellations?.push({ runId, attemptId });
    }
  };
}

describe("ACP daemon workspaces", () => {
  it("passes an explicit repository workspace to a repository-targeted ACP run", async () => {
    const runs: ExecutorRunInput[] = [];
    const completed: OpenTagRunResult[] = [];
    const targetEvent = event({ id: "evt_repo", project: { provider: "github", owner: "acme", repo: "demo" } });

    await runOneDaemonIteration({
      runnerId: "runner_local",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: tmpdir(), defaultExecutor: "reviewer" }],
      executors: { reviewer: recordingExecutor({ runs }) },
      scratchRoot: join(mkdtempSync(join(tmpdir(), "opentag-scratch-root-")), "scratch"),
      heartbeatIntervalMs: 0,
      client: clientFor({ claimed: claimed({ event: targetEvent }), completed })
    });

    expect(runs[0]).toMatchObject({
      attemptId: "attempt_01J_TEST",
      workspace: { kind: "repository", path: tmpdir() }
    });
    expect("workspacePath" in (runs[0] ?? {})).toBe(false);
    expect(completed[0]?.conclusion).toBe("success");
  });

  it("creates an attempt-scoped scratch workspace and removes it after success", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "opentag-scratch-root-")), "scratch");
    const runs: ExecutorRunInput[] = [];
    const completed: OpenTagRunResult[] = [];
    const scratchEvent = event({ id: "evt_scratch" });

    await runOneDaemonIteration({
      runnerId: "runner_local",
      repositories: [],
      executors: { reviewer: recordingExecutor({ runs }) },
      scratchRoot: root,
      keepScratch: "on_failure",
      heartbeatIntervalMs: 0,
      client: clientFor({ claimed: claimed({ event: scratchEvent }), completed })
    });

    expect(runs[0]?.workspace).toMatchObject({ kind: "scratch" });
    expect(runs[0]?.attemptId).toBe("attempt_01J_TEST");
    expect(runs[0]?.workspace?.path.startsWith(`${root}/`)).toBe(true);
    expect(existsSync(runs[0]?.workspace?.path ?? "")).toBe(false);
    expect(completed[0]?.conclusion).toBe("success");
  });

  it("preserves scratch evidence after failure", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "opentag-scratch-root-")), "scratch");
    const runs: ExecutorRunInput[] = [];
    const completed: OpenTagRunResult[] = [];

    await runOneDaemonIteration({
      runnerId: "runner_local",
      repositories: [],
      executors: {
        reviewer: recordingExecutor({ runs, result: { conclusion: "failure", summary: "agent failed" } })
      },
      scratchRoot: root,
      keepScratch: "on_failure",
      heartbeatIntervalMs: 0,
      client: clientFor({ claimed: claimed({ event: event({ id: "evt_failed_scratch" }) }), completed })
    });

    expect(existsSync(runs[0]?.workspace?.path ?? "")).toBe(true);
    expect(completed[0]?.conclusion).toBe("failure");
  });

  it("fails closed when an explicit repository target is not allowlisted", async () => {
    const runs: ExecutorRunInput[] = [];
    const completed: OpenTagRunResult[] = [];
    const targetEvent = event({ id: "evt_unbound", project: { provider: "github", owner: "acme", repo: "private" } });

    await runOneDaemonIteration({
      runnerId: "runner_local",
      repositories: [],
      executors: { reviewer: recordingExecutor({ runs }) },
      scratchRoot: join(mkdtempSync(join(tmpdir(), "opentag-scratch-root-")), "scratch"),
      client: clientFor({ claimed: claimed({ event: targetEvent }), completed })
    });

    expect(runs).toEqual([]);
    expect(completed[0]).toMatchObject({ conclusion: "needs_human" });
    expect(completed[0]?.summary).toContain("allowlist");
  });

  it("cancels only the stale ACP attempt and never completes it", async () => {
    const runs: ExecutorRunInput[] = [];
    const cancellations: Array<{ runId: string; attemptId: string | undefined }> = [];
    const completed: OpenTagRunResult[] = [];
    const staleProgress = vi.fn(async () => {
      throw new Error('progress failed: 409 {"error":"stale_attempt"}');
    });

    await runOneDaemonIteration({
      runnerId: "runner_local",
      repositories: [],
      executors: { reviewer: recordingExecutor({ runs, cancellations, emitProgress: true }) },
      scratchRoot: join(mkdtempSync(join(tmpdir(), "opentag-scratch-root-")), "scratch"),
      heartbeatIntervalMs: 0,
      client: clientFor({
        claimed: claimed({ event: event({ id: "evt_stale" }), attemptId: "attempt_A" }),
        progress: staleProgress,
        completed
      })
    });

    expect(cancellations).toEqual([{ runId: "run_acp", attemptId: "attempt_A" }]);
    expect(completed).toEqual([]);
  });
});
