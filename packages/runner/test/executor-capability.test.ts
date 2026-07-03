import { describe, expect, it } from "vitest";
import { createClaudeCodeExecutor } from "../src/claude-code.js";
import { createCodexExecutor } from "../src/codex.js";
import { createEchoExecutor } from "../src/echo.js";
import { createHermesExecutor } from "../src/hermes.js";

describe("executor capability contracts", () => {
  it("exposes runtime capabilities for built-in executors", () => {
    const executors = [
      createCodexExecutor(),
      createClaudeCodeExecutor(),
      createHermesExecutor(),
      createEchoExecutor()
    ];

    for (const executor of executors) {
      expect(executor.capability).toMatchObject({
        id: executor.id,
        invocation: "spawn",
        supportsStreaming: false,
        supportsCancel: false,
        supportsHookCompletion: false,
        progressEvents: "audit",
        approvalMode: "opentag_policy",
        promptAssembly: executor.id === "echo" ? "opentag" : "executor_adapter",
        writeAccess: executor.id === "echo" ? "none" : "workspace",
        conversationAccess: "request",
        promptMutation: "none",
        rawContextAccess: false,
        writeActionAccess: "none"
      });
      expect(executor.capability?.contextAccess).toContain("context_packet");
      expect(executor.capability?.contextAccess).toContain("context_pointers");
      expect(executor.capability?.completionSignals.length).toBeGreaterThan(0);
      expect(executor.capability?.requiredSecrets).toEqual(expect.any(Array));
    }

    expect(createCodexExecutor().capability?.workspaceIsolation).toBe("worktree");
    expect(createClaudeCodeExecutor().capability?.workspaceIsolation).toBe("worktree");
    expect(createHermesExecutor().capability).toMatchObject({
      supportsProfile: true,
      workspaceIsolation: "branch"
    });
    expect(createEchoExecutor().capability?.workspaceIsolation).toBe("none");
  });

  it("requires explicit trust-boundary fields instead of runtime unknown fallbacks", () => {
    const capability = createCodexExecutor().capability;

    expect(capability).toMatchObject({
      progressEvents: "audit",
      approvalMode: "opentag_policy",
      contextAccess: ["context_packet", "context_pointers", "workspace"],
      promptAssembly: "executor_adapter",
      writeAccess: "workspace",
      conversationAccess: "request",
      promptMutation: "none",
      rawContextAccess: false,
      writeActionAccess: "none"
    });
  });
});
