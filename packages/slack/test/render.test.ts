import { describe, expect, it } from "vitest";
import {
  parseSlackSuggestedActionButtonValue,
  createSlackFinalResultBlocks,
  createSlackPostMessagePayload,
  createSlackReactionPayload,
  createSlackUpdateMessagePayload,
  markdownToSlackMrkdwn,
  renderSlackAcknowledgement,
  renderSlackFinalResult,
  slackSourceReceiptReactionName
} from "../src/render.js";

describe("Slack callback rendering", () => {
  it("renders Slack-friendly acknowledgement messages", () => {
    expect(renderSlackAcknowledgement("run_1")).toBe("Working on it.");
  });

  it("uses Slack mrkdwn for final results", () => {
    const text = renderSlackFinalResult({
      conclusion: "success",
      summary: "Echoed **OpenTag** command: [introduce yourself](https://example.com/cmd)",
      verification: [{ command: "echo", outcome: "passed" }],
      nextAction: "Open [thread](https://example.com/thread) & follow up"
    });

    expect(text).toBe(
      "*Finished: success.*\nEchoed *OpenTag* command: <https://example.com/cmd|introduce yourself>\nVerified: `echo` passed\nNext: Open <https://example.com/thread|thread> &amp; follow up"
    );
    expect(text).not.toContain("**success**");
  });

  it("converts common Markdown to Slack mrkdwn", () => {
    expect(markdownToSlackMrkdwn("**bold** and [docs](https://example.com)")).toBe("*bold* and <https://example.com|docs>");
    expect(markdownToSlackMrkdwn("Use <tag> & [docs & api](https://example.com?a=1&b=2)")).toBe(
      "Use &lt;tag&gt; &amp; <https://example.com?a=1&b=2|docs &amp; api>"
    );
  });

  it("builds Slack post and update payloads", () => {
    expect(createSlackPostMessagePayload({ channelId: "C123", threadTs: "171.001", text: "**hello**" })).toEqual({
      channel: "C123",
      text: "*hello*",
      thread_ts: "171.001"
    });
    expect(createSlackUpdateMessagePayload({ channelId: "C123", messageTs: "172.001", text: "[docs](https://example.com)" })).toEqual({
      channel: "C123",
      text: "<https://example.com|docs>",
      ts: "172.001"
    });
  });

  it("builds lightweight source receipt reaction payloads", () => {
    expect(slackSourceReceiptReactionName("received")).toBe("eyes");
    expect(createSlackReactionPayload({ channelId: "C123", messageTs: "171.001", name: "eyes" })).toEqual({
      channel: "C123",
      timestamp: "171.001",
      name: "eyes"
    });
  });

  it("builds Block Kit sections for final results", () => {
    const blocks = createSlackFinalResultBlocks({
      conclusion: "success",
      summary: "See [PR](https://example.com/pr)",
      verification: [{ command: "echo '<tag>'", outcome: "passed" }]
    });

    expect(blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Finished: success.*\nSee <https://example.com/pr|PR>"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Verified: `echo '&lt;tag&gt;'` passed"
        }
      }
    ]);
  });

  it("adds Block Kit buttons for suggested source-thread actions", () => {
    const blocks = createSlackFinalResultBlocks({
      conclusion: "needs_human",
      summary: "Prepared a proposal.",
      suggestedChanges: [
        {
          proposalId: "proposal_1",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Move issue forward.",
          intents: [
            {
              intentId: "intent_label_1",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });

    const rendered = JSON.stringify(blocks);
    expect(rendered).toContain("1. *Add the bug label.*");
    expect(rendered).not.toContain("Proposal:");
    expect(rendered).not.toContain("Intent ID:");

    const actionsBlock = blocks.find((block) => block.type === "actions");
    expect(actionsBlock).toMatchObject({
      type: "actions",
      block_id: "opentag_actions_1",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Apply 1" }, action_id: "opentag:apply:1", style: "primary" },
        { type: "button", text: { type: "plain_text", text: "Approve" }, action_id: "opentag:approve:1" },
        { type: "button", text: { type: "plain_text", text: "Reject" }, action_id: "opentag:reject:1", style: "danger" }
      ]
    });

    if (actionsBlock?.type !== "actions") throw new Error("expected actions block");
    expect(parseSlackSuggestedActionButtonValue(actionsBlock.elements[0]?.value ?? "")).toEqual({
      version: 1,
      command: "apply 1",
      proposalId: "proposal_1",
      intentId: "intent_label_1"
    });
  });
});
