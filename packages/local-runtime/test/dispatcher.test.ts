import { describe, expect, it } from "vitest";
import { dispatcherRuntimeInputFromEnv } from "../src/dispatcher.js";

describe("local dispatcher runtime", () => {
  it("parses per-agent Slack bot tokens from env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_SLACK_BOT_TOKENS_JSON: JSON.stringify({ reviewer: "xoxb-reviewer" })
      }).slackBotTokensByAgentId
    ).toEqual({ reviewer: "xoxb-reviewer" });
  });

  it("rejects non-string per-agent bot tokens", () => {
    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_SLACK_BOT_TOKENS_JSON: JSON.stringify({ reviewer: 123 })
      })
    ).toThrow("Token for agent reviewer must be a non-empty string");
  });
});
