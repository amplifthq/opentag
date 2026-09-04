import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatProjectTargetRef } from "@opentag/core";
import { nodeCommandRunner, type CommandRunner, type ExecutorAdapter, type ExecutorCapabilityContract } from "@opentag/runner";
import { createOpenTagClient, OpenTagClientHttpError, type OpenTagClient } from "@opentag/client";
import { canonicalRepositoryIdentity, hostedRunnerAuthProblem } from "./config.js";
import type { OpenTagDaemonConfig, RepositoryBindingConfig } from "./config.js";

export type DoctorCheckStatus = "ok" | "warn" | "fail";

export type DoctorCheck = {
  name: string;
  status: DoctorCheckStatus;
  message: string;
};

function check(status: DoctorCheckStatus, name: string, message: string): DoctorCheck {
  return { name, status, message };
}

type SafeRemoteError = {
  message: string;
  status?: number;
  code?: string;
};

const SAFE_REMOTE_ERROR_CODES = new Set([
  "runner_not_found",
  "repo_binding_not_found"
]);

function safeRemoteError(error: unknown): SafeRemoteError {
  if (!(error instanceof OpenTagClientHttpError)) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  let code: string | undefined;
  try {
    const parsed = JSON.parse(error.responseBody) as { error?: unknown };
    if (typeof parsed.error === "string" && SAFE_REMOTE_ERROR_CODES.has(parsed.error)) {
      code = parsed.error;
    }
  } catch {
    // Response bodies are intentionally not surfaced by doctor diagnostics.
  }
  return {
    message: `Relay request failed with HTTP ${error.status}${code ? ` (${code})` : ""}.`,
    status: error.status,
    ...(code ? { code } : {})
  };
}

function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

function formatExecutorCapability(capability: ExecutorCapabilityContract): string {
  const secrets = capability.requiredSecrets.length ? capability.requiredSecrets.map((secret) => secret.id).join(",") : "none";
  const completion = capability.completionSignals.map((signal) => signal.type).join(",");
  const context = capability.contextAccess.length ? capability.contextAccess.join(",") : "none";
  return [
    `invocation=${capability.invocation}`,
    `profile=${yesNo(capability.supportsProfile)}`,
    `streaming=${yesNo(capability.supportsStreaming)}`,
    `cancel=${yesNo(capability.supportsCancel)}`,
    `hook_completion=${yesNo(capability.supportsHookCompletion)}`,
    `progress=${capability.progressEvents}`,
    `approval=${capability.approvalMode}`,
    `context=${context}`,
    `prompt=${capability.promptAssembly}`,
    `write=${capability.writeAccess}`,
    `conversation=${capability.conversationAccess}`,
    `prompt_mutation=${capability.promptMutation}`,
    `raw_context=${yesNo(capability.rawContextAccess)}`,
    `write_actions=${capability.writeActionAccess}`,
    `isolation=${capability.workspaceIsolation}`,
    `cwd_conformance=${capability.workspaceCwdConformance ?? "not_applicable"}`,
    `secrets=${secrets}`,
    `completion=${completion}`
  ].join(", ");
}

function checkExecutorCapability(name: string, capability: ExecutorCapabilityContract): DoctorCheck {
  return check(
    capability.workspaceCwdConformance === "unverified" ? "fail" : "ok",
    `${name} capability`,
    formatExecutorCapability(capability)
  );
}

function envSecretConfigured(env: Record<string, string | undefined>, name: string): boolean {
  return Boolean(env[name]?.trim());
}

function executorSecretReference(secret: ExecutorCapabilityContract["requiredSecrets"][number]): string {
  return secret.env ? `env ${secret.env}` : "an executor-specific secret reference";
}

function checkExecutorSecretRequirements(input: {
  capability: ExecutorCapabilityContract;
  env: Record<string, string | undefined>;
}): DoctorCheck[] {
  return input.capability.requiredSecrets.map((secret) => {
    const reference = executorSecretReference(secret);
    const configured = secret.env ? envSecretConfigured(input.env, secret.env) : false;
    if (configured) {
      return check(
        "ok",
        `${input.capability.id} secret ${secret.id}`,
        `${secret.label} configured via ${reference} (${secret.required ? "required" : "optional"}).`
      );
    }
    if (secret.required) {
      return check(
        "fail",
        `${input.capability.id} secret ${secret.id}`,
        `${secret.label} is required but ${reference} is not configured.${secret.description ? ` ${secret.description}` : ""}`
      );
    }
    return check(
      "ok",
      `${input.capability.id} secret ${secret.id}`,
      `${secret.label} is optional and not configured via ${reference}; executor may use local login/config.`
    );
  });
}

// Codex accepts built-in tiers (e.g. flex, fast), legacy request values (e.g. priority),
// and catalog-provided tier IDs. OpenTag should not maintain a closed allowlist here.
const CODEX_DEPRECATED_SERVICE_TIERS = new Set(["default"]);

function defaultCodexConfigPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
}

function parseCodexServiceTiers(configText: string): string[] {
  return [...configText.matchAll(/^\s*service_tier\s*=\s*(?:"([^"]+)"|'([^']+)')(?:\s*#.*)?\s*$/gm)]
    .map((match) => match[1] ?? match[2])
    .filter((value): value is string => Boolean(value));
}

function shouldCheckCodexConfig(config: OpenTagDaemonConfig): boolean {
  return config.repositories.some((repository) => repository.defaultExecutor === "codex");
}

function checkRunnerApiAuth(config: OpenTagDaemonConfig): DoctorCheck {
  if (!config.controlRegistration) {
    return check(
      "fail",
      "paired runner auth",
      "The local Runner is not paired with Hosted Control V1."
    );
  }
  const hostedAuthProblem = hostedRunnerAuthProblem(config);
  if (hostedAuthProblem) {
    return check("fail", "hosted runner auth", hostedAuthProblem);
  }
  return check(
    "ok",
    "paired runner auth",
    "Hosted Control V1 paired runtime credential is configured; remote authentication is checked separately."
  );
}

function repositoryTargetLabel(repository: RepositoryBindingConfig): string {
  return formatProjectTargetRef({
    provider: repository.provider,
    owner: repository.owner,
    repo: repository.repo
  });
}

function checkCodexConfig(configPath = defaultCodexConfigPath()): DoctorCheck {
  if (!existsSync(configPath)) {
    return check("ok", "Codex config", `No Codex config file found at ${configPath}; CLI defaults will be used`);
  }

  let configText: string;
  try {
    configText = readFileSync(configPath, "utf8");
  } catch (error) {
    return check("fail", "Codex config", error instanceof Error ? error.message : String(error));
  }

  const serviceTiers = parseCodexServiceTiers(configText);
  if (!serviceTiers.length) {
    return check("ok", "Codex config", `No service_tier override configured in ${configPath}`);
  }

  const deprecatedTier = serviceTiers.find((tier) => CODEX_DEPRECATED_SERVICE_TIERS.has(tier));
  if (deprecatedTier) {
    return check(
      "fail",
      "Codex config",
      `Deprecated service_tier '${deprecatedTier}' in ${configPath}. Remove it or set a current Codex tier such as 'flex' or 'fast'.`
    );
  }

  return check("ok", "Codex config", `service_tier=${serviceTiers.join(", ")}`);
}

async function checkGitCheckout(input: {
  repository: RepositoryBindingConfig;
  executor?: ExecutorAdapter;
  commandRunner: CommandRunner;
  env: Record<string, string | undefined>;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const target = repositoryTargetLabel(input.repository);
  if (!existsSync(input.repository.checkoutPath)) {
    return [check("fail", `${target} checkout`, "Configured workspace path does not exist (hasWorkspacePath=yes).")];
  }
  checks.push(check("ok", `${target} checkout`, "Workspace path configured (hasWorkspacePath=yes)."));

  try {
    const gitRepo = await input.commandRunner.run("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: input.repository.checkoutPath
    });
    if (gitRepo.exitCode !== 0 || gitRepo.stdout.trim() !== "true") {
      checks.push(check("fail", `${target} git repo`, gitRepo.stderr || gitRepo.stdout || "Not a git repository."));
      return checks;
    }
    checks.push(check("ok", `${target} git repo`, "Git checkout detected"));
  } catch (error) {
    checks.push(
      check(
        "fail",
        `${target} git repo`,
        error instanceof Error ? error.message : String(error)
      )
    );
    return checks;
  }

  const executor = input.executor;
  if (!executor) {
    checks.push(check("fail", `${input.repository.defaultExecutor} executor`, "No local executor is configured with this id."));
    return checks;
  }
  checks.push(
    executor.capability
      ? checkExecutorCapability(input.repository.defaultExecutor, executor.capability)
      : check(
          "warn",
          `${input.repository.defaultExecutor} capability`,
          "Executor does not declare a capability contract; readiness may be incomplete."
        )
  );
  if (executor.capability) {
    checks.push(...checkExecutorSecretRequirements({ capability: executor.capability, env: input.env }));
  }
  try {
    const readiness = await executor.canRun({
      runId: "doctor",
      workspace: { kind: "repository", path: input.repository.checkoutPath },
      ...(input.repository.baseBranch ? { baseBranch: input.repository.baseBranch } : {}),
      ...(input.repository.worktreeRoot ? { worktreeRoot: input.repository.worktreeRoot } : {}),
      ...(input.repository.keepWorktree ? { keepWorktree: input.repository.keepWorktree } : {}),
      command: { rawText: "doctor", intent: "unknown", args: {} },
      context: []
    });
    checks.push(
      readiness.ready
        ? check("ok", `${input.repository.defaultExecutor} executor`, `${executor.displayName} is ready`)
        : check("fail", `${input.repository.defaultExecutor} executor`, readiness.reason ?? `${executor.displayName} is not ready`)
    );
  } catch (error) {
    checks.push(
      check(
        "fail",
        `${input.repository.defaultExecutor} executor`,
        error instanceof Error ? error.message : String(error)
      )
    );
  }
  return checks;
}

export async function runDoctor(input: {
  config: OpenTagDaemonConfig;
  executors: Record<string, ExecutorAdapter>;
  fetchImpl?: typeof fetch;
  commandRunner?: CommandRunner;
  codexConfigPath?: string;
  env?: Record<string, string | undefined>;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const commandRunner = input.commandRunner ?? nodeCommandRunner;
  const env = input.env ?? process.env;
  const hostedAuthProblem = input.config.controlRegistration
    ? hostedRunnerAuthProblem(input.config)
    : "The local Runner is not paired with Hosted Control V1.";
  const token = hostedAuthProblem ? undefined : input.config.runnerToken;
  const client = hostedAuthProblem
    ? undefined
    : createOpenTagClient({
        controlPlaneUrl: input.config.relayUrl,
        ...(token ? { controlCredential: { kind: "runtime", token } } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
      });
  let controlContext: Awaited<ReturnType<OpenTagClient["getRunnerControlContextV1"]>> | undefined;

  try {
    const response = await (input.fetchImpl ?? fetch)(`${input.config.relayUrl.replace(/\/$/, "")}/healthz`);
    checks.push(response.ok ? check("ok", "relay health", input.config.relayUrl) : check("fail", "relay health", `${response.status}`));
  } catch (error) {
    checks.push(check("fail", "relay health", error instanceof Error ? error.message : String(error)));
  }

  if (client) {
    try {
      controlContext = await client.getRunnerControlContextV1({ runnerId: input.config.runnerId });
      const registration = input.config.controlRegistration;
      if (!registration || !("registration" in registration)
        || controlContext.organizationId !== registration.registration.organizationId
        || controlContext.credentialId !== registration.registration.credentialId
        || controlContext.registrationGeneration !== registration.registration.registrationGeneration
        || controlContext.credentialGeneration !== registration.registration.credentialGeneration) {
        throw new Error("Runner Control Context does not match the persisted registration authority.");
      }
      checks.push(check(
        "ok",
        "runner registration",
        `${controlContext.runnerId}; organization=${controlContext.organizationId}; credentialGeneration=${controlContext.credentialGeneration}`
      ));
    } catch (error) {
      const remoteError = safeRemoteError(error);
      checks.push(
        check(
          "fail",
          "runner registration",
          remoteError.message
        )
      );
    }
  } else {
    checks.push(check("fail", "runner registration", hostedAuthProblem ?? "Hosted runner authentication is invalid."));
  }

  checks.push(checkRunnerApiAuth(input.config));

  if (!input.config.repositories.length) {
    const configuredAgentCount = Object.keys(input.config.agents ?? {}).length;
    checks.push(
      configuredAgentCount > 0
        ? check(
            "ok",
            "repository config",
            `${configuredAgentCount} configured agent${configuredAgentCount === 1 ? "" : "s"} support${configuredAgentCount === 1 ? "s" : ""} repository-free Runs.`
          )
        : check("fail", "repository config", "No repositories or agents are configured.")
    );
  }

  if (shouldCheckCodexConfig(input.config)) {
    checks.push(checkCodexConfig(input.codexConfigPath));
  }

  for (const repository of input.config.repositories) {
    checks.push(
      ...(await checkGitCheckout({
        repository,
        commandRunner,
        env,
        ...(input.executors[repository.defaultExecutor] ? { executor: input.executors[repository.defaultExecutor] } : {})
      }))
    );

    if (!controlContext) {
      checks.push(check("fail", `${repository.owner}/${repository.repo} binding`, hostedAuthProblem ?? "Hosted runner authentication is invalid."));
      continue;
    }
    const expected = canonicalRepositoryIdentity(repository);
    const target = controlContext.targets.find((candidate) => {
      const actual = canonicalRepositoryIdentity(candidate);
      return actual.provider === expected.provider
        && actual.owner === expected.owner
        && actual.repo === expected.repo;
    });
    checks.push(!target
      ? check("fail", `${repository.owner}/${repository.repo} binding`, "The Project Target is not registered for this Runner in the Control Plane.")
      : target.defaultExecutor !== repository.defaultExecutor
        ? check("fail", `${repository.owner}/${repository.repo} binding`, `Control Plane executor is ${target.defaultExecutor}, expected ${repository.defaultExecutor}.`)
        : check("ok", `${repository.owner}/${repository.repo} binding`, `Project Target ${target.projectTargetId} is bound to ${input.config.runnerId}`));
  }

  const repositoryExecutorIds = new Set(input.config.repositories.map((repository) => repository.defaultExecutor));
  for (const agentId of Object.keys(input.config.agents ?? {})) {
    if (repositoryExecutorIds.has(agentId)) continue;
    const executor = input.executors[agentId];
    if (!executor) {
      checks.push(check("fail", `${agentId} configured agent`, "No local executor is configured with this id."));
      continue;
    }
    checks.push(check("ok", `${agentId} configured agent`, `${executor.displayName} (${executor.id})`));
    checks.push(
      executor.capability
        ? checkExecutorCapability(agentId, executor.capability)
        : check(
            "warn",
            `${agentId} capability`,
            "Executor does not declare a capability contract; readiness may be incomplete."
          )
    );
    if (executor.capability) {
      checks.push(...checkExecutorSecretRequirements({ capability: executor.capability, env }));
    }
  }

  if (input.config.githubToken) {
    checks.push(check("ok", "GitHub publication", "Credential is configured for capability-authorized publication"));
  } else {
    checks.push(check("ok", "GitHub publication", "Optional credential is not configured; publication is unavailable"));
  }

  return checks;
}

export function formatDoctorChecks(checks: DoctorCheck[]): string {
  return checks.map((item) => `${item.status.toUpperCase().padEnd(4)} ${item.name}: ${item.message}`).join("\n");
}

export function doctorHasFailures(checks: DoctorCheck[]): boolean {
  return checks.some((item) => item.status === "fail");
}
