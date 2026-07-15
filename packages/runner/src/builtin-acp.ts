import type { OpenTagIntegrationManifest } from "@opentag/core";
import {
  createAcpAgentExecutor,
  createAcpAgentManifest,
  type AcpAgentDefinition
} from "./acp-agent.js";
import type { ExecutorAdapter } from "./executor.js";
import { DEFAULT_HERMES_PROFILE } from "./hermes-profile.js";
import type { RunnerSecurityPolicy } from "./security.js";

export type BuiltInAcpAgentId = "codex" | "claude-code" | "cursor" | "opencode" | "hermes";

export type BuiltInAcpAgentOptions = {
  security?: RunnerSecurityPolicy;
  hermes?: {
    command?: string;
    profile?: string;
  };
};

export type BuiltInAcpAgentDefinition = AcpAgentDefinition & { id: BuiltInAcpAgentId };

export function builtInAcpAgentDefinitions(
  options: BuiltInAcpAgentOptions = {}
): Record<BuiltInAcpAgentId, BuiltInAcpAgentDefinition> {
  const hermesCommand = options.hermes?.command ?? "hermes";
  const hermesProfile = options.hermes?.profile ?? DEFAULT_HERMES_PROFILE;

  return {
    codex: {
      id: "codex",
      label: "Codex ACP",
      workspaceCwd: "required",
      registry: { id: "codex-acp", version: "1.1.2" },
      readinessTimeoutMs: 30_000,
      launch: {
        command: "npx",
        args: ["--yes", "@agentclientprotocol/codex-acp@1.1.2"]
      }
    },
    "claude-code": {
      id: "claude-code",
      label: "Claude Agent ACP",
      workspaceCwd: "required",
      registry: { id: "claude-acp", version: "0.59.0" },
      readinessTimeoutMs: 30_000,
      launch: {
        command: "npx",
        args: ["--yes", "@agentclientprotocol/claude-agent-acp@0.59.0"]
      },
      sessionModeId: "default"
    },
    cursor: {
      id: "cursor",
      label: "Cursor ACP",
      workspaceCwd: "required",
      readinessTimeoutMs: 30_000,
      launch: {
        command: "cursor-agent",
        args: ["acp"]
      }
    },
    opencode: {
      id: "opencode",
      label: "OpenCode ACP",
      workspaceCwd: "required",
      registry: { id: "opencode", version: "1.18.1" },
      readinessTimeoutMs: 30_000,
      launchEnvironment: {
        OPENCODE_DISABLE_TERMINAL_TITLE: "true",
        OPENCODE_PURE: "true"
      },
      launch: {
        command: "npx",
        args: ["--yes", "opencode-ai@1.18.1", "acp"]
      }
    },
    hermes: {
      id: "hermes",
      label: "Hermes ACP",
      workspaceCwd: "required",
      launch: {
        command: hermesCommand,
        args: ["-p", hermesProfile, "acp"]
      },
      capabilities: { supportsProfile: true }
    }
  };
}

export function builtInAcpAgentManifests(options: BuiltInAcpAgentOptions = {}): Record<BuiltInAcpAgentId, OpenTagIntegrationManifest> {
  const definitions = builtInAcpAgentDefinitions(options);
  return {
    codex: createAcpAgentManifest(definitions.codex),
    "claude-code": createAcpAgentManifest(definitions["claude-code"]),
    cursor: createAcpAgentManifest(definitions.cursor),
    opencode: createAcpAgentManifest(definitions.opencode),
    hermes: createAcpAgentManifest(definitions.hermes)
  };
}

export function createBuiltInAcpExecutors(options: BuiltInAcpAgentOptions = {}): Record<BuiltInAcpAgentId, ExecutorAdapter> {
  const definitions = builtInAcpAgentDefinitions(options);
  const shared = options.security ? { security: options.security } : {};
  return {
    codex: createAcpAgentExecutor(definitions.codex, shared),
    "claude-code": createAcpAgentExecutor(definitions["claude-code"], shared),
    cursor: createAcpAgentExecutor(definitions.cursor, shared),
    opencode: createAcpAgentExecutor(definitions.opencode, shared),
    hermes: createAcpAgentExecutor(definitions.hermes, shared)
  };
}
