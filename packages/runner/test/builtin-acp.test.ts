import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { builtInAcpAgentManifests } from "../src/builtin-acp.js";

describe("built-in ACP coding agents", () => {
  it("resolves pinned bundled adapters and maps the Hermes profile into ACP startup", () => {
    const manifests = builtInAcpAgentManifests({
      hermes: { command: "/opt/hermes/bin/hermes", profile: "opentag-review" }
    });

    expect(manifests.codex.bindings.agent.command).toBe(process.execPath);
    expect(manifests.codex.bindings.agent.args[0]).toMatch(/agentclientprotocol.+codex-acp.+dist.+index\.js/u);
    expect(existsSync(manifests.codex.bindings.agent.args[0]!)).toBe(true);

    expect(manifests["claude-code"].bindings.agent.command).toBe(process.execPath);
    expect(manifests["claude-code"].bindings.agent.args[0]).toMatch(/agentclientprotocol.+claude-agent-acp.+dist.+index\.js/u);
    expect(existsSync(manifests["claude-code"].bindings.agent.args[0]!)).toBe(true);

    expect(manifests.hermes.bindings.agent).toEqual({
      kind: "stdio",
      command: "/opt/hermes/bin/hermes",
      args: ["-p", "opentag-review", "acp"]
    });
  });
});
