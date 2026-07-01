import { describe, expect, it } from "vitest";
import { createFinalSummaryPresentation } from "@opentag/core";
import { renderFinalResult, renderFinalSummaryPresentation } from "../src/render.js";

describe("GitHub result rendering", () => {
  it("renders suggested-action verification rows without requiring a command", () => {
    const result = {
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
    } as const;
    const body = renderFinalResult(result, {
      receiptContext: {
        capabilityByIntentId: {
          intent_create_pr: { state: "ready_to_apply" }
        }
      }
    });

    expect(body).toContain("### Ready to apply");
    expect(body).toContain("| Target | GitHub pull request |");
    expect(body).toContain("| Verification | `pnpm test`: passed<br>passed - Structured report parsed successfully. |");
    expect(body).toContain("| Apply now | `apply 1` |");
    expect(body.indexOf("| Apply now | `apply 1` |")).toBeLessThan(body.indexOf("| Reject | `reject 1` |"));
    expect(body).not.toContain("| Approve only | `approve 1` |");
    expect(body).not.toContain("Proposal:");
    expect(body).not.toContain("Intent ID:");
    expect(body).not.toContain("Next action:");
  });

  it("does not render apply commands without receipt capability proof", () => {
    const body = renderFinalResult({
      conclusion: "needs_human",
      summary: "Prepared a label change.",
      suggestedChanges: [
        {
          proposalId: "proposal_1",
          createdAt: "2026-06-29T00:00:00.000Z",
          summary: "Label issue.",
          intents: [
            {
              intentId: "intent_label",
              domain: "labels",
              action: "add_label",
              summary: "Add bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });

    expect(body).toContain("### Needs approval");
    expect(body).not.toContain("`apply 1`");
    expect(body).toContain("| Approve only | `approve 1` |");
    expect(body).toContain("| Reject | `reject 1` |");
  });

  it("renders source-thread action receipts from semantic final summary presentation", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_semantic_github",
      result: {
        conclusion: "needs_human",
        summary: "Prepared a pull request action.",
        verification: [{ command: "pnpm test", outcome: "passed" }],
        suggestedChanges: [
          {
            proposalId: "proposal_pr",
            createdAt: "2026-06-29T00:00:00.000Z",
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
                  risks: ["Review before merge."],
                  verification: [{ command: "pnpm test", outcome: "passed" }]
                }
              }
            ],
            preconditions: ["The branch still exists."]
          }
        ]
      },
      receiptContext: {
        capabilityByIntentId: {
          intent_create_pr: { state: "ready_to_apply" }
        }
      }
    });

    const body = renderFinalSummaryPresentation(presentation);

    expect(body).toContain("OpenTag finished with **needs_human**.");
    expect(body).toContain("Verification:\n- `pnpm test`: passed");
    expect(body).toContain("### Ready to apply");
    expect(body).toContain("Audit: run `opentag status --run run_semantic_github` locally.");
    expect(body).toContain("| Title | OpenTag run run_1 |");
    expect(body).toContain("| Branch | `opentag/run_1` -> `main` |");
    expect(body).toContain("| Changed files | `README.md` |");
    expect(body).toContain("| Verification | `pnpm test`: passed |");
    expect(body).toContain("| Risks | Review before merge. |");
    expect(body).toContain("| Preconditions | The branch still exists. |");
    expect(body).toContain("| Apply now | `apply 1` |");
    expect(body).not.toContain("Proposal:");
    expect(body).not.toContain("Intent ID:");
  });
});
