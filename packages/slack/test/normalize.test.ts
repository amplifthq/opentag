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
    expect(event?.command.args).toMatchObject({ prompt: "this" });
    expect(event?.metadata).toMatchObject({ teamId: "T123", channelId: "C123", owner: "acme", repo: "demo" });
    expect(event?.permissions.map((permission) => permission.scope)).toContain("chat:postMessage");
    expect(event?.callback.uri).toBe("http://127.0.0.1:3102/github-comment");
  });

  it("maps parser hints from Slack mentions into event fields", () => {
    const event = normalizeSlackAppMention({
      teamId: "T123",
      channelId: "C123",
      userId: "U456",
      text: "<@U_APP> run \"pnpm test\" --path packages/core --scope repo:read --network restricted --executor codex --approval required",
      ts: "1710000000.000100",
      eventId: "Ev456",
      eventTime: 1710000000,
      botUserId: "U_APP",
      binding: {
        teamId: "T123",
        channelId: "C123",
        owner: "acme",
        repo: "demo"
      }
    });

    expect(event?.target.executorHint).toBe("codex");
    expect(event?.command.parsed).toMatchObject({
      prompt: "pnpm test",
      approval: "required",
      requestedScopes: ["repo:read", "network:restricted"]
    });
    expect(event?.context).toContainEqual({
      kind: "file",
      uri: "packages/core",
      visibility: "organization",
      title: "Command file reference"
    });
    expect(event?.permissions.map((permission) => permission.scope)).toContain("network:restricted");
    expect(event?.metadata).toMatchObject({
      commandParser: "v1",
      approval: "required",
      network: "restricted"
    });
  });

  it("encodes and decodes Slack thread keys", () => {
    const key = encodeSlackThreadKey({ teamId: "T123", channelId: "C123", threadTs: "1710000000.000100" });
    expect(parseSlackThreadKey(key)).toEqual({
      teamId: "T123",
      channelId: "C123",
      threadTs: "1710000000.000100"
    });
  });
});
