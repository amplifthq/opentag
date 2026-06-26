import { describe, expect, it } from "vitest";
import { parseThreadActionCommand, suggestedActionCandidatesFromResult } from "../src/action.js";

describe("thread action commands", () => {
  it("parses explicit English action replies", () => {
    expect(parseThreadActionCommand("approve 1")).toEqual({
      verb: "approve",
      selection: { kind: "index", index: 1 },
      rawText: "approve 1"
    });
    expect(parseThreadActionCommand("apply all")).toEqual({
      verb: "apply",
      selection: { kind: "all" },
      rawText: "apply all"
    });
    expect(parseThreadActionCommand("continue proposal_run_1 because tests passed")).toEqual({
      verb: "continue",
      selection: { kind: "proposal", proposalId: "proposal_run_1" },
      rawText: "continue proposal_run_1 because tests passed",
      reason: "because tests passed"
    });
    expect(parseThreadActionCommand("reject intent_label_1")).toEqual({
      verb: "reject",
      selection: { kind: "intent", intentId: "intent_label_1" },
      rawText: "reject intent_label_1"
    });
  });

  it("does not treat regex-special selection tokens as parser syntax", () => {
    expect(parseThreadActionCommand("continue proposal_[x because tests passed")).toEqual({
      verb: "continue",
      selection: { kind: "proposal", proposalId: "proposal_[x" },
      rawText: "continue proposal_[x because tests passed",
      reason: "because tests passed"
    });
  });

  it("parses concise Chinese action replies", () => {
    expect(parseThreadActionCommand("批准 1")).toEqual({
      verb: "approve",
      selection: { kind: "index", index: 1 },
      rawText: "批准 1"
    });
    expect(parseThreadActionCommand("应用 全部")).toEqual({
      verb: "apply",
      selection: { kind: "all" },
      rawText: "应用 全部"
    });
    expect(parseThreadActionCommand("继续执行")).toEqual({
      verb: "continue",
      selection: { kind: "latest" },
      rawText: "继续执行"
    });
    expect(parseThreadActionCommand("拒绝 2")).toEqual({
      verb: "reject",
      selection: { kind: "index", index: 2 },
      rawText: "拒绝 2"
    });
  });

  it("ignores ambiguous conversational text", () => {
    expect(parseThreadActionCommand("looks good to me")).toBeNull();
    expect(parseThreadActionCommand("maybe apply this later")).toBeNull();
  });
});

describe("suggested action candidates", () => {
  it("flattens result suggested changes into stable action numbers", () => {
    expect(
      suggestedActionCandidatesFromResult({
        conclusion: "needs_human",
        summary: "Prepared actions.",
        suggestedChanges: [
          {
            proposalId: "proposal_1",
            createdAt: "2026-06-24T00:00:00.000Z",
            summary: "Move issue forward.",
            intents: [
              { intentId: "intent_label", domain: "labels", action: "add_label", summary: "Add bug label." },
              { intentId: "intent_review", domain: "review", action: "request_review", summary: "Ask for review." }
            ]
          }
        ]
      }).map((candidate) => ({
        index: candidate.index,
        proposalId: candidate.proposalId,
        intentId: candidate.intent.intentId
      }))
    ).toEqual([
      { index: 1, proposalId: "proposal_1", intentId: "intent_label" },
      { index: 2, proposalId: "proposal_1", intentId: "intent_review" }
    ]);
  });
});
