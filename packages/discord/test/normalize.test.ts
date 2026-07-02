import { describe, expect, it } from "vitest";
import { encodeDiscordThreadKey, normalizeDiscordInteraction, parseDiscordThreadKey, type DiscordChannelBinding } from "../src/normalize.js";

const binding: DiscordChannelBinding = {
  applicationId: "app_1",
  channelId: "chan_1",
  repoProvider: "github",
  owner: "acme",
  repo: "demo"
};

function baseInput() {
  return {
    interactionId: "int_1",
    applicationId: "app_1",
    channelId: "chan_1",
    guildId: "guild_1",
    userId: "user_1",
    username: "alice",
    prompt: "fix this",
    binding,
    receivedAt: "2026-07-02T00:00:00.000Z"
  };
}

describe("normalizeDiscordInteraction", () => {
  it("normalizes a slash command into an OpenTagEvent", () => {
    const event = normalizeDiscordInteraction(baseInput());

    expect(event?.source).toBe("discord");
    expect(event?.id).toBe("evt_discord_int_1");
    expect(event?.command.intent).toBe("fix");
    expect(event?.callback.provider).toBe("discord");
    expect(event?.callback.uri).toBe("https://discord.com/api/v10/channels/chan_1/messages");
    expect(event?.metadata).toMatchObject({
      applicationId: "app_1",
      channelId: "chan_1",
      guildId: "guild_1",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    });
  });

  it("returns null when the prompt is empty after trimming", () => {
    expect(normalizeDiscordInteraction({ ...baseInput(), prompt: "   " })).toBeNull();
  });

  it("returns null for a whitespace-only prompt even when an executor is set", () => {
    expect(normalizeDiscordInteraction({ ...baseInput(), prompt: "   ", executor: "codex" })).toBeNull();
  });

  it("maps the executor option into target.executorHint via --executor", () => {
    const event = normalizeDiscordInteraction({ ...baseInput(), prompt: "fix the login bug", executor: "codex" });
    expect(event?.target.executorHint).toBe("codex");

    const claude = normalizeDiscordInteraction({ ...baseInput(), prompt: "review this", executor: "claude-code" });
    expect(claude?.target.executorHint).toBe("claude-code");
  });

  it("records a diagnostic and no executorHint for an unknown executor", () => {
    const event = normalizeDiscordInteraction({ ...baseInput(), prompt: "fix it", executor: "claude" });
    expect(event?.target.executorHint).toBeUndefined();
    expect(event?.metadata.commandDiagnostics).toBeDefined();
  });

  it("requests write + PR permissions for fix/run and not for explain", () => {
    const fix = normalizeDiscordInteraction({ ...baseInput(), prompt: "fix this" });
    const scopes = fix?.permissions.map((p) => p.scope) ?? [];
    expect(scopes).toContain("repo:write");
    expect(scopes).toContain("pr:create");

    const explain = normalizeDiscordInteraction({ ...baseInput(), prompt: "explain this file" });
    const explainScopes = explain?.permissions.map((p) => p.scope) ?? [];
    expect(explainScopes).not.toContain("repo:write");
  });

  it("omits workItem for a pure chat mention", () => {
    const event = normalizeDiscordInteraction(baseInput());
    expect(event?.workItem).toBeUndefined();
  });
});

describe("Discord thread key", () => {
  it("round-trips guild/channel/anchor", () => {
    const key = encodeDiscordThreadKey({ guildId: "guild_1", channelId: "chan_1", anchorId: "int_1" });
    expect(key).toBe("guild_1|chan_1|int_1");
    expect(parseDiscordThreadKey(key)).toEqual({ guildId: "guild_1", channelId: "chan_1", anchorId: "int_1" });
  });

  it("handles an absent guild (DM) with an empty leading segment", () => {
    const key = encodeDiscordThreadKey({ channelId: "chan_1", anchorId: "int_1" });
    expect(key).toBe("|chan_1|int_1");
    expect(parseDiscordThreadKey(key)).toEqual({ channelId: "chan_1", anchorId: "int_1" });
  });

  it("throws on a malformed thread key", () => {
    expect(() => parseDiscordThreadKey("only-one-segment")).toThrow();
  });
});
