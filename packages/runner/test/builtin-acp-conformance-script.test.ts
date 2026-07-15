import { describe, expect, it } from "vitest";
import {
  classifyAcpConformanceFailure,
  cancellationConformanceApplies,
  propagatedConformanceStatus,
  withDeadline
} from "../../../scripts/test/builtin-acp-conformance.js";

describe("built-in ACP conformance failure classification", () => {
  it.each([
    "Authentication required",
    "Hermes inference provider is unavailable",
    "Error calling LLM API: insufficient quota",
    "Model configured-model not found",
    "Hermes profile 'opentag' is not ready: Profile 'opentag' does not exist",
    "ACP bridge failed: connect ECONNREFUSED 127.0.0.1:18789"
  ])("records provider state without treating it as an implementation diagnosis: %s", (message) => {
    expect(classifyAcpConformanceFailure(new Error(message))).toBe("needs_setup");
  });

  it("classifies protocol and process-tree failures as conformance failures", () => {
    expect(classifyAcpConformanceFailure(new Error("Cancelled tool process 42 is still alive."))).toBe("failed_conformance");
  });

  it("keeps best-effort cancellation providers in the batch without claiming process-tree conformance", () => {
    expect(cancellationConformanceApplies({ capabilities: { supportsCancel: false } })).toBe(false);
    expect(cancellationConformanceApplies({ capabilities: { supportsCancel: true } })).toBe(true);
    expect(cancellationConformanceApplies({})).toBe(false);
    expect(propagatedConformanceStatus(
      { capabilities: { supportsCancel: false } },
      "cancel-process-tree",
      "needs_setup"
    )).toBe("not_applicable");
    expect(propagatedConformanceStatus(
      { capabilities: { supportsCancel: false } },
      "cancel-process-tree",
      "failed_conformance"
    )).toBe("not_applicable");
  });

  it("uses sanitized executor failure events to preserve provider-state classification", () => {
    expect(classifyAcpConformanceFailure(
      new Error("ACP agent cursor protocol or exit failure."),
      ["ACP diagnostic (transport); command=cursor-agent; detail=Authentication required"]
    )).toBe("needs_setup");
  });

  it("rejects when an operation does not settle before its deadline", async () => {
    await expect(withDeadline(new Promise<never>(() => undefined), 10, "test operation timed out")).rejects.toThrow(
      "test operation timed out"
    );
  });
});
