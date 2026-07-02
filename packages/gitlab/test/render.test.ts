import { describe, expect, it } from "vitest";
import { renderAcknowledgement, renderFinalResult, renderFinalSummaryPresentation, renderProgress } from "../src/render.js";

describe("GitLab result rendering", () => {
  it("renders a GitLab-flavored approval copy in the suggested-action table", () => {
    const body = renderFinalResult({
      conclusion: "success",
      summary: "Prepared a branch.",
      suggestedChanges: [
        {
          proposalId: "proposal_1",
          createdAt: "2026-06-29T00:00:00.000Z",
          sourceRunId: "run_1",
          summary: "Create a merge request.",
          intents: [
            {
              intentId: "intent_create_pr",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create a merge request for branch opentag/run_1.",
              params: {
                title: "OpenTag run run_1",
                head: "opentag/run_1",
                base: "main",
                changedFiles: ["README.md"]
              }
            }
          ]
        }
      ]
    });

    expect(body).toContain("this GitLab thread");
    expect(body).not.toContain("this GitHub thread");
    expect(body).toContain("| Apply now | `apply 1` |");
    expect(body).toContain("- Changed files: `README.md`");
  });

  it("renders suggested-action verification rows without requiring a command", () => {
    const body = renderFinalResult({
      conclusion: "success",
      summary: "Prepared a branch.",
      suggestedChanges: [
        {
          proposalId: "proposal_1",
          createdAt: "2026-06-29T00:00:00.000Z",
          sourceRunId: "run_1",
          summary: "Create a merge request.",
          intents: [
            {
              intentId: "intent_create_pr",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create a merge request for branch opentag/run_1.",
              params: {
                title: "OpenTag run run_1",
                head: "opentag/run_1",
                base: "main",
                changedFiles: ["README.md"],
                verification: [
                  { command: "pnpm test", outcome: "passed" },
                  { outcome: "passed", summary: "Structured report parsed successfully." }
                ]
              }
            }
          ]
        }
      ]
    });

    expect(body).toContain("- Verification:\n  - `pnpm test`: passed\n  - passed - Structured report parsed successfully.");
  });

  it("renders run artifacts in both final result paths", () => {
    const result = {
      conclusion: "success" as const,
      summary: "Produced run artifacts.",
      artifacts: [
        { kind: "patch" as const, title: "Generated patch", uri: "opentag/run_1" },
        { kind: "report" as const, title: "Run report", uri: "opentag://run/run_1/report" },
        { kind: "log_summary" as const, title: "Log summary", uri: "opentag://run/run_1/log-summary" }
      ]
    };

    const plain = renderFinalResult(result);
    expect(plain).toContain("Artifacts:");
    expect(plain).toContain("- patch: [Generated patch](opentag/run_1)");
    expect(plain).toContain("- report: [Run report](opentag://run/run_1/report)");
    expect(plain).toContain("- log_summary: [Log summary](opentag://run/run_1/log-summary)");

    const withSuggestedAction = renderFinalResult({
      ...result,
      suggestedChanges: [
        {
          proposalId: "proposal_1",
          createdAt: "2026-06-29T00:00:00.000Z",
          sourceRunId: "run_1",
          summary: "Create a merge request.",
          intents: [
            {
              intentId: "intent_create_pr",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create a merge request for branch opentag/run_1.",
              params: { title: "OpenTag run run_1", head: "opentag/run_1", base: "main" }
            }
          ]
        }
      ]
    });
    expect(withSuggestedAction).toContain("Artifacts:");
    expect(withSuggestedAction).toContain("- patch: [Generated patch](opentag/run_1)");
    expect(withSuggestedAction).toContain("### Suggested actions:");
  });

  it("renders action table rows defensively when optional values are missing", () => {
    const body = renderFinalSummaryPresentation({
      outcome: "needs_human",
      summary: "Prepared actions.",
      actionReceiptTitle: "Ready to apply",
      actions: [
        {
          index: 1,
          title: "Create MR",
          targetLabel: "GitLab merge request",
          state: "ready_to_apply",
          visibleDecisions: ["apply"],
          primaryDecision: "apply",
          detailRows: [
            { label: "Optional", value: undefined as unknown as string },
            { label: "Nullable", value: null as unknown as string },
            { label: "Escaped", value: "a|b\nc" }
          ]
        }
      ]
    });

    expect(body).toContain("| Optional |  |");
    expect(body).toContain("| Nullable |  |");
    expect(body).toContain("| Escaped | a\\|b<br>c |");
  });

  it("renders acknowledgement and progress helpers", () => {
    expect(renderAcknowledgement("run_1")).toBe("OpenTag picked this up. Run: `run_1`");
    expect(renderProgress({ runId: "run_1", message: "thinking" })).toBe(
      "OpenTag progress for `run_1`: thinking"
    );
  });
});
