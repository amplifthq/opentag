import { describe, expect, it } from "vitest";
import { createDefaultCallbackPresentation } from "../src/presentation.js";

describe("default callback presentation", () => {
  it("keeps chat acknowledgements quiet where thread noise matters", () => {
    const presentation = createDefaultCallbackPresentation();

    expect(presentation.shouldDeliverAcknowledgement("lark")).toBe(false);
    expect(presentation.shouldDeliverAcknowledgement("slack")).toBe(false);
    expect(presentation.shouldDeliverAcknowledgement("telegram")).toBe(true);
    expect(presentation.shouldDeliverAcknowledgement("github")).toBe(true);
  });

  it("keeps chat progress audit-only while allowing GitHub and Telegram progress delivery", () => {
    const presentation = createDefaultCallbackPresentation();

    expect(presentation.shouldDeliverProgress("slack")).toBe(false);
    expect(presentation.shouldDeliverProgress("lark")).toBe(false);
    expect(presentation.shouldDeliverProgress("telegram")).toBe(true);
    expect(presentation.shouldDeliverProgress("github")).toBe(true);
  });

  it("renders GitHub and Slack with provider-specific markup", () => {
    const presentation = createDefaultCallbackPresentation();
    const result = {
      conclusion: "success" as const,
      summary: "done",
      verification: [{ command: "echo", outcome: "passed" as const }]
    };

    expect(presentation.acknowledgement({ provider: "github", runId: "run_1" })).toBe("OpenTag picked this up. Run: `run_1`");
    expect(presentation.acknowledgement({ provider: "slack", runId: "run_1" })).toBe("Working on it.");
    expect(presentation.acknowledgement({ provider: "telegram", runId: "run_1" })).toBe("I picked this up: run_1");
    expect(presentation.final({ provider: "github", result })).toEqual({
      body: "OpenTag finished with **success**.\n\ndone\n\nVerification:\n- `echo`: passed"
    });
    expect(presentation.final({ provider: "slack", result })).toEqual({
      body: "*Finished: success.*\ndone\nVerified: `echo` passed",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Finished: success.*\ndone"
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Verified: `echo` passed"
          }
        }
      ]
    });
    expect(presentation.final({ provider: "telegram", result })).toEqual({
      body: "Finished with success.\n\ndone\n\nVerification:\n- echo: passed"
    });
  });

  it("renders Telegram progress as concise conversational states", () => {
    const presentation = createDefaultCallbackPresentation();

    expect(presentation.progress({ provider: "telegram", runId: "run_1", message: "Starting claude --print" })).toBe(
      "Thinking..."
    );
    expect(
      presentation.progress({
        provider: "telegram",
        runId: "run_1",
        message: "Creating isolated branch opentag/run_1"
      })
    ).toBe("Working...");
  });

  it("renders structured next actions by summary", () => {
    const presentation = createDefaultCallbackPresentation();
    const result = {
      conclusion: "needs_human" as const,
      summary: "Prepared a suggested change snapshot.",
      nextAction: {
        summary: "Approve intent_label_1 to add the bug label.",
        hint: {
          kind: "apply_suggested_changes" as const,
          targetId: "proposal_1",
          selectedIntentIds: ["intent_label_1"]
        }
      }
    };

    expect(presentation.final({ provider: "github", result }).body).toContain("Next action: Approve intent_label_1");
    expect(presentation.final({ provider: "slack", result }).body).toContain("Next: Approve intent_label_1");
    expect(presentation.final({ provider: "slack", result }).blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Finished: needs_human.*\nPrepared a suggested change snapshot."
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Next: Approve intent_label_1 to add the bug label."
        }
      }
    ]);
    expect(presentation.final({ provider: "github", result }).body).not.toContain("[object Object]");
  });

  it("renders suggested changes as thread-native actions", () => {
    const presentation = createDefaultCallbackPresentation();
    const result = {
      conclusion: "needs_human" as const,
      summary: "Prepared a proposal.",
      suggestedChanges: [
        {
          proposalId: "proposal_1",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Move issue forward.",
          intents: [
            {
              intentId: "intent_label_1",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ],
          preconditions: ["The issue is still open."]
        }
      ]
    };
    const receiptContext = {
      capabilityByIntentId: {
        intent_label_1: { state: "ready_to_apply" as const }
      }
    };

    const github = presentation.final({ provider: "github", result, runId: "run_receipt_1", receiptContext }).body;
    expect(github).toContain("### Ready to apply");
    expect(github).toContain("source-thread action receipt");
    expect(github).toContain("Audit: run `opentag status --run run_receipt_1` locally.");
    expect(github).toContain("#### 1. Add the bug label.");
    expect(github).toContain("| Target | GitHub labels |");
    expect(github).toContain("| Preconditions | The issue is still open. |");
    expect(github).toContain("| Apply now | `apply 1` |");
    expect(github).not.toContain("| Approve only | `approve 1` |");
    expect(github).not.toContain("| Continue | `continue 1` |");
    expect(github).not.toContain("Proposal: `proposal_1`");
    expect(github).not.toContain("Intent ID: `intent_label_1`");

    const slack = presentation.final({ provider: "slack", result, runId: "run_receipt_1", receiptContext });
    expect(slack.body).toContain("*Ready to apply*");
    expect(slack.body).not.toContain("opentag status --run");
    expect(slack.body).toContain("1. *Add the bug label.*");
    expect(slack.body).toContain("Target: GitHub labels");
    expect(slack.body).not.toContain("Proposal:");
    expect(slack.body).not.toContain("Intent ID:");
    expect(slack.blocks?.at(-2)).toMatchObject({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Apply 1" }, action_id: "opentag:apply:1", style: "primary" },
        { type: "button", text: { type: "plain_text", text: "Reject" }, action_id: "opentag:reject:1", style: "danger" }
      ]
    });
    expect(slack.blocks?.at(-1)).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Audit: `opentag status --run run_receipt_1`" }]
    });
  });

  it("renders create PR suggested actions with PR-specific details", () => {
    const presentation = createDefaultCallbackPresentation();
    const result = {
      conclusion: "needs_human" as const,
      summary: "Prepared a PR proposal.",
      suggestedChanges: [
        {
          proposalId: "proposal_pr",
          createdAt: "2026-06-24T00:00:00.000Z",
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
                changedFiles: ["src/demo.ts"],
                risks: ["Review before merge."],
                verification: [{ command: "pnpm test", outcome: "passed" }]
              }
            }
          ]
        }
      ]
    };

    const github = presentation.final({ provider: "github", result }).body;
    expect(github).toContain("| Target | GitHub pull request |");
    expect(github).toContain("| Title | OpenTag run run_1 |");
    expect(github).toContain("| Branch | `opentag/run_1` -> `main` |");
    expect(github).toContain("| Changed files | `src/demo.ts` |");
    expect(github).toContain("| Verification | `pnpm test`: passed |");
    expect(github).toContain("| Risks | Review before merge. |");

    const slack = presentation.final({ provider: "slack", result });
    expect(slack.body).toContain("Branch: `opentag/run_1` -> `main`");
    expect(slack.body).toContain("Changed files: `src/demo.ts`");
    expect(slack.body).not.toContain("Title: OpenTag run run_1");
    expect(slack.body).not.toContain("`pnpm test`: passed");
    expect(JSON.stringify(slack.blocks)).toContain("Branch: `opentag/run_1` -> `main`");
    expect(JSON.stringify(slack.blocks)).not.toContain("Title: OpenTag run run_1");
  });
});
