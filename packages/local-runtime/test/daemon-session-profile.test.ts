import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenTagEvent } from "@opentag/core";
import type { ExecutorAdapter, ExecutorRunInput } from "@opentag/runner";
import { describe, expect, it, vi } from "vitest";
import {
  executeClaimedRun,
  type ClaimedRunExecutionClient,
} from "../src/daemon.js";

const slackEvent: OpenTagEvent = {
  id: "evt_slack_profile",
  source: "slack",
  sourceEventId: "EvSlackProfile",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "slack", providerUserId: "U456", handle: "U456", organizationId: "T123" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix", args: {} },
  context: [],
  permissions: [{ scope: "repo:write", reason: "edit the local checkout" }],
  callback: { provider: "slack", uri: "https://slack.com/api/chat.postMessage", threadKey: "T123|C123|1710000000.000100" },
  metadata: { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" },
};

function lifecycleClient(): ClaimedRunExecutionClient {
  return {
    markRunning: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
    progress: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    requestActionPermission: vi.fn(async () => { throw new Error("unexpected permission request"); }),
    resolveActionPermission: vi.fn(async () => { throw new Error("unexpected permission resolution"); }),
    recordMaterialActionReceipt: vi.fn(async () => { throw new Error("unexpected material receipt"); }),
  };
}

describe("claimed Run agent session profile", () => {
  it("passes one resolved profile to readiness and execution", async () => {
    let canRunInput: ExecutorRunInput | undefined;
    let runInput: ExecutorRunInput | undefined;
    const executor: ExecutorAdapter = {
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
      async cancel() {},
    };
    const client = lifecycleClient();

    await executeClaimedRun({
      runnerId: "runner_1",
      claimed: {
        run: {
          id: "run_profile",
          eventId: slackEvent.id,
          status: "assigned",
          assignedRunnerId: "runner_1",
          createdAt: "2026-06-24T00:00:00.000Z",
          updatedAt: "2026-06-24T00:00:00.000Z",
        },
        event: slackEvent,
        attemptId: "attempt_profile",
        attemptNumber: 1,
        fencingToken: "fence_profile",
      },
      repositories: [{
        projectTargetId: "target_1",
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: mkdtempSync(join(tmpdir(), "opentag-profile-")),
        defaultExecutor: "capture",
      }],
      executors: { capture: executor },
      agentSessionProfile: {
        profileTemplate: "agent-{provider}-{projectTarget}-{actorId}",
      },
      heartbeatIntervalMs: 0,
      client,
    });

    expect(canRunInput?.sessionProfile).toMatchObject({
      id: "agent-slack-github-acme-demo-U456",
      sourceProvider: "slack",
      projectTarget: "github:acme/demo",
      accountId: "T123",
      conversationId: "C123",
      actorId: "U456",
    });
    expect(runInput?.sessionProfile).toEqual(canRunInput?.sessionProfile);
    expect("claim" in client).toBe(false);
  });
});
