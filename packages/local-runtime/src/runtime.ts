import { createDispatcherClient } from "@opentag/client";
import {
  createAcpExecutor,
  createBuiltInAcpExecutors,
  createEchoExecutor,
  createHermesExecutor,
  DEFAULT_HERMES_PROFILE,
  type ExecutorAdapter,
  type RunnerSecurityPolicy
} from "@opentag/runner";
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

export function hermesProfileConfigurationWarning(config: OpenTagDaemonConfig): string | undefined {
  if (!config.hermes?.profileTemplate) return undefined;
  const profile = config.hermes.profile ?? DEFAULT_HERMES_PROFILE;
  return (
    "Hermes configuration warning: daemon.hermes.profileTemplate is not used because OpenTag does not yet provision per-run " +
    `Hermes profiles. OpenTag will use the fixed profile '${profile}'; set daemon.hermes.profile explicitly and remove profileTemplate.`
  );
}

export function executorsFromConfig(config: OpenTagDaemonConfig) {
  const security = securityFromConfig(config);
  const builtInAcpExecutors = createBuiltInAcpExecutors({
    ...(security ? { security } : {}),
    hermes: {
      ...(config.hermes?.command ? { command: config.hermes.command } : {}),
      ...(config.hermes?.profile ? { profile: config.hermes.profile } : {})
    }
  });

  const executors: Record<string, ExecutorAdapter> = {
    echo: createEchoExecutor(),
    codex: builtInAcpExecutors.codex,
    "claude-code": builtInAcpExecutors["claude-code"],
    hermes: createHermesExecutor({
      ...(config.hermes?.command ? { hermesCommand: config.hermes.command } : {}),
      ...(config.hermes?.profile ? { profile: config.hermes.profile } : {})
    })
  };
  for (const manifest of Object.values(config.agents)) {
    if (Object.prototype.hasOwnProperty.call(executors, manifest.id)) {
      throw new Error(`Configured ACP agent '${manifest.id}' cannot replace built-in executor '${manifest.id}'.`);
    }
    executors[manifest.id] = createAcpExecutor({ manifest, ...(security ? { security } : {}) });
  }
  return executors;
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
    scratchRoot: config.scratchRoot,
    keepScratch: config.keepScratch,
    approvalMode: config.approvalMode,
    ...(security ? { security } : {}),
    ...(pullRequestOptions ? { pullRequestOptions } : {}),
    ...(config.heartbeatIntervalMs ? { heartbeatIntervalMs: config.heartbeatIntervalMs } : {}),
    ...(config.runTimeoutMs ? { runTimeoutMs: config.runTimeoutMs } : {}),
    ...(config.agentSessionProfile ? { agentSessionProfile: config.agentSessionProfile } : {}),
    ...(config.pollIntervalMs ? { pollIntervalMs: config.pollIntervalMs } : {}),
    client: createDaemonClient(config)
  };
}
