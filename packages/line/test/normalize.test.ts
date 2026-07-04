import { describe, expect, it } from "vitest";
import { encodeLineThreadKey, normalizeLineMessage, parseLineThreadKey } from "../src/normalize.js";

const binding = { accountId: "line_main", conversationId: "U123", repoProvider: "github", owner: "acme", repo: "demo" };

describe("LINE normalization", () => {
  it("normalizes direct text into an OpenTagEvent", () => {
    const event = normalizeLineMessage({
      accountId: "line_main",
      conversationId: "U123",
      sourceType: "user",
      userId: "U123",
      text: "fix this",
      messageId: "msg_1",
      webhookEventId: "webhook_1",
      webhookSignatureVerified: true,
      agentId: "opentag",
      binding
    });

    expect(event?.source).toBe("line");
    expect(event?.command.intent).toBe("fix");
    expect(event?.callback.provider).toBe("line");
    expect(event?.metadata).toMatchObject({ accountId: "line_main", conversationId: "U123", webhookSignatureVerified: true, owner: "acme", repo: "demo" });
  });

  it("ignores group text without invocation", () => {
    expect(
      normalizeLineMessage({
        accountId: "line_main",
        conversationId: "G123",
        sourceType: "group",
        userId: "U123",
        text: "fix this",
        messageId: "msg_1",
        binding: { ...binding, conversationId: "G123" }
      })
    ).toBeNull();
  });

  it("normalizes group text with self mention", () => {
    const event = normalizeLineMessage({
      accountId: "line_main",
      conversationId: "G123",
      sourceType: "group",
      userId: "U123",
      text: "@OpenTag fix this",
      messageId: "msg_1",
      mention: { mentionees: [{ isSelf: true, index: 0, length: 8 }] },
      binding: { ...binding, conversationId: "G123" }
    });

    expect(event?.command.rawText).toBe("fix this");
  });

  it("removes self mention using the LINE mention offset", () => {
    const leading = normalizeLineMessage({
      accountId: "line_main",
      conversationId: "G123",
      sourceType: "group",
      userId: "U123",
      text: "  @OpenTag fix this",
      messageId: "msg_1",
      mention: { mentionees: [{ isSelf: true, index: 2, length: 8 }] },
      binding: { ...binding, conversationId: "G123" }
    });
    const middle = normalizeLineMessage({
      accountId: "line_main",
      conversationId: "G123",
      sourceType: "group",
      userId: "U123",
      text: "@All @OpenTag fix this",
      messageId: "msg_2",
      mention: { mentionees: [{ isSelf: false, index: 0, length: 4 }, { isSelf: true, index: 5, length: 8 }] },
      binding: { ...binding, conversationId: "G123" }
    });

    expect(leading?.command.rawText).toBe("fix this");
    expect(middle?.command.rawText).toBe("@All fix this");
  });

  it("encodes and decodes LINE thread keys", () => {
    const key = encodeLineThreadKey({ accountId: "line_main", conversationId: "G123" });
    expect(parseLineThreadKey(key)).toEqual({ accountId: "line_main", conversationId: "G123" });
  });
});
