import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { projectTargetRefFromLocalPath } from "@opentag/core";
import {
  defaultConfigPath,
  defaultStateDirectory,
  ensurePrivateDirectory,
  writeCliConfigAtomic,
  type OpenTagCliConfig,
  type PathEnvironment
} from "./config.js";

export type LarkSetupInput = {
  projectPath: string;
  executor: "echo" | "codex" | "claude-code";
  lark: {
    appId: string;
    appSecret: string;
    domain: "lark" | "feishu";
    botOpenId?: string;
  };
  stateDirectory?: string;
};

export type SetupCommandOptions = {
  platform?: string;
  config?: string;
  project?: string;
  executor?: "echo" | "codex" | "claude-code";
  larkAppId?: string;
  larkAppSecret?: string;
  larkDomain?: "lark" | "feishu";
  larkBotOpenId?: string;
  force?: boolean;
};

function pairingToken(): string {
  return randomBytes(32).toString("hex");
}

function pathExistsOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const paths = env.PATH?.split(":") ?? [];
  return paths.some((directory) => existsSync(join(directory, command)));
}

export function defaultExecutor(env: NodeJS.ProcessEnv = process.env): "echo" | "codex" {
  return pathExistsOnPath("codex", env) ? "codex" : "echo";
}

function parseExecutor(value: string): "echo" | "codex" | "claude-code" {
  if (value === "echo" || value === "codex" || value === "claude-code") return value;
  throw new Error("Executor must be echo, codex, or claude-code.");
}

function parseLarkDomain(value: string): "lark" | "feishu" {
  if (value === "lark" || value === "feishu") return value;
  throw new Error("Lark domain must be lark or feishu.");
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

export function createSetupConfig(input: LarkSetupInput, env: PathEnvironment = process.env): OpenTagCliConfig {
  const checkoutPath = realpathSync.native(input.projectPath);
  const target = projectTargetRefFromLocalPath(checkoutPath);
  const stateDirectory = input.stateDirectory ?? defaultStateDirectory(env);
  const worktreeRoot = join(stateDirectory, "worktrees");
  const databasePath = join(stateDirectory, "opentag.db");

  return {
    schemaVersion: 1,
    state: {
      directory: stateDirectory,
      databasePath,
      worktreeRoot
    },
    daemon: {
      runnerId: "runner_local",
      dispatcherUrl: "http://localhost:3030",
      pairingToken: pairingToken(),
      repositories: [
        {
          provider: target.provider,
          owner: target.owner,
          repo: target.repo,
          checkoutPath,
          defaultExecutor: input.executor,
          baseBranch: "main",
          pushRemote: "origin",
          worktreeRoot,
          keepWorktree: "on_failure"
        }
      ],
      pollIntervalMs: 5000,
      heartbeatIntervalMs: 15000
    },
    platforms: {
      lark: {
        appId: input.lark.appId,
        appSecret: input.lark.appSecret,
        domain: input.lark.domain,
        ...(input.lark.botOpenId ? { botOpenId: input.lark.botOpenId } : {})
      }
    }
  };
}

async function promptForMissingSetupInput(options: SetupCommandOptions): Promise<LarkSetupInput> {
  const readline = createInterface({ input, output });
  try {
    const projectAnswer = options.project ?? (await readline.question(`Project path [${process.cwd()}]: `));
    const projectPath = projectAnswer.trim() || process.cwd();

    const detectedExecutor = defaultExecutor();
    const executorAnswer = options.executor ?? (await readline.question(`Executor [${detectedExecutor}]: `));
    const executor = parseExecutor(executorAnswer.trim() || detectedExecutor);

    const domainAnswer = options.larkDomain ?? (await readline.question("Lark domain [lark]: "));
    const domain = parseLarkDomain(domainAnswer.trim() || "lark");

    const appId = nonEmpty(options.larkAppId ?? (await readline.question("Lark App ID: ")), "Lark App ID");
    const appSecret = nonEmpty(options.larkAppSecret ?? (await readline.question("Lark App Secret: ")), "Lark App Secret");
    const botOpenId = (options.larkBotOpenId ?? (await readline.question("Lark Bot Open ID (optional): "))).trim();

    return {
      projectPath,
      executor,
      lark: {
        appId,
        appSecret,
        domain,
        ...(botOpenId ? { botOpenId } : {})
      }
    };
  } finally {
    readline.close();
  }
}

export async function runSetupCommand(options: SetupCommandOptions): Promise<void> {
  const platform = options.platform ?? "lark";
  if (platform !== "lark") {
    throw new Error("Only the lark platform is supported in this CLI preview.");
  }

  const configPath = options.config ?? defaultConfigPath();
  if (existsSync(configPath) && !options.force) {
    throw new Error(`OpenTag config already exists at ${configPath}. Use --force to overwrite it.`);
  }

  const setupInput = await promptForMissingSetupInput(options);
  const config = createSetupConfig(setupInput);
  ensurePrivateDirectory(config.state.directory);
  ensurePrivateDirectory(config.state.worktreeRoot);
  writeCliConfigAtomic(configPath, config);

  console.log(`OpenTag config written to ${configPath}`);
  console.log(`Project Target: ${config.daemon.repositories[0]?.provider}:${config.daemon.repositories[0]?.owner}/${config.daemon.repositories[0]?.repo}`);
  console.log("Run `opentag start` to start OpenTag.");
}
