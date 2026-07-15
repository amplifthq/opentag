import { describe, expect, it } from "vitest";
import { builtInAcpAgentDefinitions, builtInAcpAgentManifests } from "../src/builtin-acp.js";

describe("built-in ACP coding agents", () => {
  it("uses Registry or installed CLI launch data and maps the Hermes profile into ACP startup", () => {
    const manifests = builtInAcpAgentManifests({
      hermes: { command: "/opt/hermes/bin/hermes", profile: "opentag-review" }
    });

    expect(manifests.codex.bindings.agent).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["--yes", "@agentclientprotocol/codex-acp@1.1.2"]
    });

    expect(manifests["claude-code"].bindings.agent).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["--yes", "@agentclientprotocol/claude-agent-acp@0.59.0"]
    });

    expect(manifests.cursor.bindings.agent).toEqual({
      kind: "stdio",
      command: "cursor-agent",
      args: ["acp"]
    });

    expect(manifests.opencode.bindings.agent).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["--yes", "opencode-ai@1.18.1", "acp"]
    });

    expect(manifests.hermes.bindings.agent).toEqual({
      kind: "stdio",
      command: "/opt/hermes/bin/hermes",
      args: ["-p", "opentag-review", "acp"]
    });
  });

  it("keeps compatibility aliases as data-only definitions", () => {
    const definitions = builtInAcpAgentDefinitions();

    expect(definitions.codex).toMatchObject({ id: "codex", registry: { id: "codex-acp", version: "1.1.2" } });
    expect(definitions["claude-code"]).toMatchObject({
      id: "claude-code",
      sessionModeId: "default",
      registry: { id: "claude-acp", version: "0.59.0" }
    });
    expect(definitions.codex.readinessTimeoutMs).toBe(30_000);
    expect(definitions["claude-code"].readinessTimeoutMs).toBe(30_000);
    expect(definitions.cursor).toMatchObject({ id: "cursor", launch: { command: "cursor-agent", args: ["acp"] } });
    expect(definitions.opencode).toMatchObject({
      id: "opencode",
      registry: { id: "opencode", version: "1.18.1" },
      launch: { command: "npx", args: ["--yes", "opencode-ai@1.18.1", "acp"] },
      launchEnvironment: {
        OPENCODE_DISABLE_TERMINAL_TITLE: "true",
        OPENCODE_PURE: "true"
      }
    });
    expect(definitions.cursor.readinessTimeoutMs).toBe(30_000);
    expect(definitions.opencode.readinessTimeoutMs).toBe(30_000);
    expect(definitions.hermes).toMatchObject({ id: "hermes", capabilities: { supportsProfile: true } });
  });
});
