import { describe, expect, it } from "vitest";
import { createSlackEventProcessor, type SlackThreadActionInput } from "../src/events.js";

function repoFreeProcessor(submitted: SlackThreadActionInput[]) {
  return createSlackEventProcessor({
    async resolveChannelBinding() {
      return { teamId: "T123", channelId: "C123" };
    },
    async createRun() {
      return { runId: "run_unused" };
    },
    async submitThreadAction(action) {
      submitted.push(action);
    },
    now: () => "2026-07-13T00:00:00.000Z"
  });
}

function expectRepoFreeMetadata(metadata: Record<string, unknown>): void {
  expect(metadata).not.toHaveProperty("repoProvider");
  expect(metadata).not.toHaveProperty("owner");
  expect(metadata).not.toHaveProperty("repo");
}

describe("Slack thread action metadata", () => {
  it("omits repository metadata for a button action in a repository-free channel", async () => {
    const submitted: SlackThreadActionInput[] = [];

    await repoFreeProcessor(submitted).process(
      {
        type: "block_actions",
        api_app_id: "A123",
        team: { id: "T123" },
        user: { id: "U456", username: "alice" },
        channel: { id: "C123" },
        message: { ts: "1719187200.000500", thread_ts: "1719187200.000100" },
        trigger_id: "trigger_apply_1",
        actions: [
          {
            type: "button",
            action_id: "opentag:apply:1",
            value: JSON.stringify({ version: 1, command: "apply 1", proposalId: "proposal_1", intentId: "intent_1" })
          }
        ]
      },
      { agentId: "opentag" }
    );

    expect(submitted).toHaveLength(1);
    expectRepoFreeMetadata(submitted[0]!.metadata);
  });

  it("omits repository metadata for a message action in a repository-free channel", async () => {
    const submitted: SlackThreadActionInput[] = [];

    await repoFreeProcessor(submitted).process(
      {
        type: "event_callback",
        team_id: "T123",
        event_id: "EvApply1",
        event: {
          type: "message",
          user: "U456",
          text: "apply 1",
          ts: "1719187200.000500",
          thread_ts: "1719187200.000100",
          channel: "C123"
        }
      },
      { agentId: "opentag" }
    );

    expect(submitted).toHaveLength(1);
    expectRepoFreeMetadata(submitted[0]!.metadata);
  });
});
