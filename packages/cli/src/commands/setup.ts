import { existsSync } from "node:fs";
import {
  defaultConfigPath,
  ensurePrivateDirectory,
  writeCliConfigAtomic
} from "../config.js";
import { createSetupConfig } from "../setup/builders.js";
import { collectSetupInput, type SetupCommandOptions, type SetupFlowDependencies } from "../setup/flow.js";
import { formatSetupComplete } from "../setup/summary.js";
import { createClackPromptAdapter } from "../ui/clack.js";
import { scanLarkPersonalAgent } from "../platforms/lark/registration-ui.js";
import { runStartCommand, type StartCommandOptions } from "../start.js";

export type { SetupCommandOptions };

export type SetupCommandDependencies = Partial<Omit<SetupFlowDependencies, "prompts" | "scanLarkPersonalAgent">> & {
  prompts?: SetupFlowDependencies["prompts"];
  scanLarkPersonalAgent?: SetupFlowDependencies["scanLarkPersonalAgent"];
  startOpenTag?(options: StartCommandOptions): Promise<void>;
};

function startPromptMessage(language: string | undefined): string {
  return language === "zh-CN" ? "现在启动 OpenTag？" : "Start OpenTag now?";
}

function setupCompleteMessage(language: string | undefined): string {
  return language === "zh-CN" ? "OpenTag 设置完成。" : "OpenTag setup complete.";
}

function startingMessage(language: string | undefined): string {
  return language === "zh-CN" ? "正在启动 OpenTag..." : "Starting OpenTag...";
}

export async function runSetupCommand(options: SetupCommandOptions, dependencies: SetupCommandDependencies = {}): Promise<void> {
  const env = dependencies.env ?? process.env;
  const configPath = options.config ?? defaultConfigPath(env);
  if (options.yes && existsSync(configPath) && !options.force) {
    throw new Error(`OpenTag config already exists at ${configPath}. Use --force with --yes to overwrite it.`);
  }

  const prompts = dependencies.prompts ?? createClackPromptAdapter();
  const setupInput = await collectSetupInput(options, configPath, {
    prompts,
    scanLarkPersonalAgent: dependencies.scanLarkPersonalAgent ?? scanLarkPersonalAgent,
    ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
    ...(dependencies.env ? { env: dependencies.env } : {}),
    ...(dependencies.defaults ? { defaults: dependencies.defaults } : {})
  });
  const config = createSetupConfig(setupInput, env);
  ensurePrivateDirectory(config.state.directory);
  ensurePrivateDirectory(config.state.worktreeRoot);
  writeCliConfigAtomic(configPath, config);

  prompts.note(formatSetupComplete(config, configPath));

  const shouldStart =
    options.start ??
    (!options.yes
      ? await prompts.confirm({
          message: startPromptMessage(config.preferences?.language),
          initialValue: true
        })
      : false);
  if (shouldStart) {
    prompts.outro(startingMessage(config.preferences?.language));
    await (dependencies.startOpenTag ?? runStartCommand)({ config: configPath });
  } else {
    prompts.outro(setupCompleteMessage(config.preferences?.language));
  }
}
