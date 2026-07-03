import { describe, expect, it } from "vitest";
import { createFinalSummaryPresentation } from "@opentag/core";
import { renderTelegramAcknowledgement, renderTelegramFinalResult, renderTelegramFinalSummaryPresentation, renderTelegramProgress } from "../src/render.js";

describe("Telegram callback rendering", () => {
  it("renders acknowledgement and compact progress", () => {
    expect(renderTelegramAcknowledgement("run_1")).toContain("run_1");
    expect(renderTelegramProgress("Thinking hard")).toBe("Thinking...");
    expect(renderTelegramProgress("Running tests")).toBe("Working...");
  });

  it("renders final results with audit fallback detail", () => {
    const text = renderTelegramFinalResult(
      {
        conclusion: "success",
        summary: "Done.",
        verification: [{ command: "pnpm test", outcome: "passed" }],
        nextAction: "Review the PR."
      },
      { auditRunId: "run_1" }
    );

    expect(text).toContain("success");
    expect(text).toContain("Done.");
    expect(text).toContain("pnpm test");
    expect(text).toContain("Review the PR.");
    expect(text).toContain("Audit: opentag status --run run_1");
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
        "Finished with success.",
        "",
        "Done semantically.",
        "",
        "Verification:",
        "- pnpm test: passed",
        "",
        "Next action: Review the PR.",
        "",
        "Audit: opentag status --run run_semantic_telegram"
      ].join("\n")
    );
  });

  it("renders artifacts in final fallback text", () => {
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
    expect(text).toContain("Artifacts:");
    expect(text).toContain("- patch: Generated patch: opentag/run_1.patch");
    expect(text).toContain("- report: Run report: opentag/run_1-report.md");
    expect(text).toContain("- screenshot: UI screenshot: opentag/run_1.png");
    expect(text).toContain("- log_summary: Log summary: opentag/run_1-log.md");
    expect(text).not.toContain("- pull_request: Pull request: https://github.com/acme/demo/pull/1");
    expect(text).toContain("+1 more artifact(s) in audit/status.");
  });
});
