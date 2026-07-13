import { describe, expect, it } from "vitest";
import { encodeTeamsThreadKey, parseTeamsThreadKey } from "../src/thread-key.js";

describe("teams thread key", () => {
  const input = {
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    conversationId: "19:abc@thread.tacv2;messageid=1699",
    activityId: "1699000000001"
  };

  it("round-trips serviceUrl, conversationId, and activityId", () => {
    const key = encodeTeamsThreadKey(input);
    expect(parseTeamsThreadKey(key)).toEqual(input);
  });

  it("encodes as pipe-delimited segments", () => {
    expect(encodeTeamsThreadKey(input)).toBe(
      "https://smba.trafficmanager.net/amer/|19:abc@thread.tacv2;messageid=1699|1699000000001"
    );
  });

  it("throws on a key missing a segment", () => {
    expect(() => parseTeamsThreadKey("https://x|19:abc")).toThrow(/Invalid Teams thread key/);
  });

  it("throws on a key with extra segments", () => {
    expect(() => parseTeamsThreadKey("https://x|19:abc|activity-1|unexpected")).toThrow(/Invalid Teams thread key/);
  });
});
