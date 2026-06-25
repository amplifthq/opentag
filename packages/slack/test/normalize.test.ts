import { describe, expect, it } from "vitest";
import { encodeSlackThreadKey, normalizeSlackAppMention, parseSlackThreadKey, stripSlackAppMention } from "../src/normalize.js";

describe("Slack normalization", () => {
  it("strips a Slack app mention and preserves the remaining command", () => {
    expect(stripSlackAppMention("<@U_APP> fix this", "U_APP")).toBe("fix this");
  });

  it("normalizes an app_mention into an OpenTagEvent", () => {
    const event = normalizeSlackAppMention({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text: "<@U_APP> fix this",
      ts: "1710000000.000100",
      eventId: "Ev123",
      eventTime: 1710000000,
      appId: "A123",
      agentId: "gemini",
      botUserId: "U_APP",
      callbackUri: "http://127.0.0.1:3102/github-comment",
      binding: {
        teamId: "T123",
        channelId: "C123",
        owner: "acme",
        repo: "demo"
      }
    });

    expect(event?.source).toBe("slack");
    expect(event?.command.intent).toBe("fix");
    expect(event?.target).toEqual({
      mention: "<@U_APP>",
      agentId: "gemini"
    });
    expect(event?.metadata).toMatchObject({ teamId: "T123", channelId: "C123", owner: "acme", repo: "demo" });
    expect(event?.metadata).toMatchObject({ slackAppId: "A123", slackBotUserId: "U_APP" });
    expect(event?.permissions.map((permission) => permission.scope)).toContain("chat:postMessage");
    expect(event?.callback.uri).toBe("http://127.0.0.1:3102/github-comment");
  });

  it("encodes and decodes Slack thread keys", () => {
    const key = encodeSlackThreadKey({ teamId: "T123", channelId: "C123", threadTs: "1710000000.000100" });
    expect(parseSlackThreadKey(key)).toEqual({
      teamId: "T123",
      channelId: "C123",
      threadTs: "1710000000.000100"
    });
  });

  it("captures parser hints without converting requested scopes into extra granted permissions", () => {
    const event = normalizeSlackAppMention({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text: "<@U_APP> fix auth --scope repo:write --executor codex --file src/auth.ts --line 12",
      ts: "1710000000.000100",
      eventId: "Ev789",
      eventTime: 1710000000,
      agentId: "gemini",
      botUserId: "U_APP",
      binding: {
        teamId: "T123",
        channelId: "C123",
        owner: "acme",
        repo: "demo"
      }
    });

    expect(event?.target).toMatchObject({ agentId: "gemini", executorHint: "codex" });
    expect(event?.command.parsed?.requestedScopes).toEqual(["repo:write"]);
    expect(event?.permissions.map((permission) => permission.scope)).toEqual(
      expect.arrayContaining(["chat:postMessage", "runner:local", "repo:read", "repo:write", "pr:create"])
    );
    expect(event?.context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", uri: "src/auth.ts#L12" })
      ])
    );
  });
});
