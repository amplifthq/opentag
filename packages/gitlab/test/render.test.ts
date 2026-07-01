import { describe, expect, it } from "vitest";
import { renderAcknowledgement, renderFinalResult, renderProgress } from "../src/render.js";

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

  it("renders acknowledgement and progress helpers", () => {
    expect(renderAcknowledgement("run_1")).toBe("OpenTag picked this up. Run: `run_1`");
    expect(renderProgress({ runId: "run_1", message: "thinking" })).toBe(
      "OpenTag progress for `run_1`: thinking"
    );
  });
});