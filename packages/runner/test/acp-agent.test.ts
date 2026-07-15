import { describe, expect, it } from "vitest";
import { createAcpAgentExecutor, createAcpAgentManifest } from "../src/acp-agent.js";

describe("generic ACP agent definitions", () => {
  it("turns a launch definition into the one generic ACP manifest shape", () => {
    const manifest = createAcpAgentManifest({
      id: "gemini",
      label: "Gemini CLI",
      workspaceCwd: "required",
      launch: {
        command: "npx",
        args: ["--yes", "@google/gemini-cli@0.50.0", "--acp"]
      }
    });

    expect(manifest).toEqual({
      protocol: "opentag.integration.v1",
      id: "gemini",
      label: "Gemini CLI",
      bindings: {
        agent: {
          kind: "stdio",
          command: "npx",
          args: ["--yes", "@google/gemini-cli@0.50.0", "--acp"]
        }
      },
      roles: {
        agent: {
          protocol: "agent-client-protocol",
          protocolVersion: 1,
          binding: "agent",
          workspace: { sessionCwd: "required" }
        }
      },
      resources: {}
    });
  });

  it("applies session and capability metadata without agent-specific executor code", () => {
    const executor = createAcpAgentExecutor({
      id: "local-agent",
      label: "Local Agent",
      workspaceCwd: "required",
      launch: { command: "local-agent", args: ["acp"] },
      sessionModeId: "default",
      capabilities: { supportsProfile: true }
    });

    expect(executor.id).toBe("local-agent");
    expect(executor.capability).toMatchObject({
      supportsProfile: true,
      supportsCancel: false,
      workspaceCwdConformance: "declared"
    });
  });
});
