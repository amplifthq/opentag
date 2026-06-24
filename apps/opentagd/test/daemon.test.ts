import type { OpenTagEvent, OpenTagRun } from "@opentag/core";
import { createEchoExecutor } from "@opentag/runner";
import { describe, expect, it } from "vitest";
import { runOneDaemonIteration } from "../src/daemon.js";

const run: OpenTagRun = {
  id: "run_1",
  eventId: "evt_1",
  status: "assigned",
  assignedRunnerId: "runner_1",
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z"
};

const event: OpenTagEvent = {
  id: "evt_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix", args: {} },
  context: [],
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

describe("opentagd", () => {
  it("claims a run and completes it with echo executor", async () => {
    const calls: string[] = [];

    await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: { echo: createEchoExecutor() },
      client: {
        async claim() {
          calls.push("claim");
          return { run, event };
        },
        async markRunning(runId, executor) {
          calls.push(`running:${runId}:${executor}`);
        },
        async progress(runId, input) {
          calls.push(`progress:${runId}:${input.type}:${input.message}`);
        },
        async complete(runId, result) {
          calls.push(`complete:${runId}:${result.conclusion}:${result.summary}`);
        }
      }
    });

    expect(calls).toEqual([
      "claim",
      "running:run_1:echo",
      "progress:run_1:executor.started:Echo executor started for run_1",
      "progress:run_1:executor.completed:Echo executor completed for run_1",
      "complete:run_1:success:Echoed OpenTag command: fix this"
    ]);
  });

  it("returns false when no work is available", async () => {
    const didWork = await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: { echo: createEchoExecutor() },
      client: {
        async claim() {
          return null;
        },
        async markRunning() {
          throw new Error("should not run");
        },
        async progress() {
          throw new Error("should not run");
        },
        async complete() {
          throw new Error("should not run");
        }
      }
    });

    expect(didWork).toBe(false);
  });

  it("refuses to execute when the repo has no local workspace mapping", async () => {
    const calls: string[] = [];
    const didWork = await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [],
      executors: { echo: createEchoExecutor() },
      client: {
        async claim() {
          return { run, event };
        },
        async markRunning() {
          throw new Error("should not run");
        },
        async progress() {
          throw new Error("should not run");
        },
        async complete(runId, result) {
          calls.push(`complete:${runId}:${result.conclusion}:${result.summary}`);
        }
      }
    });

    expect(didWork).toBe(true);
    expect(calls).toEqual([
      "complete:run_1:needs_human:No local workspace mapping is configured for this run's repository."
    ]);
  });

  it("refuses to execute when the configured executor is unavailable locally", async () => {
    const calls: string[] = [];
    const didWork = await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo", defaultExecutor: "codex" }],
      executors: { echo: createEchoExecutor() },
      client: {
        async claim() {
          return { run, event };
        },
        async markRunning() {
          throw new Error("should not run");
        },
        async progress() {
          throw new Error("should not run");
        },
        async complete(runId, result) {
          calls.push(`complete:${runId}:${result.conclusion}:${result.summary}`);
        }
      }
    });

    expect(didWork).toBe(true);
    expect(calls).toEqual(["complete:run_1:needs_human:No local executor is configured for 'codex'."]);
  });
});
