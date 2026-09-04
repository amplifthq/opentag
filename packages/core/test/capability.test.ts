import { describe, expect, it } from "vitest";
import {
  OPEN_TAG_PLATFORM_CAPABILITIES,
  isOpenTagPlatformId,
  platformCapabilityForProvider,
  shouldDeliverProgressPresentation,
  shouldDeliverRunStatusPresentation,
  shouldDeliverSourceReceipt
} from "../src/capability.js";

describe("supported platform capabilities", () => {
  it("keeps Slack as the Source App and GitHub as the provider evidence surface", () => {
    expect(Object.keys(OPEN_TAG_PLATFORM_CAPABILITIES).sort()).toEqual(["github", "slack"]);
    expect(isOpenTagPlatformId("slack")).toBe(true);
    expect(isOpenTagPlatformId("github")).toBe(true);
    expect(isOpenTagPlatformId("custom")).toBe(false);
  });

  it("keeps Slack rich and quiet while GitHub provider observations remain visible", () => {
    expect(OPEN_TAG_PLATFORM_CAPABILITIES.slack).toMatchObject({
      livenessStrategy: "source_receipt",
      supportsRichPresentation: true,
      supportsActionReplies: true,
      requiresExplicitAddressing: true
    });
    expect(shouldDeliverRunStatusPresentation("slack")).toBe(false);
    expect(shouldDeliverProgressPresentation("slack")).toBe(false);
    expect(shouldDeliverSourceReceipt("slack")).toBe(true);

    expect(shouldDeliverRunStatusPresentation("github")).toBe(true);
    expect(shouldDeliverProgressPresentation("github")).toBe(true);
    expect(shouldDeliverSourceReceipt("github")).toBe(false);
  });

  it("returns undefined for unsupported providers", () => {
    expect(platformCapabilityForProvider("custom")).toBeUndefined();
  });
});
