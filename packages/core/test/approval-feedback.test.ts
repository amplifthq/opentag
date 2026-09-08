import { describe, expect, it } from "vitest";
import { composeTeamRelayThreadProjection } from "../src/presentation.js";

describe("approval feedback on a thread projection", () => {
  it("distinguishes a waiting inline action from generic running", () => {
    const view = composeTeamRelayThreadProjection({ runId: "run_feedback", generation: 1,
      state: "running", controls: [], approval: { state: "waiting", actionDescriptor: "workspace.write" } });
    expect(view.title).toBe("Waiting for approval");
    expect(view.summary).toContain("workspace.write");
  });
  it.each(["authorized", "denied"] as const)("shows persisted %s without claiming execution success", state => {
    const view = composeTeamRelayThreadProjection({ runId: "run_feedback", generation: 1,
      state: "running", controls: [], approval: { state, actionDescriptor: "workspace.write" },
      providerDelivery: { state: "pending" } });
    expect(view.summary).toContain(state === "authorized" ? "Approved once" : "Denied");
    expect(view.summary).toContain("workspace.write");
    expect(view.runOutcome).toBe("pending");
    expect(view.providerDelivery?.state).toBe("pending");
  });
  it("retains approval as a separate fact after timeout", () => {
    const view = composeTeamRelayThreadProjection({ runId: "run_feedback", generation: 1,
      state: "timed_out", controls: [], approval: { state: "authorized", actionDescriptor: "workspace.write" } });
    expect(view.title).toBe("Timed out");
    expect(view.summary).toContain("Approved once");
    expect(view.runOutcome).toBe("timed_out");
    expect(view.summary).not.toContain("continuing");
  });
});
