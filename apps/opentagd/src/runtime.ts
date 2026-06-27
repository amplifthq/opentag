import { createDispatcherClient } from "@opentag/client";
import { createClaudeCodeExecutor, createCodexExecutor, createEchoExecutor, type RunnerSecurityPolicy } from "@opentag/runner";
import type { OpenTagDaemonConfig } from "./config.js";
import type { DaemonClient } from "./daemon.js";
import type { PullRequestOptions } from "./pr.js";

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

export function executorsFromConfig(config: OpenTagDaemonConfig) {
  const security = securityFromConfig(config);

  return {
    echo: createEchoExecutor(),
    codex: createCodexExecutor({
      ...(security ? { security } : {})
    }),
    "claude-code": createClaudeCodeExecutor({
      ...(config.claudeCode?.command ? { claudeCommand: config.claudeCode.command } : {}),
      ...(config.claudeCode?.model ? { model: config.claudeCode.model } : {}),
      ...(config.claudeCode?.permissionMode ? { permissionMode: config.claudeCode.permissionMode } : {}),
      ...(config.claudeCode?.dangerouslySkipPermissions !== undefined
        ? { dangerouslySkipPermissions: config.claudeCode.dangerouslySkipPermissions }
        : {})
    })
  };
}

export function createDaemonClient(config: OpenTagDaemonConfig): DaemonClient {
  return createDispatcherClient({
    dispatcherUrl: config.dispatcherUrl,
    runnerId: config.runnerId,
    ...(config.pairingToken ? { pairingToken: config.pairingToken } : {})
  });
}

export function pullRequestOptionsFromConfig(config: OpenTagDaemonConfig): PullRequestOptions | undefined {
  if (!config.githubToken && config.preparePullRequestBranch === undefined && config.allowAutoCreatePullRequest === undefined) {
    return undefined;
  }

  return {
    ...(config.githubToken ? { githubToken: config.githubToken } : {}),
    ...(config.preparePullRequestBranch !== undefined ? { preparePullRequestBranch: config.preparePullRequestBranch } : {}),
    ...(config.allowAutoCreatePullRequest !== undefined ? { allowAutoCreatePullRequest: config.allowAutoCreatePullRequest } : {})
  };
}

export function createDaemonRuntimeInput(config: OpenTagDaemonConfig) {
  const security = securityFromConfig(config);
  const pullRequestOptions = pullRequestOptionsFromConfig(config);

  return {
    runnerId: config.runnerId,
    repositories: config.repositories,
    executors: executorsFromConfig(config),
    ...(security ? { security } : {}),
    ...(pullRequestOptions ? { pullRequestOptions } : {}),
    ...(config.heartbeatIntervalMs ? { heartbeatIntervalMs: config.heartbeatIntervalMs } : {}),
    ...(config.pollIntervalMs ? { pollIntervalMs: config.pollIntervalMs } : {}),
    client: createDaemonClient(config)
  };
}
