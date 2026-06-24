import { describe, expect, it } from "vitest";
import {
  createSlackFinalResultBlocks,
  createSlackPostMessagePayload,
  createSlackUpdateMessagePayload,
  markdownToSlackMrkdwn,
  renderSlackAcknowledgement,
  renderSlackFinalResult
} from "../src/render.js";

describe("Slack callback rendering", () => {
  it("renders Slack-friendly acknowledgement messages", () => {
    expect(renderSlackAcknowledgement("run_1")).toBe("I picked this up: `run_1`");
  });

  it("uses Slack mrkdwn for final results", () => {
    const text = renderSlackFinalResult({
      conclusion: "success",
      summary: "Echoed **OpenTag** command: [introduce yourself](https://example.com/cmd)",
      verification: [{ command: "echo", outcome: "passed" }],
      nextAction: "Open [thread](https://example.com/thread) & follow up"
    });

    expect(text).toBe(
      "Finished with *success*.\n\nEchoed *OpenTag* command: <https://example.com/cmd|introduce yourself>\n\n*Verification*\n- `echo`: passed\n\n*Next action*: Open <https://example.com/thread|thread> &amp; follow up"
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
          text: "*Finished with success.*\nSee <https://example.com/pr|PR>"
        }
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Verification*\n- `echo '&lt;tag&gt;'`: passed"
        }
      }
    ]);
  });
});
