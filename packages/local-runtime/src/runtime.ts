import { createDispatcherClient } from "@opentag/client";
import { createClaudeCodeExecutor, createCodexExecutor, createEchoExecutor, createHermesExecutor, type RunnerSecurityPolicy } from "@opentag/runner";
import { runnerDispatcherToken, type OpenTagDaemonConfig } from "./config.js";
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

export function hermesProfileMigrationWarning(config: OpenTagDaemonConfig): string | undefined {
  if (!config.hermes?.profile && !config.hermes?.profileTemplate) return undefined;
  return "Hermes configuration warning: daemon.hermes.profile and daemon.hermes.profileTemplate are deprecated and ignored because Hermes CLI 0.18 removed per-invocation profiles. Run `hermes profile use <name>` before starting OpenTag.";
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
        : {}),
      ...(security ? { security } : {})
    }),
    hermes: createHermesExecutor({
      ...(config.hermes?.command ? { hermesCommand: config.hermes.command } : {})
    })
  };
}

export function createDaemonClient(config: OpenTagDaemonConfig): DaemonClient {
  const token = runnerDispatcherToken(config);
  return createDispatcherClient({
    dispatcherUrl: config.dispatcherUrl,
    runnerId: config.runnerId,
    ...(token ? { pairingToken: token } : {})
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
    ...(config.runTimeoutMs ? { runTimeoutMs: config.runTimeoutMs } : {}),
    ...(config.agentSessionProfile ? { agentSessionProfile: config.agentSessionProfile } : {}),
    ...(config.pollIntervalMs ? { pollIntervalMs: config.pollIntervalMs } : {}),
    client: createDaemonClient(config)
  };
}
