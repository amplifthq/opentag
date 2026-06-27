import type { ContextPacket, OpenTagEvent, OpenTagRun } from "@opentag/core";
import { createEchoExecutor } from "@opentag/runner";
import { describe, expect, it, vi } from "vitest";
import { runOneDaemonIteration, serveDaemon } from "../src/daemon.js";

const run: OpenTagRun = {
  id: "run_1",
  eventId: "evt_1",
  status: "assigned",
  assignedRunnerId: "runner_1",
  contextPacket: {
    summary: "Fix the issue from the source thread.",
    sourcePointers: [],
    exclusions: ["Do not touch unrelated files."]
  },
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

const slackEvent: OpenTagEvent = {
  ...event,
  id: "evt_slack_1",
  source: "slack",
  actor: { provider: "slack", providerUserId: "U456", handle: "U456", organizationId: "T123" },
  callback: { provider: "slack", uri: "https://slack.com/api/chat.postMessage", threadKey: "T123|C123|1710000000.000100" },
  metadata: { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" }
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
        async heartbeat(runId) {
          calls.push(`heartbeat:${runId}`);
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
        async heartbeat() {
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

  it("exits the daemon loop when the abort signal is triggered while idle", async () => {
    const abortController = new AbortController();
    let claimCount = 0;

    const daemonPromise = serveDaemon({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: { echo: createEchoExecutor() },
      pollIntervalMs: 10_000,
      signal: abortController.signal,
      client: {
        async claim() {
          claimCount += 1;
          abortController.abort();
          return null;
        },
        async markRunning() {
          throw new Error("should not run");
        },
        async heartbeat() {
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

    await expect(daemonPromise).resolves.toBeUndefined();
    expect(claimCount).toBe(1);
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
        async heartbeat() {
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
        async heartbeat() {
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

  it("resolves Slack events against the mapped repository provider", async () => {
    const calls: string[] = [];
    await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: { echo: createEchoExecutor() },
      client: {
        async claim() {
          return { run, event: slackEvent };
        },
        async markRunning(runId, executor) {
          calls.push(`running:${runId}:${executor}`);
        },
        async heartbeat() {
          return;
        },
        async progress() {
          return;
        },
        async complete(runId, result) {
          calls.push(`complete:${runId}:${result.conclusion}`);
        }
      }
    });

    expect(calls).toEqual(["running:run_1:echo", "complete:run_1:success"]);
  });

  it("sends heartbeats while a long-running executor is active", async () => {
    const calls: string[] = [];
    await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: {
        echo: {
          id: "echo",
          displayName: "Echo",
          async canRun() {
            return { ready: true };
          },
          async run(_input, sink) {
            await sink.emit({
              type: "executor.started",
              message: "long task",
              at: "2026-06-24T00:00:00.000Z"
            });
            await new Promise((resolve) => setTimeout(resolve, 25));
            return { conclusion: "success", summary: "done" };
          },
          async cancel() {
            return;
          }
        }
      },
      heartbeatIntervalMs: 5,
      client: {
        async claim() {
          return { run, event };
        },
        async markRunning(runId, executor) {
          calls.push(`running:${runId}:${executor}`);
        },
        async heartbeat(runId) {
          calls.push(`heartbeat:${runId}`);
        },
        async progress(runId, input) {
          calls.push(`progress:${runId}:${input.type}:${input.message}`);
        },
        async complete(runId, result) {
          calls.push(`complete:${runId}:${result.conclusion}:${result.summary}`);
        }
      }
    });

    expect(calls.some((call) => call === "heartbeat:run_1")).toBe(true);
    expect(calls.at(-1)).toBe("complete:run_1:success:done");
  });

  it("completes the run as failed when the executor throws after markRunning", async () => {
    const calls: string[] = [];

    const didWork = await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: {
        echo: {
          id: "echo",
          displayName: "Echo",
          async canRun() {
            return { ready: true };
          },
          async run() {
            throw new Error("executor exploded");
          },
          async cancel() {
            return;
          }
        }
      },
      heartbeatIntervalMs: 0,
      client: {
        async claim() {
          calls.push("claim");
          return { run, event };
        },
        async markRunning(runId, executor) {
          calls.push(`running:${runId}:${executor}`);
        },
        async heartbeat() {
          throw new Error("should not run");
        },
        async progress() {
          return;
        },
        async complete(runId, result) {
          calls.push(`complete:${runId}:${result.conclusion}:${result.summary}`);
        }
      }
    });

    expect(didWork).toBe(true);
    expect(calls).toEqual(["claim", "running:run_1:echo", "complete:run_1:failure:Echo failed: executor exploded"]);
  });

  it("completes the run as failed when post-run pull request creation throws", async () => {
    const calls: string[] = [];

    await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
      executors: {
        echo: {
          id: "echo",
          displayName: "Echo",
          async canRun() {
            return { ready: true };
          },
          async run() {
            return { conclusion: "success", summary: "done", changedFiles: ["src/app.ts"] };
          },
          async cancel() {
            return;
          }
        }
      },
      pullRequestOptions: {
        githubToken: "token",
        allowAutoCreatePullRequest: true,
        commandRunner: {
          async run() {
            throw new Error("git exploded");
          }
        }
      },
      client: {
        async claim() {
          return {
            run,
            event: {
              ...event,
              permissions: [...event.permissions, { scope: "pr:create", reason: "create pull request" }]
            }
          };
        },
        async markRunning(runId, executor) {
          calls.push(`running:${runId}:${executor}`);
        },
        async heartbeat() {
          return;
        },
        async progress() {
          return;
        },
        async complete(runId, result) {
          calls.push(`complete:${runId}:${result.conclusion}:${result.summary}`);
        }
      }
    });

    expect(calls).toEqual([
      "running:run_1:echo",
      "complete:run_1:failure:Post-run pull request hook failed: git exploded"
    ]);
  });

  it("logs and continues the daemon loop after an iteration-level failure", async () => {
    const abortController = new AbortController();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let claimCount = 0;

    try {
      await serveDaemon({
        runnerId: "runner_1",
        repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" }],
        executors: { echo: createEchoExecutor() },
        pollIntervalMs: 1,
        signal: abortController.signal,
        client: {
          async claim() {
            claimCount += 1;
            if (claimCount === 1) {
              throw new Error("dispatcher temporarily unavailable");
            }
            abortController.abort();
            return null;
          },
          async markRunning() {
            throw new Error("should not run");
          },
          async heartbeat() {
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
      expect(claimCount).toBe(2);
      expect(warn).toHaveBeenCalledWith("OpenTag daemon iteration failed; retrying:", expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it("passes the run context packet into executor input", async () => {
    let seenPacket: ContextPacket | undefined;
    const localRun: OpenTagRun = {
      ...run,
      contextPacket: {
        summary: "Fix the issue from the source thread.",
        sourcePointers: [],
        exclusions: ["Do not touch unrelated files."]
      }
    };

    await runOneDaemonIteration({
      runnerId: "runner_1",
      executors: {
        capture: {
          id: "capture",
          displayName: "Capture Executor",
          async canRun(input) {
            seenPacket = input.contextPacket;
            return { ready: true };
          },
          async run(input) {
            seenPacket = input.contextPacket;
            return { conclusion: "success", summary: "captured" };
          },
          async cancel() {
            return;
          }
        }
      },
      client: {
        async claim() {
          return {
            run: localRun,
            event: {
              ...event,
              permissions: [
                ...event.permissions,
                { scope: "repo:write", reason: "write branch" }
              ]
            }
          };
        },
        async markRunning() {
          return;
        },
        async heartbeat() {
          return;
        },
        async progress() {
          return;
        },
        async complete() {
          return;
        }
      },
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo", defaultExecutor: "capture" }]
    });

    expect(seenPacket?.summary).toBe("Fix the issue from the source thread.");
    expect(seenPacket?.exclusions).toEqual(["Do not touch unrelated files."]);
  });
});
