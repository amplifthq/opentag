import type { OpenTagEvent, OpenTagRun } from "@opentag/core";
import type { ExecutorAdapter, ExecutorRunInput } from "@opentag/runner";
import { describe, expect, it } from "vitest";
import { runOneDaemonIteration } from "../src/daemon.js";

const run: OpenTagRun = {
  id: "run_1",
  eventId: "evt_slack_1",
  status: "assigned",
  assignedRunnerId: "runner_1",
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z"
};

const slackEvent: OpenTagEvent = {
  id: "evt_slack_1",
  source: "slack",
  sourceEventId: "EvSlack",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "slack", providerUserId: "U456", handle: "U456", organizationId: "T123" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix", args: {} },
  context: [],
  permissions: [{ scope: "repo:write", reason: "edit the local checkout" }],
  callback: { provider: "slack", uri: "https://slack.com/api/chat.postMessage", threadKey: "T123|C123|1710000000.000100" },
  metadata: { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" }
};

describe("daemon agent session profile", () => {
  it("passes a generic agent session profile to the selected executor", async () => {
    let canRunInput: ExecutorRunInput | undefined;
    let runInput: ExecutorRunInput | undefined;
    const captureExecutor: ExecutorAdapter = {
      id: "capture",
      displayName: "Capture",
      async canRun(input) {
        canRunInput = input;
        return { ready: true };
      },
      async run(input) {
        runInput = input;
        return { conclusion: "success", summary: "captured" };
      },
      async cancel() {}
    };

    await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [{ provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo", defaultExecutor: "capture" }],
      executors: { capture: captureExecutor },
      agentSessionProfile: {
        profileTemplate: "agent-{provider}-{projectTarget}-{actorId}"
      },
      client: {
        async claim() {
          return { run, event: slackEvent, attemptId: "attempt_1", attemptNumber: 1, fencingToken: "fence_1" };
        },
        async markRunning() {},
        async heartbeat() {},
        async progress() {},
        async complete() {}
      }
    });

    expect(canRunInput?.sessionProfile).toMatchObject({
      id: "agent-slack-github-acme-demo-U456",
      sourceProvider: "slack",
      projectTarget: "github:acme/demo",
      accountId: "T123",
      conversationId: "C123",
      actorId: "U456"
    });
    expect(runInput?.sessionProfile).toEqual(canRunInput?.sessionProfile);
  });
});
