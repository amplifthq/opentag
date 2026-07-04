import { describe, expect, it } from "vitest";
import { createFinalSummaryPresentation } from "@opentag/core";
import {
  createTelegramFinalSummaryReplyMarkup,
  renderTelegramAcknowledgement,
  renderTelegramFinalResult,
  renderTelegramFinalSummaryPresentation,
  renderTelegramProgress
} from "../src/render.js";

describe("Telegram callback rendering", () => {
  it("renders acknowledgement and compact progress", () => {
    expect(renderTelegramAcknowledgement("run_1")).toBe(
      ["<b>OpenTag picked this up</b>", "Run: <code>run_1</code>", "Status: <b>received</b>"].join("\n")
    );
    expect(renderTelegramProgress("Thinking hard", { runId: "run_1" })).toBe(
      ["<b>OpenTag is thinking</b>", "Run: <code>run_1</code>", "Status: <b>running</b>"].join("\n")
    );
    expect(renderTelegramProgress("Running tests", { runId: "run_1" })).toBe(
      ["<b>OpenTag is working</b>", "Run: <code>run_1</code>", "Status: <b>running</b>", "", "Running tests"].join("\n")
    );
  });

  it("renders final results with compact HTML-safe detail", () => {
    const text = renderTelegramFinalResult(
      {
        conclusion: "success",
        summary: "Done <safely>.",
        verification: [{ command: "pnpm test --filter <x>", outcome: "passed" }],
        nextAction: "Review the PR."
      },
      { auditRunId: "run_1" }
    );

    expect(text).toContain("<b>OpenTag finished</b>");
    expect(text).toContain("Status: <b>success</b> · Run: <code>run_1</code>");
    expect(text).toContain("Summary: Done &lt;safely&gt;.");
    expect(text).toContain("Verification: pnpm test --filter &lt;x&gt;: passed");
    expect(text).toContain("Next: Review the PR.");
    expect(text).not.toContain("opentag status --run run_1");
  });

  it("renders final fallback text from semantic final summary presentation", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_semantic_telegram",
      result: {
        conclusion: "success",
        summary: "Done semantically.",
        verification: [{ command: "pnpm test", outcome: "passed" }],
        nextAction: "Review the PR."
      }
    });

    expect(renderTelegramFinalSummaryPresentation(presentation)).toBe(
      [
        "<b>OpenTag finished</b>",
        "Status: <b>success</b> · Run: <code>run_semantic_telegram</code>",
        "Summary: Done semantically.",
        "Verification: pnpm test: passed",
        "Next: Review the PR."
      ].join("\n")
    );
  });

  it("summarizes artifacts in final fallback text", () => {
    const presentation = createFinalSummaryPresentation({
      result: {
        conclusion: "success",
        summary: "Produced artifacts.",
        artifacts: [
          { kind: "patch", title: "Generated patch", uri: "opentag/run_1.patch" },
          { kind: "report", title: "Run report", uri: "opentag/run_1-report.md" },
          { kind: "screenshot", title: "UI screenshot", uri: "opentag/run_1.png" },
          { kind: "log_summary", title: "Log summary", uri: "opentag/run_1-log.md" },
          { kind: "pull_request", title: "Pull request", uri: "https://github.com/acme/demo/pull/1" }
        ]
      }
    });

    const text = renderTelegramFinalSummaryPresentation(presentation);
    expect(text).toContain("Artifacts: 5 artifacts available · 1 openable link · 4 local-only items via audit");
    expect(text).not.toContain("patch: Generated patch");
    expect(text).not.toContain("report: Run report");
    expect(text).not.toContain("screenshot: UI screenshot");
    expect(text).not.toContain("log_summary: Log summary");
    expect(text).not.toContain("opentag/run_1.patch");
    expect(text).not.toContain("https://github.com/acme/demo/pull/1");
  });

  it("renders Telegram-native reply markup for safe copy and URL actions", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_1",
      result: {
        conclusion: "success",
        summary: "Produced artifacts.",
        createdPullRequestUrl: "https://github.com/acme/demo/pull/1",
        artifacts: [
          { kind: "report", title: "Local report", uri: "opentag://run/run_1/report" },
          { kind: "screenshot", title: "Screenshot", uri: "https://example.com/run_1.png" }
        ]
      }
    });

    expect(createTelegramFinalSummaryReplyMarkup(presentation)).toEqual({
      inline_keyboard: [
        [
          { text: "Copy run id", copy_text: { text: "run_1" } },
          { text: "Copy audit", copy_text: { text: "opentag status --run run_1" } }
        ],
        [
          { text: "Open PR", url: "https://github.com/acme/demo/pull/1" },
          { text: "Open screenshot", url: "https://example.com/run_1.png" }
        ]
      ]
    });
  });
});
