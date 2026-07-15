import { describe, expect, it } from "vitest";
import { createAcpAgentExecutor } from "../src/acp-agent.js";
import { createEchoExecutor } from "../src/echo.js";

function acpExecutor(id: string, supportsProfile = false) {
  return createAcpAgentExecutor({
    id,
    label: id,
    workspaceCwd: "required",
    launch: { command: id, args: ["acp"] },
    capabilities: { supportsProfile }
  });
}

describe("executor capability contracts", () => {
  it("exposes runtime capabilities for built-in executors", () => {
    const codex = acpExecutor("codex");
    const claudeCode = acpExecutor("claude-code");
    const hermes = acpExecutor("hermes", true);
    const executors = [codex, claudeCode, hermes, createEchoExecutor()];

    for (const executor of executors) {
      expect(executor.capability).toMatchObject({
        id: executor.id,
        invocation: "spawn",
        supportsStreaming: executor.id !== "echo",
        supportsCancel: executor.id !== "echo",
        supportsHookCompletion: false,
        progressEvents: "audit",
        approvalMode: "opentag_policy",
        promptAssembly: "opentag",
        writeAccess: executor.id === "echo" ? "none" : "workspace",
        conversationAccess: "request",
        promptMutation: "none",
        rawContextAccess: false,
        writeActionAccess: executor.id === "echo" ? "none" : "propose"
      });
      expect(executor.capability?.contextAccess).toContain("context_packet");
      expect(executor.capability?.contextAccess).toContain("context_pointers");
      expect(executor.capability?.completionSignals.length).toBeGreaterThan(0);
      expect(executor.capability?.requiredSecrets).toEqual(expect.any(Array));
    }

    expect(codex.capability?.workspaceIsolation).toBe("worktree");
    expect(claudeCode.capability?.workspaceIsolation).toBe("worktree");
    expect(hermes.capability).toMatchObject({
      supportsProfile: true,
      workspaceIsolation: "worktree"
    });
    expect(createEchoExecutor().capability?.workspaceIsolation).toBe("none");
  });

  it("requires explicit trust-boundary fields instead of runtime unknown fallbacks", () => {
    const capability = acpExecutor("codex").capability;

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
