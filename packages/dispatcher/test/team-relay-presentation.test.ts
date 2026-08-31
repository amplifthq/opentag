import { describe, expect, it } from "vitest";
import { composeTeamRelayThreadProjection } from "../src/presentation.js";

describe("team relay thread projection", () => {
  it.each([
    ["waiting_for_runner", "Waiting for your paired Runner"],
    ["running", "Running"],
    ["proposal_ready", "Proposal ready"],
    ["ready_for_review", "Ready for review"],
  ] as const)("maps %s from canonical Run truth to literal source copy", (state, title) => {
    const presentation = composeTeamRelayThreadProjection({
      runId: "run_1",
      generation: 3,
      state,
      controls: [{ kind: "status", actionId: "status_3", generation: 3 }],
    });

    expect(presentation.title).toBe(title);
    expect(JSON.stringify(presentation)).not.toContain("Working on it");
  });

  it("keeps provider delivery failure separate from a successful Run outcome", () => {
    const presentation = composeTeamRelayThreadProjection({
      runId: "run_1",
      generation: 4,
      state: "proposal_ready",
      controls: [],
      providerDelivery: {
        state: "attention",
        reasonCode: "delivery_deadline_exceeded",
      },
    });

    expect(presentation.title).toBe("Proposal ready");
    expect(presentation.runOutcome).toBe("succeeded");
    expect(presentation.providerDelivery).toEqual({
      state: "attention",
      reasonCode: "delivery_deadline_exceeded",
      message: "Slack status delivery needs attention.",
    });
  });

  it("rejects controls from an older projection generation", () => {
    expect(() => composeTeamRelayThreadProjection({
      runId: "run_1",
      generation: 5,
      state: "publication_pending",
      controls: [{ kind: "approve", actionId: "approve_4", generation: 4 }],
    })).toThrow("source_thread_control_generation_stale");
  });
});
