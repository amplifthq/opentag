import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nodeCommandRunner, type CommandRunner, type ExecutorAdapter } from "@opentag/runner";
import { createOpenTagClient } from "@opentag/client";
import { normalizeChannelBindings } from "./config.js";
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

const CODEX_SERVICE_TIERS = new Set(["fast", "flex"]);

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

  const invalidTier = serviceTiers.find((tier) => !CODEX_SERVICE_TIERS.has(tier));
  if (invalidTier) {
    return check(
      "fail",
      "Codex config",
      `Unsupported service_tier '${invalidTier}' in ${configPath}. Use 'fast' or 'flex'.`
    );
  }

  return check("ok", "Codex config", `service_tier=${serviceTiers.join(", ")}`);
}

async function checkGitCheckout(input: {
  repository: RepositoryBindingConfig;
  executor?: ExecutorAdapter;
  commandRunner: CommandRunner;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  if (!existsSync(input.repository.checkoutPath)) {
    return [check("fail", `${input.repository.owner}/${input.repository.repo} checkout`, `Path does not exist: ${input.repository.checkoutPath}`)];
  }
  checks.push(check("ok", `${input.repository.owner}/${input.repository.repo} checkout`, input.repository.checkoutPath));

  try {
    const gitRepo = await input.commandRunner.run("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: input.repository.checkoutPath
    });
    if (gitRepo.exitCode !== 0 || gitRepo.stdout.trim() !== "true") {
      checks.push(check("fail", `${input.repository.owner}/${input.repository.repo} git repo`, gitRepo.stderr || gitRepo.stdout || "Not a git repository."));
      return checks;
    }
    checks.push(check("ok", `${input.repository.owner}/${input.repository.repo} git repo`, "Git checkout detected"));
  } catch (error) {
    checks.push(
      check(
        "fail",
        `${input.repository.owner}/${input.repository.repo} git repo`,
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
  try {
    const readiness = await executor.canRun({
      runId: "doctor",
      workspacePath: input.repository.checkoutPath,
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
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const commandRunner = input.commandRunner ?? nodeCommandRunner;
  const client = createOpenTagClient({
    dispatcherUrl: input.config.dispatcherUrl,
    ...(input.config.pairingToken ? { pairingToken: input.config.pairingToken } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });

  try {
    const response = await (input.fetchImpl ?? fetch)(`${input.config.dispatcherUrl.replace(/\/$/, "")}/healthz`);
    checks.push(response.ok ? check("ok", "dispatcher health", input.config.dispatcherUrl) : check("fail", "dispatcher health", `${response.status}`));
  } catch (error) {
    checks.push(check("fail", "dispatcher health", error instanceof Error ? error.message : String(error)));
  }

  try {
    const { runner } = await client.getRunner({ runnerId: input.config.runnerId });
    checks.push(check("ok", "runner registration", `${runner.runnerId} (${runner.name})`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push(check(message.includes("runner_not_found") ? "fail" : "warn", "runner registration", message));
  }

  if (!input.config.repositories.length) {
    checks.push(check("fail", "repository config", "No repositories are configured."));
  }

  if (shouldCheckCodexConfig(input.config)) {
    checks.push(checkCodexConfig(input.codexConfigPath));
  }

  for (const repository of input.config.repositories) {
    checks.push(
      ...(await checkGitCheckout({
        repository,
        commandRunner,
        ...(input.executors[repository.defaultExecutor] ? { executor: input.executors[repository.defaultExecutor] } : {})
      }))
    );

    try {
      const { binding } = await client.getRepositoryBinding({
        provider: repository.provider,
        owner: repository.owner,
        repo: repository.repo
      });
      checks.push(
        binding.runnerId === input.config.runnerId
          ? check("ok", `${repository.owner}/${repository.repo} binding`, `Bound to ${binding.runnerId}`)
          : check("fail", `${repository.owner}/${repository.repo} binding`, `Bound to ${binding.runnerId}, expected ${input.config.runnerId}`)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push(check(message.includes("repo_binding_not_found") ? "warn" : "fail", `${repository.owner}/${repository.repo} binding`, message));
    }
  }

  for (const binding of normalizeChannelBindings(input.config)) {
    try {
      const { binding: remoteBinding } = await client.getChannelBinding({
        provider: binding.provider,
        accountId: binding.accountId,
        conversationId: binding.conversationId
      });
      checks.push(
        remoteBinding.repoProvider === binding.repoProvider &&
        remoteBinding.owner === binding.owner &&
        remoteBinding.repo === binding.repo
          ? check(
              "ok",
              `${binding.provider}:${binding.accountId}/${binding.conversationId} binding`,
              `${remoteBinding.repoProvider}:${remoteBinding.owner}/${remoteBinding.repo}`
            )
          : check(
              "fail",
              `${binding.provider}:${binding.accountId}/${binding.conversationId} binding`,
              `Bound to ${remoteBinding.repoProvider}:${remoteBinding.owner}/${remoteBinding.repo}, expected ${binding.repoProvider}:${binding.owner}/${binding.repo}`
            )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push(
        check(
          message.includes("channel_binding_not_found") ? "warn" : "fail",
          `${binding.provider}:${binding.accountId}/${binding.conversationId} binding`,
          message
        )
      );
    }
  }

  if (input.config.allowAutoCreatePullRequest) {
    checks.push(
      input.config.githubToken
        ? check("ok", "GitHub PR actions", "Configured for legacy immediate PR creation")
        : check("warn", "GitHub PR actions", "Immediate PR creation is enabled, but githubToken is not configured")
    );
  } else if (input.config.preparePullRequestBranch) {
    checks.push(
      input.config.githubToken
        ? check("ok", "GitHub PR actions", "Configured for thread-native `apply 1` PR creation")
        : check("warn", "GitHub PR actions", "Run branches will be pushed, but githubToken is required for `apply 1` PR creation")
    );
  } else if (input.config.githubToken) {
    checks.push(check("warn", "GitHub PR actions", "githubToken is configured, but run branch preparation is disabled"));
  } else {
    checks.push(check("warn", "GitHub PR actions", "Not configured; PR creation actions will be skipped or fail"));
  }

  return checks;
}

export function formatDoctorChecks(checks: DoctorCheck[]): string {
  return checks.map((item) => `${item.status.toUpperCase().padEnd(4)} ${item.name}: ${item.message}`).join("\n");
}

export function doctorHasFailures(checks: DoctorCheck[]): boolean {
  return checks.some((item) => item.status === "fail");
}
