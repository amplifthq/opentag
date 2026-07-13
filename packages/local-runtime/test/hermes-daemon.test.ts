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

function runForEvent(input: { event: OpenTagEvent; profile: string; profileReady?: boolean }) {
  const calls: { command: string; args: string[] }[] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      const joinedArgs = args.join(" ");

      if (command === "hermes" && args.includes("--version")) {
        return input.profileReady === false
          ? { exitCode: 1, stdout: "", stderr: `Profile '${input.profile}' does not exist` }
          : { exitCode: 0, stdout: "Hermes Agent v0.18.2 (2026.7.7.2)", stderr: "" };
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
    claim: async () => ({ run, event: input.event, attemptId: "attempt_1", attemptNumber: 1, fencingToken: "fence_1" }),
    markRunning: async () => {},
    heartbeat: async () => {},
    progress: async () => {},
    complete: async (_runId, _lease, result) => {
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
      hermes: createHermesExecutor({ runner, profile: input.profile })
    },
    client
  }).then(() => ({ calls, completed }));
}

describe("Hermes daemon integration", () => {
  it.each([
    {
      source: "slack",
      metadata: { teamId: "T123", channelId: "C456", repoProvider: "github", owner: "acme", repo: "demo" },
      derivedProfile: "opentag-slack-T123-C456"
    },
    {
      source: "github",
      metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 1 },
      derivedProfile: "opentag-github-github-acme-demo-1"
    },
    {
      source: "telegram",
      metadata: { botId: "bot_123", chatId: "456", repoProvider: "github", owner: "acme", repo: "demo" },
      derivedProfile: "opentag-telegram-bot_123-456"
    }
  ])("uses the same fixed Hermes profile for $source events", async ({ source, metadata, derivedProfile }) => {
    const { calls, completed } = await runForEvent({
      event: eventWithMetadata(source, metadata),
      profile: "opentag"
    });

    const hermesCall = calls.find((call) => call.command === "hermes" && call.args.includes("-z"));
    expect(hermesCall, JSON.stringify({ calls, completed })).toBeDefined();
    expect(hermesCall?.args.slice(0, 3)).toEqual(["-p", "opentag", "-z"]);
    expect(hermesCall?.args).not.toContain(derivedProfile);
    expect(completed?.conclusion).toBe("success");
  });

  it("fails closed before invocation when the fixed Hermes profile does not exist", async () => {
    const { calls, completed } = await runForEvent({
      event: eventWithMetadata("slack", {
        teamId: "T123",
        channelId: "C456",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }),
      profile: "opentag-missing",
      profileReady: false
    });

    expect(calls).toContainEqual({ command: "hermes", args: ["-p", "opentag-missing", "--version"] });
    expect(calls.some((call) => call.command === "hermes" && call.args.includes("-z"))).toBe(false);
    expect(completed).toEqual({
      conclusion: "needs_human",
      summary:
        "Hermes profile 'opentag-missing' is not ready: Profile 'opentag-missing' does not exist " +
        "Create it with `hermes profile create opentag-missing` or configure daemon.hermes.profile to an existing dedicated profile."
    });
  });

});
