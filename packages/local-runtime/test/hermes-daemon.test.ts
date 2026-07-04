import { describe, expect, it } from "vitest";
import type { OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import { createHermesExecutor, type CommandRunner } from "@opentag/runner";
import { runOneDaemonIteration, type DaemonClient } from "../src/daemon.js";

function eventWithMetadata(source: string, metadata: Record<string, unknown>): OpenTagEvent {
  return {
    id: `evt_${source}`,
    source,
    sourceEventId: `source_${source}`,
    receivedAt: "2026-06-29T00:00:00.000Z",
    actor: { provider: source, providerUserId: "user_1", handle: "octocat" },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: "fix this", intent: "fix", args: {} },
    context: [],
    permissions: [{ scope: "repo:write", reason: "Hermes needs to edit the local checkout for this run." }],
    callback: { provider: source, uri: "https://example.com/callback" },
    metadata
  };
}

function runForEvent(input: { event: OpenTagEvent; profileTemplate: string }) {
  const calls: { command: string; args: string[] }[] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      const joinedArgs = args.join(" ");

      if (command === "hermes" && args.includes("--version")) {
        return { exitCode: 0, stdout: "1.0.0", stderr: "" };
      }
      if (command === "git" && joinedArgs === "status --porcelain") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && joinedArgs === "-c core.quotePath=false status --porcelain -z") {
        return calls.some((call) => call.command === "hermes" && call.args.includes("-z"))
          ? { exitCode: 0, stdout: " M src/demo.ts\0", stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "checkout") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "hermes" && joinedArgs.startsWith("profile show ")) {
        return { exitCode: 1, stdout: "", stderr: "profile not found" };
      }
      if (command === "hermes" && joinedArgs.startsWith("profile create ")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "hermes" && args.includes("-z")) {
        return { exitCode: 0, stdout: "done", stderr: "" };
      }

      return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
    }
  };
  const run: OpenTagRun = {
    id: `run_${input.event.source}`,
    eventId: input.event.id,
    status: "assigned",
    assignedRunnerId: "runner_local",
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z"
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
        defaultExecutor: "hermes",
        baseBranch: "main",
        pushRemote: "origin",
        keepWorktree: "on_failure"
      }
    ],
    executors: {
      hermes: createHermesExecutor({ runner, profileTemplate: input.profileTemplate })
    },
    client
  }).then(() => ({ calls, completed }));
}

describe("Hermes daemon integration", () => {
  it.each([
    {
      source: "slack",
      metadata: { teamId: "T123", channelId: "C456", repoProvider: "github", owner: "acme", repo: "demo" },
      profileTemplate: "opentag-{provider}-{accountId}-{conversationId}",
      expectedProfile: "opentag-slack-t123-c456"
    },
    {
      source: "github",
      metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 1 },
      profileTemplate: "opentag-{provider}-{repoProvider}-{owner}-{repo}-{issueNumber}",
      expectedProfile: "opentag-github-github-acme-demo-1"
    },
    {
      source: "telegram",
      metadata: { botId: "bot_123", chatId: "456", repoProvider: "github", owner: "acme", repo: "demo" },
      profileTemplate: "opentag-{provider}-{accountId}-{conversationId}",
      expectedProfile: "opentag-telegram-bot_123-456"
    }
  ])("selects an isolated Hermes profile for $source events", async ({ source, metadata, profileTemplate, expectedProfile }) => {
    const { calls, completed } = await runForEvent({
      event: eventWithMetadata(source, metadata),
      profileTemplate
    });

    const hermesCall = calls.find((call) => call.command === "hermes" && call.args.includes("-z"));
    expect(hermesCall, JSON.stringify({ calls, completed })).toBeDefined();
    expect(hermesCall?.args).toContain("-p");
    expect(hermesCall?.args).toContain(expectedProfile);
    expect(completed?.conclusion).toBe("success");
  });
});
