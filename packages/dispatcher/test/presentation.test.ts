import { describe, expect, it } from "vitest";
import { createDefaultCallbackPresentation } from "../src/presentation.js";

describe("default callback presentation", () => {
  it("keeps Lark acknowledgements silent while preserving other provider acknowledgements", () => {
    const presentation = createDefaultCallbackPresentation();

    expect(presentation.shouldDeliverAcknowledgement("lark")).toBe(false);
    expect(presentation.shouldDeliverAcknowledgement("slack")).toBe(true);
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
    expect(presentation.acknowledgement({ provider: "slack", runId: "run_1" })).toBe("I picked this up: `run_1`");
    expect(presentation.acknowledgement({ provider: "telegram", runId: "run_1" })).toBe("I picked this up: run_1");
    expect(presentation.final({ provider: "github", result })).toEqual({
      body: "OpenTag finished with **success**.\n\ndone\n\nVerification:\n- `echo`: passed"
    });
    expect(presentation.final({ provider: "slack", result })).toEqual({
      body: "Finished with *success*.\n\ndone\n\n*Verification*\n- `echo`: passed",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Finished with success.*\ndone"
          }
        },
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Verification*\n- `echo`: passed"
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
    expect(presentation.final({ provider: "slack", result }).body).toContain("*Next action*: Approve intent_label_1");
    expect(presentation.final({ provider: "slack", result }).blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Finished with needs_human.*\nPrepared a suggested change snapshot."
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Next action*: Approve intent_label_1 to add the bug label."
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

    const github = presentation.final({ provider: "github", result }).body;
    expect(github).toContain("Suggested actions:");
    expect(github).toContain("1. **Add the bug label.**");
    expect(github).toContain("Proposal: `proposal_1`");
    expect(github).toContain("Intent ID: `intent_label_1`");
    expect(github).toContain("`apply 1`");

    const slack = presentation.final({ provider: "slack", result });
    expect(slack.body).toContain("*Suggested actions*");
    expect(slack.body).toContain("1. *Add the bug label.*");
    expect(slack.body).toContain("`continue 1`");
    expect(slack.blocks?.at(-1)).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn"
      }
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
    expect(github).toContain("Title: OpenTag run run_1");
    expect(github).toContain("Branch: `opentag/run_1` -> `main`");
    expect(github).toContain("Changed files: `src/demo.ts`");
    expect(github).toContain("`pnpm test`: passed");

    const slack = presentation.final({ provider: "slack", result });
    expect(slack.body).toContain("Title: OpenTag run run_1");
    expect(slack.body).toContain("Branch: `opentag/run_1` -> `main`");
    expect(slack.body).toContain("Changed files: `src/demo.ts`");
    expect(slack.body).toContain("`pnpm test`: passed");
    expect(JSON.stringify(slack.blocks)).toContain("Title: OpenTag run run_1");
    expect(JSON.stringify(slack.blocks)).toContain("`pnpm test`: passed");
  });
});
