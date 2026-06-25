import type { OpenTagRunResult } from "@opentag/core";
import { describe, expect, it } from "vitest";
import { createLarkTextMessageContent, renderLarkAcknowledgement, renderLarkFinalResult } from "../src/index.js";

describe("renderLarkAcknowledgement", () => {
  it("includes the run id", () => {
    expect(renderLarkAcknowledgement("run_1")).toContain("run_1");
  });
});

describe("renderLarkFinalResult", () => {
  it("renders conclusion, summary, verification and next action", () => {
    const result: OpenTagRunResult = {
      conclusion: "success",
      summary: "Did the thing.",
      verification: [{ command: "pnpm test", outcome: "passed" }],
      nextAction: "Review the PR."
    };
    const text = renderLarkFinalResult(result);
    expect(text).toContain("success");
    expect(text).toContain("Did the thing.");
    expect(text).toContain("pnpm test");
    expect(text).toContain("passed");
    expect(text).toContain("Review the PR.");
  });

  it("handles a structured nextAction", () => {
    const result: OpenTagRunResult = {
      conclusion: "needs_human",
      summary: "Need a decision.",
      nextAction: { summary: "Pick an option", hint: { kind: "request_human_decision" } }
    };
    expect(renderLarkFinalResult(result)).toContain("Pick an option");
  });
});

describe("createLarkTextMessageContent", () => {
  it("produces JSON-encoded text content", () => {
    expect(createLarkTextMessageContent("hi")).toBe('{"text":"hi"}');
  });
});
