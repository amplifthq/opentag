import { describe, expect, it } from "vitest";
import { composeTeamRelayThreadProjection } from "../src/presentation.js";

describe("approval feedback on a thread projection", () => {
  const effect = { effectId: "effect_feedback", effectKind: "github.create_draft_pull_request" as const,
    updatedAt: "2026-09-08T00:00:00.000Z" };
  it("shows publication approved before any Runner acquisition and removes the button", () => {
    const view = composeTeamRelayThreadProjection({ runId: "run_feedback", generation: 1,
      state: "publication_pending", controls: [{kind:"effect_approve",actionId:"old_button",generation:1}],
      approval: {state:"authorized", actionDescriptor:"workspace.write"},
      publication: {...effect,state:"authorized",currentAttemptNumber:0} });
    expect(view.title).toBe("Publication approved");
    expect(view.summary).toContain("Waiting for the paired Runner");
    expect(view.summary).not.toContain("has not been approved");
    expect(view.summary).not.toContain("workspace.write");
    expect(view.controls).toEqual([]);
    expect(view.runOutcome).toBe("pending");
  });
  it("links only an observed Draft PR and preserves pending verification", () => {
    const resource = {provider:"github" as const,resourceRef:"github_pr_95",uri:"https://github.com/acme/demo/pull/95"};
    const view = composeTeamRelayThreadProjection({runId:"run_feedback",generation:1,
      state:"publication_pending",controls:[],publication:{...effect,state:"observing",currentAttemptNumber:1,
        currentEvidenceDigest:`sha256:${"a".repeat(64)}`,externalResource:resource}});
    expect(view.title).toBe("Draft PR created");
    expect(view.summary).toContain(resource.uri);
    expect(view.summary).toContain("Verification is still pending");
    expect(view.runOutcome).toBe("pending");
  });
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
