import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { projectTargetRefFromLocalPath } from "@opentag/core";
import type { LarkDomain, RegisteredLarkPersonalAgent } from "@opentag/lark";
import {
  defaultConfigPath,
  defaultStateDirectory,
  ensurePrivateDirectory,
  writeCliConfigAtomic,
  type OpenTagCliConfig,
  type PathEnvironment
} from "./config.js";
import { scanLarkPersonalAgent } from "./lark-registration.js";

export type LarkSetupInput = {
  projectPath: string;
  executor: "echo" | "codex" | "claude-code";
  lark: {
    appId: string;
    appSecret: string;
    domain: LarkDomain;
    botOpenId?: string;
  };
  stateDirectory?: string;
};

type LarkSetupMethod = "scan" | "manual";

export type SetupCommandOptions = {
  platform?: string;
  config?: string;
  project?: string;
  executor?: "echo" | "codex" | "claude-code";
  larkSetup?: LarkSetupMethod;
  larkAppId?: string;
  larkAppSecret?: string;
  larkDomain?: LarkDomain;
  larkBotOpenId?: string;
  force?: boolean;
};

export type SetupCommandDependencies = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  prompt?(question: string): Promise<string>;
  scanLarkPersonalAgent?: typeof scanLarkPersonalAgent;
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

function parseLarkSetupMethod(value: string): LarkSetupMethod {
  if (value === "scan" || value === "manual") return value;
  throw new Error("Lark setup method must be scan or manual.");
}

function parseLarkDomain(value: string): LarkDomain {
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

function hasManualLarkCredentials(options: SetupCommandOptions): boolean {
  return Boolean(options.larkAppId || options.larkAppSecret || options.larkBotOpenId);
}

function assertCompleteManualLarkCredentials(options: SetupCommandOptions): void {
  if (options.larkAppId && !options.larkAppSecret) {
    throw new Error("--lark-app-secret is required when --lark-app-id is provided.");
  }
  if (options.larkAppSecret && !options.larkAppId) {
    throw new Error("--lark-app-id is required when --lark-app-secret is provided.");
  }
}

function assertNoManualLarkCredentialFlags(options: SetupCommandOptions): void {
  if (hasManualLarkCredentials(options)) {
    throw new Error("--lark-app-id, --lark-app-secret, and --lark-bot-open-id can only be used with --lark-setup manual.");
  }
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

async function promptForMissingSetupInput(options: SetupCommandOptions, dependencies: SetupCommandDependencies = {}): Promise<LarkSetupInput> {
  const readline = dependencies.prompt ? undefined : createInterface({ input, output });
  const question =
    dependencies.prompt ??
    ((prompt: string) => {
      return readline!.question(prompt);
    });
  const cwd = dependencies.cwd ?? process.cwd();
  const scan = dependencies.scanLarkPersonalAgent ?? scanLarkPersonalAgent;

  try {
    const projectAnswer = options.project ?? (await question(`Project path [${cwd}]: `));
    const projectPath = projectAnswer.trim() || cwd;

    const detectedExecutor = defaultExecutor(dependencies.env);
    const executorAnswer = options.executor ?? (await question(`Executor [${detectedExecutor}]: `));
    const executor = parseExecutor(executorAnswer.trim() || detectedExecutor);

    const setupMethodAnswer =
      options.larkSetup ??
      (hasManualLarkCredentials(options) ? "manual" : await question("Lark setup method (scan/manual) [scan]: "));
    const setupMethod = parseLarkSetupMethod(setupMethodAnswer.trim() || "scan");

    if (setupMethod === "scan") {
      assertNoManualLarkCredentialFlags(options);
    } else {
      assertCompleteManualLarkCredentials(options);
    }

    const domainAnswer = options.larkDomain ?? (await question("Lark domain [lark]: "));
    const domain = parseLarkDomain(domainAnswer.trim() || "lark");

    let lark: RegisteredLarkPersonalAgent;
    if (setupMethod === "scan") {
      lark = await scan({ domain });
    } else {
      lark = {
        appId: nonEmpty(options.larkAppId ?? (await question("Lark App ID: ")), "Lark App ID"),
        appSecret: nonEmpty(options.larkAppSecret ?? (await question("Lark App Secret: ")), "Lark App Secret"),
        domain
      };
    }

    const botOpenId =
      (lark.botOpenId ?? options.larkBotOpenId ?? (await question("Lark Bot Open ID (optional): "))).trim();

    return {
      projectPath,
      executor,
      lark: {
        appId: lark.appId,
        appSecret: lark.appSecret,
        domain: lark.domain,
        ...(botOpenId ? { botOpenId } : {})
      }
    };
  } finally {
    readline?.close();
  }
}

export async function runSetupCommand(options: SetupCommandOptions, dependencies: SetupCommandDependencies = {}): Promise<void> {
  const platform = options.platform ?? "lark";
  if (platform !== "lark") {
    throw new Error("Only the lark platform is supported in this CLI preview.");
  }

  const configPath = options.config ?? defaultConfigPath();
  if (existsSync(configPath) && !options.force) {
    throw new Error(`OpenTag config already exists at ${configPath}. Use --force to overwrite it.`);
  }

  const setupInput = await promptForMissingSetupInput(options, dependencies);
  const config = createSetupConfig(setupInput);
  ensurePrivateDirectory(config.state.directory);
  ensurePrivateDirectory(config.state.worktreeRoot);
  writeCliConfigAtomic(configPath, config);

  console.log(`OpenTag config written to ${configPath}`);
  console.log(`Project Target: ${config.daemon.repositories[0]?.provider}:${config.daemon.repositories[0]?.owner}/${config.daemon.repositories[0]?.repo}`);
  console.log("Run `opentag start` to start OpenTag.");
}
