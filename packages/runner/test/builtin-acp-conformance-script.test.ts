import { describe, expect, it } from "vitest";
import {
  classifyAcpConformanceFailure,
  cancellationConformanceApplies,
  propagatedConformanceStatus,
  registryConformanceTargets
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
    expect(cancellationConformanceApplies({})).toBe(true);
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

  it("turns every launchable Registry entry into a data-driven batch target", () => {
    const batch = registryConformanceTargets({
      version: "1.0.0",
      agents: [
        {
          id: "codex-acp",
          name: "Codex",
          version: "1.1.2",
          description: "Codex ACP",
          distribution: { npx: { package: "@agentclientprotocol/codex-acp@1.1.2" } }
        },
        {
          id: "fast-agent",
          name: "fast-agent",
          version: "0.9.9",
          description: "fast-agent ACP",
          distribution: { uvx: { package: "fast-agent-acp==0.9.9", args: ["-x"] } }
        },
        {
          id: "binary-agent",
          name: "Binary Agent",
          version: "2.0.0",
          description: "Binary ACP",
          distribution: {
            binary: {
              "darwin-aarch64": {
                archive: "https://example.test/binary.tar.gz",
                cmd: "./binary-agent"
              }
            }
          }
        }
      ],
      extensions: []
    }, { aliases: { "codex-acp": "codex" }, platform: "darwin", arch: "arm64" });

    expect(batch.targets.map((target) => target.id)).toEqual(["codex", "fast-agent"]);
    expect(batch.needsSetup).toEqual([
      expect.objectContaining({ registryId: "binary-agent", status: "needs_setup", distribution: "binary" })
    ]);
  });
});
