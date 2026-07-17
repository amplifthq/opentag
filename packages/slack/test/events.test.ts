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

describe("Slack event_id dedup", () => {
  function dedupProcessor(input: { runs: string[] }) {
    return createSlackEventProcessor({
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      async createRun() {
        input.runs.push("run_created");
        return { runId: "run_1" };
      },
      now: () => "2026-07-16T00:00:00.000Z"
    });
  }

  function mentionPayload(eventId: string) {
    return {
      type: "event_callback" as const,
      team_id: "T123",
      event_id: eventId,
      authorizations: [{ user_id: "UBOT" }],
      event: {
        type: "app_mention" as const,
        channel: "C123",
        user: "U456",
        text: "<@UBOT> fix the bug",
        ts: "1719187200.000100"
      }
    };
  }

  it("drops a duplicate delivery of the same event_id and runs the handler only once", async () => {
    const runs: string[] = [];
    const processor = dedupProcessor({ runs });

    const first = await processor.process(mentionPayload("EvDup1"), { agentId: "opentag" });
    const second = await processor.process(mentionPayload("EvDup1"), { agentId: "opentag" });

    expect(first.body).toMatchObject({ ok: true });
    expect(first.body).not.toHaveProperty("ignored", "duplicate_event");
    expect(second.body).toEqual({ ok: true, ignored: "duplicate_event" });
    expect(runs).toHaveLength(1);
  });

  it("processes two different event_ids independently (no false dedup)", async () => {
    const runs: string[] = [];
    const processor = dedupProcessor({ runs });

    const first = await processor.process(mentionPayload("EvDup2"), { agentId: "opentag" });
    const second = await processor.process(mentionPayload("EvDup3"), { agentId: "opentag" });

    expect(first.body).toMatchObject({ ok: true });
    expect(second.body).toMatchObject({ ok: true });
    expect(second.body).not.toHaveProperty("ignored", "duplicate_event");
    expect(runs).toHaveLength(2);
  });
});

describe("Slack /linear self-service command", () => {
  type Reply = { channelId: string; threadTs: string; text: string; textFormat?: "mrkdwn" };

  function linearProcessor(input: {
    replies: Reply[];
    runs: string[];
    linearCalls?: number[];
    linearReply?: string | { text: string; textFormat?: "mrkdwn" };
    withLinearHandler?: boolean;
  }) {
    return createSlackEventProcessor({
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      async createRun() {
        input.runs.push("run_created");
        return { runId: "run_1" };
      },
      async reply(reply) {
        input.replies.push({
          channelId: reply.channelId,
          threadTs: reply.threadTs,
          text: reply.text,
          ...(reply.textFormat ? { textFormat: reply.textFormat } : {})
        });
      },
      ...(input.withLinearHandler === false
        ? {}
        : {
            async linear() {
              input.linearCalls?.push(1);
              return input.linearReply ?? "OpenTag project backlog — 1 open issue";
            }
          }),
      now: () => "2026-07-16T00:00:00.000Z"
    });
  }

  function mentionEvent(text: string) {
    return {
      type: "event_callback" as const,
      team_id: "T123",
      event_id: "EvLinear1",
      authorizations: [{ user_id: "UBOT" }],
      event: {
        type: "app_mention" as const,
        channel: "C123",
        user: "U456",
        text,
        ts: "1719187200.000100"
      }
    };
  }

  it.each(["<@UBOT> linear", "<@UBOT> /linear", "<@UBOT> LINEAR", "<@UBOT>  /Linear  "])(
    "replies with the backlog and does not create a run for %j",
    async (text) => {
      const replies: Reply[] = [];
      const runs: string[] = [];
      const linearCalls: number[] = [];

      const result = await linearProcessor({ replies, runs, linearCalls }).process(mentionEvent(text), { agentId: "opentag" });

      expect(result.body).toMatchObject({ ok: true, selfService: "linear" });
      expect(linearCalls).toHaveLength(1);
      expect(runs).toHaveLength(0);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ channelId: "C123", threadTs: "1719187200.000100" });
      expect(replies[0]!.text).toContain("OpenTag project backlog");
    }
  );

  it("replies usage for /linear with extra arguments and does not create a run", async () => {
    const replies: Reply[] = [];
    const runs: string[] = [];
    const linearCalls: number[] = [];

    const result = await linearProcessor({ replies, runs, linearCalls }).process(
      mentionEvent("<@UBOT> /linear something else"),
      { agentId: "opentag" }
    );

    expect(result.body).toMatchObject({ ok: true, selfService: "linear", usage: true });
    expect(linearCalls).toHaveLength(0);
    expect(runs).toHaveLength(0);
    expect(replies[0]!.text).toContain("Usage");
  });

  it("does NOT intercept a bare linear mention with extra words (normal run flow)", async () => {
    const replies: Reply[] = [];
    const runs: string[] = [];
    const linearCalls: number[] = [];

    await linearProcessor({ replies, runs, linearCalls }).process(
      mentionEvent("<@UBOT> linear regression in the parser, please fix"),
      { agentId: "opentag" }
    );

    expect(linearCalls).toHaveLength(0);
    expect(runs).toHaveLength(1);
  });

  it("replies a safe unavailable message when no linear handler is configured", async () => {
    const replies: Reply[] = [];
    const runs: string[] = [];

    const result = await linearProcessor({ replies, runs, withLinearHandler: false }).process(
      mentionEvent("<@UBOT> /linear"),
      { agentId: "opentag" }
    );

    expect(result.body).toMatchObject({ ok: true, selfService: "linear", unavailable: true });
    expect(runs).toHaveLength(0);
    expect(replies[0]!.text).toContain("not available");
  });

  it("lists /linear in help output", async () => {
    const replies: Reply[] = [];

    await linearProcessor({ replies, runs: [] }).process(mentionEvent("<@UBOT> /help"), { agentId: "opentag" });

    expect(replies[0]!.text).toContain("/linear");
  });

  it("forwards textFormat: mrkdwn from a linear handler reply so links are not re-escaped", async () => {
    const replies: Reply[] = [];
    const runs: string[] = [];

    await linearProcessor({
      replies,
      runs,
      linearReply: { text: "• <https://x|AMP-1> — t", textFormat: "mrkdwn" }
    }).process(mentionEvent("<@UBOT> /linear"), { agentId: "opentag" });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: "• <https://x|AMP-1> — t", textFormat: "mrkdwn" });
  });
});
