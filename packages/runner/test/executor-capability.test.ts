import { describe, expect, it } from "vitest";
import { createBuiltInAcpExecutors } from "../src/builtin-acp.js";
import { createEchoExecutor } from "../src/echo.js";
import { createHermesExecutor } from "../src/hermes.js";

describe("executor capability contracts", () => {
  it("exposes runtime capabilities for built-in executors", () => {
    const builtIns = createBuiltInAcpExecutors();
    const executors = [builtIns.codex, builtIns["claude-code"], createHermesExecutor(), createEchoExecutor()];

    for (const executor of executors) {
      expect(executor.capability).toMatchObject({
        id: executor.id,
        invocation: "spawn",
        supportsStreaming: executor.id === "codex" || executor.id === "claude-code",
        supportsCancel: executor.id === "codex" || executor.id === "claude-code",
        supportsHookCompletion: false,
        progressEvents: "audit",
        approvalMode: "opentag_policy",
        promptAssembly: executor.id === "hermes" ? "executor_adapter" : "opentag",
        writeAccess: executor.id === "echo" ? "none" : "workspace",
        conversationAccess: "request",
        promptMutation: "none",
        rawContextAccess: false,
        writeActionAccess: executor.id === "codex" || executor.id === "claude-code" ? "propose" : "none"
      });
      expect(executor.capability?.contextAccess).toContain("context_packet");
      expect(executor.capability?.contextAccess).toContain("context_pointers");
      expect(executor.capability?.completionSignals.length).toBeGreaterThan(0);
      expect(executor.capability?.requiredSecrets).toEqual(expect.any(Array));
    }

    expect(builtIns.codex.capability?.workspaceIsolation).toBe("worktree");
    expect(builtIns["claude-code"].capability?.workspaceIsolation).toBe("worktree");
    expect(createHermesExecutor().capability).toMatchObject({
      supportsProfile: true,
      workspaceIsolation: "branch"
    });
    expect(createEchoExecutor().capability?.workspaceIsolation).toBe("none");
  });

  it("requires explicit trust-boundary fields instead of runtime unknown fallbacks", () => {
    const capability = createBuiltInAcpExecutors().codex.capability;

    expect(capability).toMatchObject({
      progressEvents: "audit",
      approvalMode: "opentag_policy",
      contextAccess: ["context_packet", "context_pointers", "workspace"],
      promptAssembly: "opentag",
      writeAccess: "workspace",
      conversationAccess: "request",
      promptMutation: "none",
      rawContextAccess: false,
      writeActionAccess: "propose"
    });
  });
});
