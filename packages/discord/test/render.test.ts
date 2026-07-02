import { describe, expect, it } from "vitest";
import { createDiscordSendMessagePayload, renderDiscordAcknowledgement, renderDiscordFinalResult, renderDiscordProgress } from "../src/render.js";

describe("Discord callback rendering", () => {
  it("renders acknowledgement and compact progress", () => {
    expect(renderDiscordAcknowledgement("run_1")).toContain("run_1");
    expect(renderDiscordProgress("thinking hard")).toBe("Thinking...");
    expect(renderDiscordProgress("Running tests")).toBe("Working...");
  });

  it("renders final results with audit fallback detail", () => {
    const text = renderDiscordFinalResult(
      {
        conclusion: "success",
        summary: "Done.",
        verification: [{ command: "pnpm test", outcome: "passed" }],
        nextAction: "Review the PR."
      },
      { auditRunId: "run_1" }
    );

    expect(text).toContain("Finished with success.");
    expect(text).toContain("Done.");
    expect(text).toContain("pnpm test");
    expect(text).toContain("Review the PR.");
    expect(text).toContain("Audit: opentag status --run run_1");
  });

  it("builds a plain send-message payload", () => {
    expect(createDiscordSendMessagePayload({ content: "hi" })).toEqual({ content: "hi" });
  });

  it("builds a reply payload with message_reference", () => {
    expect(createDiscordSendMessagePayload({ content: "hi", replyToMessageId: "msg_1" })).toEqual({
      content: "hi",
      message_reference: { message_id: "msg_1" }
    });
  });
});
