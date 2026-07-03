import { describe, expect, it } from "vitest";
import { computeLineSignature, verifyLineSignature } from "../src/signature.js";

describe("LINE signature", () => {
  it("verifies a matching raw-body signature", () => {
    const rawBody = JSON.stringify({ events: [] });
    const signature = computeLineSignature({ channelSecret: "secret", rawBody });

    expect(verifyLineSignature({ channelSecret: "secret", rawBody, signature })).toBe(true);
  });

  it("rejects mismatches", () => {
    expect(verifyLineSignature({ channelSecret: "secret", rawBody: "{}", signature: "bad" })).toBe(false);
  });
});
