import { createRequire } from "node:module";
import type { OpenTagIntegrationManifest } from "@opentag/core";
import { createAcpExecutor } from "./acp-executor.js";
import type { ExecutorAdapter } from "./executor.js";
import { DEFAULT_HERMES_PROFILE } from "./hermes-profile.js";
import type { RunnerSecurityPolicy } from "./security.js";

export type BuiltInAcpAgentId = "codex" | "claude-code" | "hermes";

export type BuiltInAcpAgentOptions = {
  security?: RunnerSecurityPolicy;
  hermes?: {
    command?: string;
    profile?: string;
  };
};

const require = createRequire(import.meta.url);

function agentManifest(input: {
  id: BuiltInAcpAgentId;
  label: string;
  command: string;
  args: string[];
}): OpenTagIntegrationManifest {
  return {
    protocol: "opentag.integration.v1",
    id: input.id,
    label: input.label,
    bindings: {
      agent: {
        kind: "stdio",
        command: input.command,
        args: input.args
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
  };
}

export function builtInAcpAgentManifests(options: BuiltInAcpAgentOptions = {}): Record<BuiltInAcpAgentId, OpenTagIntegrationManifest> {
  const hermesCommand = options.hermes?.command ?? "hermes";
  const hermesProfile = options.hermes?.profile ?? DEFAULT_HERMES_PROFILE;

  return {
    codex: agentManifest({
      id: "codex",
      label: "Codex ACP",
      command: process.execPath,
      args: [require.resolve("@agentclientprotocol/codex-acp")]
    }),
    "claude-code": agentManifest({
      id: "claude-code",
      label: "Claude Agent ACP",
      command: process.execPath,
      args: [require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")]
    }),
    hermes: agentManifest({
      id: "hermes",
      label: "Hermes ACP",
      command: hermesCommand,
      args: ["-p", hermesProfile, "acp"]
    })
  };
}

export function createBuiltInAcpExecutors(options: BuiltInAcpAgentOptions = {}): Record<BuiltInAcpAgentId, ExecutorAdapter> {
  const manifests = builtInAcpAgentManifests(options);
  const shared = options.security ? { security: options.security } : {};
  const codex = createAcpExecutor({ manifest: manifests.codex, ...shared });
  const claudeCode = createAcpExecutor({ manifest: manifests["claude-code"], sessionModeId: "default", ...shared });
  const hermes = createAcpExecutor({ manifest: manifests.hermes, ...shared });
  if (!hermes.capability) throw new Error("The built-in Hermes ACP executor must declare its capability contract.");

  return {
    codex,
    "claude-code": claudeCode,
    hermes: {
      ...hermes,
      capability: {
        ...hermes.capability,
        supportsProfile: true
      }
    }
  };
}
