import { describe, expect, it } from "vitest";
import {
  createActionReceiptPresentation,
  createDoctorSummaryPresentation,
  createFinalSummaryPresentation,
  createRunStatusPresentation,
  createSourceThreadStatusPresentation,
  OpenTagPresentationSchema,
  renderOpenTagPresentationPlainText
} from "../src/presentation.js";

describe("OpenTagPresentation", () => {
  it("creates a provider-neutral final summary presentation", () => {
    const presentation = createFinalSummaryPresentation({
      result: {
        conclusion: "success",
        summary: "Updated the failing test.",
        changedFiles: ["packages/core/test/demo.test.ts"],
        verification: [{ command: "pnpm test", outcome: "passed" }]
      },
      auditRunId: "run_1"
    });

    expect(OpenTagPresentationSchema.parse(presentation)).toEqual(presentation);
    expect(presentation).toMatchObject({
      kind: "final_summary",
      outcome: "success",
      summary: "Updated the failing test.",
      changedFiles: ["packages/core/test/demo.test.ts"],
      verification: [{ command: "pnpm test", outcome: "passed" }],
      auditRunId: "run_1"
    });
    expect(JSON.stringify(presentation)).not.toContain("blocks");
    expect(JSON.stringify(presentation)).not.toContain("mrkdwn");
    expect(renderOpenTagPresentationPlainText(presentation)).toContain("Audit: opentag status --run run_1");
  });

  it("carries action receipt semantics without provider-native UI fields", () => {
    const presentation = createFinalSummaryPresentation({
      result: {
        conclusion: "needs_human",
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
            ]
          }
        ]
      },
      receiptContext: {
        capabilityByIntentId: {
          intent_label_1: {
            state: "ready_to_apply",
            targetLabel: "GitHub labels",
            visibleDecisions: ["apply", "reject"],
            primaryDecision: "apply"
          }
        }
      },
      auditRunId: "run_receipt_1"
    });

    expect(presentation.actionReceiptTitle).toBe("Ready to apply");
    expect(presentation.actions).toEqual([
      {
        index: 1,
        proposalId: "proposal_1",
        intentId: "intent_label_1",
        title: "Add the bug label.",
        state: "ready_to_apply",
        targetLabel: "GitHub labels",
        visibleDecisions: ["apply", "reject"],
        primaryDecision: "apply",
        detailRows: [{ label: "Target", value: "GitHub labels" }]
      }
    ]);
    expect(JSON.stringify(presentation)).not.toContain("button");
    expect(JSON.stringify(presentation)).not.toContain("action_id");
    const rendered = renderOpenTagPresentationPlainText(presentation);
    expect(rendered).toContain("Finished: needs_human");
    expect(rendered).toContain("Ready to apply");
    expect(rendered).toContain("1. Add the bug label.");
    expect(rendered).toContain("Target: GitHub labels");
    expect(rendered).toContain("Actions: apply 1, reject 1");
    expect(rendered).toContain("Audit: opentag status --run run_receipt_1");
  });

  it("carries provider-neutral action details for native renderers", () => {
    const presentation = createFinalSummaryPresentation({
      result: {
        conclusion: "needs_human",
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
                summary: "Create a pull request.",
                params: {
                  head: "opentag/run_1",
                  base: "main",
                  changedFiles: ["src/demo.ts"]
                }
              }
            ],
            preconditions: ["The branch still exists."]
          }
        ]
      }
    });

    expect(presentation.actions?.[0]).toMatchObject({
      proposalId: "proposal_pr",
      intentId: "intent_create_pr",
      details: ["Branch: `opentag/run_1` -> `main`", "Changed files: `src/demo.ts`", "Preconditions: 1 check(s) in the audit log."],
      detailRows: [
        { label: "Target", value: "GitHub pull request" },
        { label: "Branch", value: "`opentag/run_1` -> `main`" },
        { label: "Changed files", value: "`src/demo.ts`" },
        { label: "Preconditions", value: "The branch still exists." }
      ]
    });
    const rendered = renderOpenTagPresentationPlainText(presentation);
    expect(rendered).toContain("Branch: `opentag/run_1` -> `main`");
    expect(rendered).toContain("Changed files: `src/demo.ts`");
    expect(rendered).toContain("Preconditions: 1 check(s) in the audit log.");
    expect(JSON.stringify(presentation)).not.toContain("blocks");
    expect(JSON.stringify(presentation)).not.toContain("action_id");
  });

  it("renders standalone action receipts with command and audit fallback", () => {
    const presentation = createActionReceiptPresentation({
      auditRunId: "run_receipt_1",
      result: {
        conclusion: "needs_human",
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
            ]
          }
        ]
      },
      receiptContext: {
        capabilityByIntentId: {
          intent_label_1: {
            state: "ready_to_apply",
            visibleDecisions: ["apply", "reject"]
          }
        }
      }
    });

    expect(presentation).toMatchObject({
      kind: "action_receipt",
      title: "Ready to apply",
      auditRunId: "run_receipt_1"
    });
    expect(JSON.stringify(presentation)).not.toContain("blocks");
    expect(JSON.stringify(presentation)).not.toContain("button");
    expect(renderOpenTagPresentationPlainText(presentation!)).toBe(
      [
        "Ready to apply",
        "1. Add the bug label.",
        "Target: GitHub labels",
        "Actions: apply 1, reject 1",
        "Audit: opentag status --run run_receipt_1"
      ].join("\n")
    );
  });

  it("can represent interrupted run status without provider-native UI fields", () => {
    const presentation = createRunStatusPresentation({
      runId: "run_interrupted",
      state: "interrupted",
      nextAction: "Inspect audit logs before retrying."
    });

    expect(OpenTagPresentationSchema.parse(presentation)).toEqual({
      kind: "run_status",
      runId: "run_interrupted",
      state: "interrupted",
      nextAction: "Inspect audit logs before retrying."
    });
    expect(JSON.stringify(presentation)).not.toContain("blocks");
  });

  it("creates a provider-neutral doctor summary presentation", () => {
    const presentation = createDoctorSummaryPresentation({
      title: "OpenTag doctor (redacted)",
      checks: [
        { status: "ok", name: "dispatcher", message: "reachable" },
        { status: "warn", name: "runner", message: "registration not found" },
        { status: "fail", name: "executor", message: "codex missing" }
      ]
    });

    expect(OpenTagPresentationSchema.parse(presentation)).toEqual({
      kind: "doctor_summary",
      title: "OpenTag doctor (redacted)",
      checks: [
        { status: "ok", name: "dispatcher", message: "reachable" },
        { status: "warn", name: "runner", message: "registration not found" },
        { status: "fail", name: "executor", message: "codex missing" }
      ]
    });
    expect(JSON.stringify(presentation)).not.toContain("blocks");
    expect(JSON.stringify(presentation)).not.toContain("mrkdwn");
    expect(JSON.stringify(presentation)).not.toContain("button");
    expect(renderOpenTagPresentationPlainText(presentation)).toBe(
      [
        "OpenTag doctor (redacted)",
        "OK dispatcher: reachable",
        "WARN runner: registration not found",
        "FAIL executor: codex missing"
      ].join("\n")
    );
  });

  it("creates a provider-neutral source-thread status presentation", () => {
    const presentation = createSourceThreadStatusPresentation({
      title: "OpenTag status",
      sourceContainer: "lark:tenant_1/oc_chat",
      projectTarget: "github:acme/demo",
      bindingState: "bound",
      activeRun: { id: "run_active", status: "running", updatedAt: "2026-06-24T00:01:00.000Z" },
      queuedFollowUps: [{ id: "follow_up_1", status: "queued", command: "update the docs" }],
      queuedFollowUpsTotal: 3,
      currentCommand: "fix the failing test",
      nextAction: "wait for the final reply, send a follow-up, or request cancellation with /stop.",
      stopHint: "cancellation is explicit and is not reported as successful completion.",
      detailHint: "use `opentag status --run run_active` locally for audit detail."
    });

    expect(OpenTagPresentationSchema.parse(presentation)).toEqual({
      kind: "source_thread_status",
      title: "OpenTag status",
      sourceContainer: "lark:tenant_1/oc_chat",
      projectTarget: "github:acme/demo",
      bindingState: "bound",
      activeRun: { id: "run_active", status: "running", updatedAt: "2026-06-24T00:01:00.000Z" },
      queuedFollowUps: [{ id: "follow_up_1", status: "queued", command: "update the docs" }],
      queuedFollowUpsTotal: 3,
      currentCommand: "fix the failing test",
      nextAction: "wait for the final reply, send a follow-up, or request cancellation with /stop.",
      stopHint: "cancellation is explicit and is not reported as successful completion.",
      detailHint: "use `opentag status --run run_active` locally for audit detail."
    });
    expect(JSON.stringify(presentation)).not.toContain("blocks");
    expect(JSON.stringify(presentation)).not.toContain("mrkdwn");
    expect(JSON.stringify(presentation)).not.toContain("button");
    expect(renderOpenTagPresentationPlainText(presentation)).toBe(
      [
        "OpenTag status",
        "Source container: lark:tenant_1/oc_chat",
        "Project Target: github:acme/demo",
        "Active run: run_active (running), updated 2026-06-24T00:01:00.000Z",
        "Command: fix the failing test",
        "Queued follow-ups: 3 (follow_up_1 (queued): update the docs, +2 more)",
        "Next action: wait for the final reply, send a follow-up, or request cancellation with /stop.",
        "Stop/timeout: cancellation is explicit and is not reported as successful completion.",
        "Details: use `opentag status --run run_active` locally for audit detail."
      ].join("\n")
    );
  });
});
