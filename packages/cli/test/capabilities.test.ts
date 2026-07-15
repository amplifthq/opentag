import { createBuiltInAcpExecutors, createEchoExecutor } from "@opentag/runner";
import { describe, expect, it } from "vitest";
import { EXECUTOR_CAPABILITIES } from "../src/catalogs/capabilities.js";

describe("CLI capability catalog", () => {
  it("matches the built-in runner executor capability contracts", () => {
    const builtIns = createBuiltInAcpExecutors();
    const executors = [
      builtIns.codex,
      builtIns["claude-code"],
      builtIns.cursor,
      builtIns.opencode,
      builtIns.hermes,
      builtIns.openclaw,
      createEchoExecutor()
    ];

    for (const executor of executors) {
      const capability = executor.capability;
      expect(capability, `${executor.id} should declare a capability contract`).toBeDefined();
      expect(EXECUTOR_CAPABILITIES[executor.id as keyof typeof EXECUTOR_CAPABILITIES]).toEqual({
        id: capability!.id,
        invocation: capability!.invocation,
        supportsProfile: capability!.supportsProfile,
        supportsStreaming: capability!.supportsStreaming,
        supportsCancel: capability!.supportsCancel,
        supportsHookCompletion: capability!.supportsHookCompletion,
        progressEvents: capability!.progressEvents,
        approvalMode: capability!.approvalMode,
        contextAccess: capability!.contextAccess,
        promptAssembly: capability!.promptAssembly,
        writeAccess: capability!.writeAccess,
        conversationAccess: capability!.conversationAccess,
        promptMutation: capability!.promptMutation,
        rawContextAccess: capability!.rawContextAccess,
        writeActionAccess: capability!.writeActionAccess,
        workspaceIsolation: capability!.workspaceIsolation,
        requiredSecrets: capability!.requiredSecrets.map((secret) => secret.id),
        completionSignals: capability!.completionSignals.map((signal) => signal.type)
      });
    }
  });
});
