import { describe, expect, it } from "vitest";
import { renderFinalResult } from "../src/render.js";

describe("GitHub result rendering", () => {
  it("renders suggested-action verification rows without requiring a command", () => {
    const body = renderFinalResult({
      conclusion: "success",
      summary: "Prepared a branch.",
      suggestedChanges: [
        {
          proposalId: "proposal_1",
          createdAt: "2026-06-29T00:00:00.000Z",
          sourceRunId: "run_1",
          summary: "Create a pull request.",
          intents: [
            {
              intentId: "intent_create_pr",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create a pull request for branch opentag/run_1.",
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
});
