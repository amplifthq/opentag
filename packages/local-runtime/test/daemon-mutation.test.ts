import { describe, expect, it, vi } from "vitest";
import type { OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import type { ExecutorAdapter } from "@opentag/runner";
import { runOneDaemonIteration, type DaemonClient } from "../src/daemon.js";

function mutationEvent(rawText: string): OpenTagEvent {
  return {
    id: "evt_mutation",
    source: "linear",
    sourceEventId: "comment_mutation",
    receivedAt: "2026-06-30T00:00:00.000Z",
    actor: { provider: "linear", providerUserId: "user_1", handle: "alice" },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText, intent: "run", args: {} },
    context: [],
    permissions: [{ scope: "issue:comment", reason: "mutation test" }],
    callback: { provider: "linear", uri: "linear://issue/issue_1/comments", threadKey: "ENG|issue|ENG-1" },
    metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueId: "issue_1" }
  };
}

function runMutationEvent(input: { event: OpenTagEvent; executor: ExecutorAdapter }) {
  const run: OpenTagRun = {
    id: "run_mutation",
    eventId: input.event.id,
    status: "assigned",
    assignedRunnerId: "runner_local",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z"
  };
  let completed: OpenTagRunResult | undefined;
  const client: DaemonClient = {
    claim: async () => ({ run, event: input.event }),
    markRunning: async () => {},
    heartbeat: async () => {},
    progress: async () => {},
    complete: async (_runId, result) => {
      completed = result;
    }
  };

  return runOneDaemonIteration({
    runnerId: "runner_local",
    repositories: [
      {
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        defaultExecutor: "echo",
        baseBranch: "main",
        pushRemote: "origin",
        keepWorktree: "on_failure"
      }
    ],
    executors: { echo: input.executor },
    client
  }).then(() => completed);
}

function echoExecutor(): ExecutorAdapter {
  return {
    id: "echo",
    displayName: "Echo",
    canRun: vi.fn(async () => ({ ready: true })),
    run: vi.fn(async () => ({ conclusion: "success" as const, summary: "should not run" })),
    cancel: vi.fn()
  };
}

describe("daemon work-context mutation compilation", () => {
  it("completes pure mutation commands with a proposal instead of starting an executor", async () => {
    const executor = echoExecutor();
    const completed = await runMutationEvent({
      event: mutationEvent("set this issue's priority to High"),
      executor
    });

    expect(executor.run).not.toHaveBeenCalled();
    expect(completed).toMatchObject({
      conclusion: "needs_human",
      suggestedChanges: [
        {
          proposalId: "proposal_run_mutation",
          intents: [
            {
              intentId: "proposal_run_mutation_priority_1",
              domain: "priority",
              action: "set_priority",
              params: { priority: "High" }
            }
          ]
        }
      ]
    });
    expect(String(completed?.nextAction)).toContain("apply 1");
  });

  it("compiles multi-clause mutation commands into one proposal with ordered intents", async () => {
    const executor = echoExecutor();
    const completed = await runMutationEvent({
      event: mutationEvent("set status to In Progress and assign to alice and add label bug"),
      executor
    });

    expect(executor.run).not.toHaveBeenCalled();
    expect(completed?.suggestedChanges?.[0]?.intents).toMatchObject([
      { action: "set_status", params: { status: "In Progress" } },
      { action: "set_assignee", params: { assignee: "alice" } },
      { action: "set_labels", params: { label: "bug" } }
    ]);
  });

  it("still routes mixed requests to the executor", async () => {
    const executor = echoExecutor();
    const completed = await runMutationEvent({
      event: mutationEvent("fix the flaky login test and set priority to High"),
      executor
    });

    expect(executor.run).toHaveBeenCalledTimes(1);
    expect(completed).toMatchObject({ conclusion: "success" });
  });
});
