import type { OpenTagIntegrationManifest } from "@opentag/core";
import { createAcpExecutor, type AcpExecutorOptions } from "./acp-executor.js";
import type { ExecutorAdapter } from "./executor.js";

export type AcpAgentLaunchSpec = {
  command: string;
  args?: readonly string[];
  cwd?: string;
};

export type AcpAgentCandidate = {
  id: string;
  label: string;
  registry?: {
    id: string;
    version: string;
  };
  launch: AcpAgentLaunchSpec;
  sessionModeId?: string;
  capabilities?: {
    supportsProfile?: boolean;
  };
  readinessTimeoutMs?: number;
};

export type AcpAgentDefinition = AcpAgentCandidate & {
  workspaceCwd: "required";
};

export type AcpAgentExecutorOptions = Omit<
  AcpExecutorOptions,
  "manifest" | "sessionModeId" | "capabilityOverrides"
>;

export function createAcpAgentManifest(definition: AcpAgentDefinition): OpenTagIntegrationManifest {
  return {
    protocol: "opentag.integration.v1",
    id: definition.id,
    label: definition.label,
    bindings: {
      agent: {
        kind: "stdio",
        command: definition.launch.command,
        args: [...(definition.launch.args ?? [])],
        ...(definition.launch.cwd ? { cwd: definition.launch.cwd } : {})
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

export function createAcpAgentExecutor(
  definition: AcpAgentDefinition,
  options: AcpAgentExecutorOptions = {}
): ExecutorAdapter {
  return createAcpExecutor({
    manifest: createAcpAgentManifest(definition),
    ...options,
    ...(options.readinessTimeoutMs === undefined && definition.readinessTimeoutMs !== undefined
      ? { readinessTimeoutMs: definition.readinessTimeoutMs }
      : {}),
    ...(definition.sessionModeId ? { sessionModeId: definition.sessionModeId } : {}),
    ...(definition.capabilities ? { capabilityOverrides: definition.capabilities } : {})
  });
}
