import {
  createActionReceiptPresentation,
  createDoctorSummaryPresentation,
  createFinalSummaryPresentation,
  createSourceThreadStatusPresentation,
  type OpenTagRunResult
} from "@opentag/core";
import { describe, expect, it } from "vitest";
import {
  createLarkActionReceiptCard,
  createLarkDoctorSummaryCard,
  createLarkFinalSummaryCard,
  createLarkInteractiveMessageContent,
  createLarkSourceThreadStatusCard,
  createLarkTextMessageContent,
  renderLarkActionReceiptPresentation,
  renderLarkAcknowledgement,
  renderLarkFinalSummaryPresentation,
  renderLarkFinalResult
} from "../src/index.js";

describe("renderLarkAcknowledgement", () => {
  it("renders a quiet received acknowledgement with audit guidance", () => {
    expect(renderLarkAcknowledgement("run_1")).toBe(
      ["Received. OpenTag is working.", "Run: run_1", "Use /status here for queue state; audit locally with opentag status --run run_1."].join("\n")
    );
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
    const text = renderLarkFinalResult(result, { auditRunId: "run_1" });
    expect(text).toContain("success");
    expect(text).toContain("Did the thing.");
    expect(text).toContain("pnpm test");
    expect(text).toContain("passed");
    expect(text).toContain("Review the PR.");
    expect(text).toContain("Audit: opentag status --run run_1");
  });

  it("handles a structured nextAction", () => {
    const result: OpenTagRunResult = {
      conclusion: "needs_human",
      summary: "Need a decision.",
      nextAction: { summary: "Pick an option", hint: { kind: "request_human_decision" } }
    };
    expect(renderLarkFinalResult(result)).toContain("Pick an option");
  });

  it("renders final fallback text from semantic final summary presentation", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_semantic_lark",
      result: {
        conclusion: "success",
        summary: "Did the semantic thing.",
        verification: [{ command: "pnpm test", outcome: "passed" }],
        nextAction: "Review the source thread."
      }
    });

    const text = renderLarkFinalSummaryPresentation(presentation);

    expect(text).toBe(
      [
        "Finished with success.",
        "",
        "Did the semantic thing.",
        "",
        "Verification",
        "- pnpm test: passed",
        "",
        "Next action: Review the source thread.",
        "",
        "Audit: opentag status --run run_semantic_lark"
      ].join("\n")
    );
  });
});

describe("createLarkActionReceiptCard", () => {
  it("renders a standalone source-thread action receipt card", () => {
    const presentation = createActionReceiptPresentation({
      auditRunId: "run_lark_receipt_standalone",
      result: {
        conclusion: "needs_human",
        summary: "Prepared a pull request action.",
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
                  head: "opentag/run_1",
                  base: "main",
                  changedFiles: ["README.md"]
                }
              }
            ]
          }
        ]
      },
      receiptContext: {
        capabilityByIntentId: {
          intent_create_pr: { state: "ready_to_apply" }
        }
      }
    });
    if (!presentation) throw new Error("expected action receipt presentation");

    const text = renderLarkActionReceiptPresentation(presentation);
    const card = createLarkActionReceiptCard(presentation);
    const rendered = JSON.stringify(card);

    expect(text).toContain("Ready to apply");
    expect(text).toContain("Apply now: apply 1");
    expect(card.header).toEqual({
      template: "blue",
      title: { tag: "plain_text", content: "Ready to apply" }
    });
    expect(rendered).toContain("Create a pull request for branch opentag/run_1.");
    expect(rendered).toContain("Branch: opentag/run_1 -> main");
    expect(rendered).toContain("Apply now: apply 1");
    expect(rendered).toContain("Reject: reject 1");
    expect(rendered).toContain("Audit: opentag status --run run_lark_receipt_standalone");
    expect(rendered).not.toContain("proposal_pr");
    expect(rendered).not.toContain("intent_create_pr");
    expect(JSON.parse(createLarkInteractiveMessageContent(card))).toEqual(card);
  });
});

describe("createLarkSourceThreadStatusCard", () => {
  it("renders active run and queue status from semantic status presentation", () => {
    const presentation = createSourceThreadStatusPresentation({
      title: "OpenTag status:",
      sourceContainer: "lark:tenant_1/oc_chat",
      projectTarget: "github:acme/demo",
      bindingState: "bound",
      activeRun: { id: "run_active", status: "running", updatedAt: "2026-06-24T00:01:00.000Z" },
      queuedFollowUps: [{ id: "follow_up_1", status: "queued", command: "update the docs" }],
      queuedFollowUpsTotal: 2,
      currentCommand: "fix this",
      nextAction: "wait for the final reply or use /stop.",
      stopHint: "cancellation is explicit.",
      detailHint: "use `opentag status --run run_active` locally."
    });

    const card = createLarkSourceThreadStatusCard(presentation);

    expect(card.header).toEqual({
      template: "blue",
      title: { tag: "plain_text", content: "OpenTag status" }
    });
    expect(JSON.stringify(card)).toContain("github:acme/demo");
    expect(JSON.stringify(card)).toContain("run_active (running)");
    expect(JSON.stringify(card)).toContain("fix this");
    expect(JSON.stringify(card)).toContain("2 (follow_up_1 (queued): update the docs, +1 more)");
    expect(JSON.stringify(card)).toContain("Stop/timeout: cancellation is explicit.");
  });
});

describe("createLarkDoctorSummaryCard", () => {
  it("uses warning styling when any readiness check warns", () => {
    const presentation = createDoctorSummaryPresentation({
      title: "OpenTag doctor (redacted):",
      checks: [
        { status: "ok", name: "Dispatcher", message: "reachable" },
        { status: "warn", name: "Runtime readiness", message: "heartbeat stale" }
      ]
    });

    const card = createLarkDoctorSummaryCard(presentation);

    expect(card.header).toEqual({
      template: "yellow",
      title: { tag: "plain_text", content: "OpenTag doctor (redacted)" }
    });
    expect(JSON.stringify(card)).toContain("OK Dispatcher");
    expect(JSON.stringify(card)).toContain("WARN Runtime readiness");
    expect(JSON.stringify(card)).toContain("heartbeat stale");
  });
});

describe("createLarkFinalSummaryCard", () => {
  it("renders a Lark-native card from semantic final summary presentation", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_1",
      result: {
        conclusion: "success",
        summary: "Did the thing.",
        changedFiles: ["packages/lark/src/render.ts"],
        verification: [{ command: "pnpm test", outcome: "passed" }],
        nextAction: "Review the PR."
      }
    });

    const card = createLarkFinalSummaryCard(presentation);

    expect(card).toMatchObject({
      config: { wide_screen_mode: true },
      header: {
        template: "green",
        title: { tag: "plain_text", content: "Finished: success" }
      }
    });
    expect(JSON.stringify(card)).toContain("Did the thing.");
    expect(JSON.stringify(card)).toContain("pnpm test: passed");
    expect(JSON.stringify(card)).toContain("packages/lark/src/render.ts");
    expect(JSON.stringify(card)).toContain("Review the PR.");
    expect(JSON.stringify(card)).toContain("Audit: opentag status --run run_1");
    expect(JSON.stringify(card)).not.toContain("blocks");
    expect(JSON.parse(createLarkInteractiveMessageContent(card))).toEqual(card);
  });

  it("renders source-thread action receipts in the Lark-native final card", () => {
    const presentation = createFinalSummaryPresentation({
      auditRunId: "run_lark_receipt",
      result: {
        conclusion: "needs_human",
        summary: "Prepared a pull request action.",
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
                  head: "opentag/run_1",
                  base: "main",
                  changedFiles: ["README.md"]
                }
              }
            ]
          }
        ]
      },
      receiptContext: {
        capabilityByIntentId: {
          intent_create_pr: { state: "ready_to_apply" }
        }
      }
    });

    const card = createLarkFinalSummaryCard(presentation);
    const rendered = JSON.stringify(card);

    expect(rendered).toContain("Ready to apply");
    expect(rendered).toContain("Choose a command in this source thread");
    expect(rendered).toContain("Create a pull request for branch opentag/run_1.");
    expect(rendered).toContain("Target: GitHub pull request");
    expect(rendered).toContain("Branch: opentag/run_1 -> main");
    expect(rendered).toContain("Changed files: README.md");
    expect(rendered).toContain("Apply now: apply 1");
    expect(rendered).toContain("Reject: reject 1");
    expect(rendered).toContain("Audit: opentag status --run run_lark_receipt");
    expect(rendered).not.toContain("proposal_pr");
    expect(rendered).not.toContain("intent_create_pr");
  });
});

describe("createLarkTextMessageContent", () => {
  it("produces JSON-encoded text content", () => {
    expect(createLarkTextMessageContent("hi")).toBe('{"text":"hi"}');
  });
});
