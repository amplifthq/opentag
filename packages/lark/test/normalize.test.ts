import { describe, expect, it } from "vitest";
import {
  encodeLarkThreadKey,
  type LarkMessageInput,
  normalizeLarkChannelMessage,
  normalizeLarkMessage,
  parseLarkThreadKey,
  stripLarkMention
} from "../src/index.js";

const baseInput: LarkMessageInput = {
  tenantKey: "tk_123",
  chatId: "oc_chat",
  chatType: "group",
  senderOpenId: "ou_user",
  text: "@_user_1 fix the login bug",
  messageId: "om_msg",
  eventId: "evt_1",
  eventTimeMs: 1_700_000_000_000,
  applicationId: "cli_app_123",
  botOpenId: "ou_bot",
  binding: { tenantKey: "tk_123", chatId: "oc_chat", owner: "acme", repo: "app" }
};

describe("stripLarkMention", () => {
  it("strips a mention placeholder and trims", () => {
    expect(stripLarkMention("@_user_1 hello")).toBe("hello");
  });

  it("removes @_user_10 intact (no leftover digit from an @_user_1 prefix strip)", () => {
    expect(stripLarkMention("@_user_10 deploy now")).toBe("deploy now");
  });

  it("strips multiple placeholders and collapses whitespace", () => {
    expect(stripLarkMention("@_user_1 hey @_user_2   there")).toBe("hey there");
  });

  it("returns empty string when only a mention is present", () => {
    expect(stripLarkMention("@_user_1")).toBe("");
  });
});

describe("lark thread key", () => {
  it("round-trips", () => {
    const key = encodeLarkThreadKey({ tenantKey: "tk", chatId: "oc", messageId: "om" });
    expect(key).toBe("tk|oc|om");
    expect(parseLarkThreadKey(key)).toEqual({ tenantKey: "tk", chatId: "oc", messageId: "om" });
  });

  it("throws on a malformed key", () => {
    expect(() => parseLarkThreadKey("bad")).toThrow(/Invalid Lark thread key/);
  });
});

describe("normalizeLarkMessage", () => {
  it("normalizes native Lark ingress through opentag.channel.v1", () => {
    expect(normalizeLarkChannelMessage(baseInput)).toMatchObject({
      protocol: "opentag.channel.v1",
      trigger: "mention",
      source: { channel: { provider: "lark", workspace: "tk_123", id: "oc_chat" }, actor: { id: "ou_user" } },
      text: "fix the login bug",
      replyTarget: { purpose: "all" }
    });
  });

  it("maps a Lark message into an OpenTagEvent", () => {
    const event = normalizeLarkMessage(baseInput);
    expect(event).not.toBeNull();
    expect(event?.source).toBe("lark");
    expect(event?.actor.provider).toBe("lark");
    expect(event?.actor.providerUserId).toBe("ou_user");
    expect(event?.actor.organizationId).toBe("tk_123");
    expect(event?.callback.provider).toBe("lark");
    expect(event?.callback.threadKey).toBe("tk_123|oc_chat|om_msg");
    expect(event?.command.rawText).toBe("fix the login bug");
    expect(event?.metadata.owner).toBe("acme");
    expect(event?.metadata.repo).toBe("app");
    expect(event?.metadata.repoProvider).toBe("github");
    expect(event?.metadata.chatId).toBe("oc_chat");
    expect(event?.metadata.tenantKey).toBe("tk_123");
    expect(event?.metadata.sourceDeliveryId).toBe("evt_1");
    expect(event?.metadata.larkEventId).toBe("evt_1");
    expect(event?.metadata.larkRenderLocale).toBe("en-US");
    expect(event?.metadata).toMatchObject({ channelApplicationId: "cli_app_123", channelBotId: "ou_bot" });
  });

  it("derives Feishu render locale from the domain", () => {
    const event = normalizeLarkMessage({ ...baseInput, domain: "feishu" });
    expect(event?.metadata.larkDomain).toBe("feishu");
    expect(event?.metadata.larkRenderLocale).toBe("zh-CN");
  });

  it("returns null when the command is empty after stripping", () => {
    expect(normalizeLarkMessage({ ...baseInput, text: "@_user_1" })).toBeNull();
  });

  it("honors binding.repoProvider when provided", () => {
    const event = normalizeLarkMessage({
      ...baseInput,
      binding: { ...baseInput.binding, repoProvider: "gitlab" }
    });
    expect(event?.metadata.repoProvider).toBe("gitlab");
  });
});
