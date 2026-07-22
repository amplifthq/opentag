import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyAcpConformanceFailure,
  cancellationConformanceApplies,
  propagatedConformanceStatus,
  providerRuntimeTimeoutAfterVerifiedTool,
  withDeadline
} from "../../../scripts/test/builtin-acp-conformance.js";

describe("built-in ACP conformance failure classification", () => {
  it.each([
    "Authentication required",
    "Hermes inference provider is unavailable",
    "Error calling LLM API: insufficient quota",
    "Model configured-model not found",
    "Hermes profile 'opentag' is not ready: Profile 'opentag' does not exist",
    "Hermes provider/runtime did not complete the ACP prompt after verified tool execution before the deadline.",
    "ACP bridge failed: connect ECONNREFUSED 127.0.0.1:18789"
  ])("records provider state without treating it as an implementation diagnosis: %s", (message) => {
    expect(classifyAcpConformanceFailure(new Error(message))).toBe("needs_setup");
  });

  it("classifies protocol and process-tree failures as conformance failures", () => {
    expect(classifyAcpConformanceFailure(new Error("Cancelled tool process 42 is still alive."))).toBe("failed_conformance");
    expect(classifyAcpConformanceFailure(new Error("hermes run 'scratch' exceeded 15000ms."))).toBe("failed_conformance");
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

  it("reclassifies only a deadline with a valid observed tool marker as external provider/runtime state", async () => {
    const root = mkdtempSync(join(tmpdir(), "opentag-hermes-provider-timeout-"));
    const markerPath = join(root, "marker.json");
    const nonce = "verified-tool";
    writeFileSync(markerPath, `${JSON.stringify({ nonce, pwd: root })}\n`);
    try {
      let deadline: unknown;
      try {
        await withDeadline(new Promise<never>(() => undefined), 5, "Hermes run exceeded its deadline.");
      } catch (error) {
        deadline = error;
      }
      const providerTimeout = providerRuntimeTimeoutAfterVerifiedTool({
        agent: "hermes",
        error: deadline,
        markerPath,
        nonce,
        expectedCwd: root
      });

      expect(providerTimeout).toBeInstanceOf(Error);
      expect(classifyAcpConformanceFailure(providerTimeout)).toBe("needs_setup");
      expect(providerRuntimeTimeoutAfterVerifiedTool({
        agent: "hermes",
        error: new Error("transport failed"),
        markerPath,
        nonce,
        expectedCwd: root
      })).toBeUndefined();
      expect(providerRuntimeTimeoutAfterVerifiedTool({
        agent: "codex",
        error: deadline,
        markerPath,
        nonce,
        expectedCwd: root
      })).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
