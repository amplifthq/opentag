import { describe, expect, it } from "vitest";
import {
  OPEN_TAG_PLATFORM_CAPABILITIES,
  platformCapabilityForProvider,
  shouldDeliverCallbackProgress,
  shouldDeliverCallbackRunStatus,
  shouldDeliverSourceReceipt
} from "../src/capability.js";

describe("platform capability catalog", () => {
  it("declares source-thread liveness strategies for built-in platforms", () => {
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.github.livenessStrategy).toBe("status_update");
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.gitlab.livenessStrategy).toBe("thread_reply");
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.linear.livenessStrategy).toBe("thread_reply");
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.slack.livenessStrategy).toBe("source_receipt");
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.lark.livenessStrategy).toBe("source_receipt");
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.telegram.livenessStrategy).toBe("status_update");
  });

  it("declares provider-native presentation capabilities separately from action replies", () => {
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.lark.supportsRichPresentation).toBe(true);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.lark.supportsActionReplies).toBe(false);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.slack.supportsRichPresentation).toBe(true);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.slack.supportsActionReplies).toBe(true);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.gitlab.supportsRichPresentation).toBe(false);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.gitlab.supportsActionReplies).toBe(true);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.linear.supportsRichPresentation).toBe(false);
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.linear.supportsActionReplies).toBe(true);
  });

  it("maps liveness strategies to callback delivery behavior", () => {
    expect(shouldDeliverCallbackRunStatus("github")).toBe(true);
    expect(shouldDeliverCallbackRunStatus("gitlab")).toBe(true);
    expect(shouldDeliverCallbackRunStatus("linear")).toBe(true);
    expect(shouldDeliverCallbackRunStatus("telegram")).toBe(true);
    expect(shouldDeliverCallbackRunStatus("slack")).toBe(false);
    expect(shouldDeliverCallbackRunStatus("lark")).toBe(false);
    expect(shouldDeliverCallbackRunStatus("custom")).toBe(true);

    expect(shouldDeliverCallbackProgress("github")).toBe(true);
    expect(shouldDeliverCallbackProgress("gitlab")).toBe(false);
    expect(shouldDeliverCallbackProgress("linear")).toBe(false);
    expect(shouldDeliverCallbackProgress("telegram")).toBe(true);
    expect(shouldDeliverCallbackProgress("slack")).toBe(false);
    expect(shouldDeliverCallbackProgress("lark")).toBe(false);
    expect(shouldDeliverCallbackProgress("custom")).toBe(true);

    expect(shouldDeliverSourceReceipt("slack")).toBe(true);
    expect(shouldDeliverSourceReceipt("github")).toBe(false);
    expect(shouldDeliverSourceReceipt("lark")).toBe(true);
    expect(shouldDeliverSourceReceipt("custom")).toBe(false);
  });

  it("returns undefined for providers outside the shared catalog", () => {
    expect(platformCapabilityForProvider("custom")).toBeUndefined();
  });
});
