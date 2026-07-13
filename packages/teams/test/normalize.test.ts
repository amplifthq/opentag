import { describe, expect, it } from "vitest";
import { extractTeamsMessage, normalizeTeamsActivity, type TeamsChannelBinding } from "../src/normalize.js";

const binding: TeamsChannelBinding = {
  tenantId: "t1",
  teamId: "19:team",
  channelId: "19:chan",
  conversationId: "19:conv@thread.tacv2",
  owner: "acme",
  repo: "demo"
};

function channelActivity(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: "act-1",
    text: "<at>OpenTag</at> investigate this",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    from: { id: "29:user", name: "Alice", aadObjectId: "aad-1" },
    recipient: { id: "28:bot", name: "OpenTag" },
    conversation: { id: "19:conv@thread.tacv2", conversationType: "channel", tenantId: "t1" },
    channelData: { tenant: { id: "t1" }, team: { id: "19:team" }, channel: { id: "19:chan" } },
    entities: [{ type: "mention", mentioned: { id: "28:bot" }, text: "<at>OpenTag</at>" }],
    ...overrides
  } as Record<string, unknown>;
}

describe("extractTeamsMessage", () => {
  it("returns null for a non-message activity", () => {
    expect(extractTeamsMessage(channelActivity({ type: "conversationUpdate" }))).toBeNull();
  });

  it("returns null for a non-channel conversation", () => {
    expect(
      extractTeamsMessage(channelActivity({ conversation: { id: "19:conv", conversationType: "personal", tenantId: "t1" } }))
    ).toBeNull();
  });

  it("returns null when text is absent", () => {
    const activity = channelActivity();
    delete (activity as Record<string, unknown>).text;
    expect(extractTeamsMessage(activity)).toBeNull();
  });

  it("returns null when the bot is not mentioned", () => {
    expect(extractTeamsMessage(channelActivity({ entities: [] }))).toBeNull();
  });

  it("ignores malformed entity values instead of throwing", () => {
    expect(extractTeamsMessage(channelActivity({ entities: [null, "bad", 42] }))).toBeNull();
  });

  it("returns null when the sender is the bot itself", () => {
    expect(
      extractTeamsMessage(channelActivity({ from: { id: "28:bot", name: "OpenTag" } }))
    ).toBeNull();
  });

  it("strips the mention text and extracts required fields", () => {
    const extracted = extractTeamsMessage(channelActivity());
    expect(extracted).toMatchObject({
      activityId: "act-1",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      conversationId: "19:conv@thread.tacv2",
      tenantId: "t1",
      teamId: "19:team",
      channelId: "19:chan",
      userId: "aad-1",
      text: "investigate this",
      botId: "28:bot"
    });
  });

  it("keeps parsing when the General channel omits channel.id", () => {
    const extracted = extractTeamsMessage(
      channelActivity({ channelData: { tenant: { id: "t1" }, team: { id: "19:team" } } })
    );
    expect(extracted?.channelId).toBeUndefined();
    expect(extracted?.conversationId).toBe("19:conv@thread.tacv2");
  });
});

describe("normalizeTeamsActivity", () => {
  const base = {
    activityId: "act-1",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    conversationId: "19:conv@thread.tacv2",
    tenantId: "t1",
    teamId: "19:team",
    channelId: "19:chan",
    userId: "aad-1",
    userName: "Alice",
    text: "investigate this",
    binding,
    receivedAt: "2026-07-07T00:00:00.000Z"
  };

  it("returns null for an empty command body", () => {
    expect(normalizeTeamsActivity({ ...base, text: "   " })).toBeNull();
  });

  it("produces a stable, well-formed event for a review-intent mention", () => {
    const event = normalizeTeamsActivity(base)!;
    expect(event.id).toBe("evt_teams_act-1");
    expect(event.source).toBe("teams");
    expect(event.sourceEventId).toBe("act-1");
    expect(event.actor).toMatchObject({ provider: "teams", providerUserId: "aad-1", handle: "Alice", organizationId: "19:team" });
    expect(event.callback).toEqual({
      provider: "teams",
      uri: "https://smba.trafficmanager.net/amer/",
      threadKey: "https://smba.trafficmanager.net/amer/|19:conv@thread.tacv2|act-1"
    });
    expect(event.metadata).toMatchObject({
      tenantId: "t1", teamId: "19:team", channelId: "19:chan",
      conversationId: "19:conv@thread.tacv2",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      repoProvider: "github", owner: "acme", repo: "demo"
    });
    expect(event.context[0]).toMatchObject({ provider: "teams", kind: "url", title: "Teams message" });
    // review intent → no write permissions
    expect(event.permissions.some((p) => p.scope === "repo:write")).toBe(false);
  });

  it("adds write permissions for a fix intent", () => {
    const event = normalizeTeamsActivity({ ...base, text: "fix the flaky test" })!;
    const scopes = event.permissions.map((p) => p.scope);
    expect(scopes).toEqual(expect.arrayContaining(["repo:read", "repo:write", "pr:create"]));
  });
});
