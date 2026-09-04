import {
  createAcpAgentExecutor,
  createBuiltInAcpExecutors,
  createEchoExecutor,
  type BuiltInAcpAgentOptions,
  type ExecutorAdapter,
  type RunnerSecurityPolicy
} from "@opentag/runner";
import {
  assertHostedRelayAuthorization,
  hostedRunnerAuthProblem,
  type OpenTagDaemonConfig
} from "./config.js";
import type { PairedRunnerRuntimeInput } from "./daemon.js";
import { createHostedControlLoop } from "./control-v1.js";

export function securityFromConfig(config: OpenTagDaemonConfig): RunnerSecurityPolicy | undefined {
  const security = config.security;
  if (!security) return undefined;

  const normalized: RunnerSecurityPolicy = {};
  if (security.mode !== undefined) normalized.mode = security.mode;
  if (security.allowedWorkspaceRoot !== undefined) normalized.allowedWorkspaceRoot = security.allowedWorkspaceRoot;
  if (security.allowUnsafePrompts !== undefined) normalized.allowUnsafePrompts = security.allowUnsafePrompts;
  if (security.extraSafeEnv !== undefined) normalized.extraSafeEnv = security.extraSafeEnv;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function builtInAcpOptionsFromConfig(config: OpenTagDaemonConfig): BuiltInAcpAgentOptions {
  const security = securityFromConfig(config);
  return {
    ...(security ? { security } : {}),
    hermes: {
      ...(config.hermes?.command ? { command: config.hermes.command } : {}),
      ...(config.hermes?.profile ? { profile: config.hermes.profile } : {})
    },
    openclaw: {
      ...(config.openclaw?.command ? { command: config.openclaw.command } : {}),
      ...(config.openclaw?.profile ? { profile: config.openclaw.profile } : {}),
      ...(config.openclaw?.gatewayUrl ? { gatewayUrl: config.openclaw.gatewayUrl } : {}),
      ...(config.openclaw?.expectedVersion ? { expectedVersion: config.openclaw.expectedVersion } : {})
    }
  };
}

export function executorsFromConfig(config: OpenTagDaemonConfig) {
  const security = securityFromConfig(config);
  const builtInAcpExecutors = createBuiltInAcpExecutors(builtInAcpOptionsFromConfig(config));

  const executors: Record<string, ExecutorAdapter> = {
    echo: createEchoExecutor(),
    codex: builtInAcpExecutors.codex,
    "claude-code": builtInAcpExecutors["claude-code"],
    cursor: builtInAcpExecutors.cursor,
    opencode: builtInAcpExecutors.opencode,
    hermes: builtInAcpExecutors.hermes,
    openclaw: builtInAcpExecutors.openclaw
  };
  for (const [id, agent] of Object.entries(config.agents)) {
    if (Object.prototype.hasOwnProperty.call(executors, id)) {
      throw new Error(`Configured ACP agent '${id}' cannot replace built-in executor '${id}'.`);
    }
    executors[id] = createAcpAgentExecutor(
      {
        id,
        label: agent.label ?? id,
        workspaceCwd: agent.workspaceCwd,
        launch: {
          command: agent.command,
          args: agent.args,
          ...(agent.cwd ? { cwd: agent.cwd } : {})
        },
        ...(agent.sessionModeId ? { sessionModeId: agent.sessionModeId } : {}),
        capabilities: { supportsProfile: agent.supportsProfile, supportsCancel: agent.supportsCancel },
        ...(agent.readinessTimeoutMs ? { readinessTimeoutMs: agent.readinessTimeoutMs } : {})
      },
      security ? { security } : {}
    );
  }
  return executors;
}

export function createDaemonRuntimeInput(
  config: OpenTagDaemonConfig,
  options: { databasePath: string },
): PairedRunnerRuntimeInput {
  const security = securityFromConfig(config);
  const executors = executorsFromConfig(config);
  if (!config.controlRegistration) {
    throw new Error(
      "Paired Runner runtime requires a Hosted Control V1 registration."
    );
  }
  assertHostedRelayAuthorization({
    relayUrl: config.relayUrl,
    trustedRelay: config.trustedRelay
  });
  const hostedAuthProblem = hostedRunnerAuthProblem(config);
  if (hostedAuthProblem) throw new Error(hostedAuthProblem);
  const controlLoop = createHostedControlLoop({
    config,
    databasePath: options.databasePath,
    executors,
    ...(security ? { security } : {}),
  });
  return {
    controlLoop,
    ...(config.pollIntervalMs ? { pollIntervalMs: config.pollIntervalMs } : {}),
  };
}
