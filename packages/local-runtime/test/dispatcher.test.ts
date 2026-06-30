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

  it("can split GitHub callback and apply tokens from env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_GITHUB_TOKEN: "ghp_callback_and_apply",
        OPENTAG_GITHUB_CALLBACK_TOKEN: "ghp_callback",
        OPENTAG_GITHUB_APPLY_TOKEN: "ghp_apply"
      })
    ).toMatchObject({
      githubToken: "ghp_callback_and_apply",
      githubCallbackToken: "ghp_callback",
      githubApplyToken: "ghp_apply"
    });
  });

  it("can disable GitHub direct apply while leaving callback token configured", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_GITHUB_TOKEN: "ghp_callback",
        OPENTAG_GITHUB_APPLY_DISABLED: "true"
      })
    ).toMatchObject({
      githubToken: "ghp_callback",
      githubApplyToken: null
    });
  });
});
