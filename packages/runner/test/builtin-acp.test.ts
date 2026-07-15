import { describe, expect, it } from "vitest";
import { builtInAcpAgentDefinitions, builtInAcpAgentManifests } from "../src/builtin-acp.js";

describe("built-in ACP coding agents", () => {
  it("uses pinned registry launch data and maps the Hermes profile into ACP startup", () => {
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
    expect(definitions.hermes).toMatchObject({ id: "hermes", capabilities: { supportsProfile: true } });
  });
});
