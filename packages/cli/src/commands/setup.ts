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

export type { SetupCommandOptions };

export type SetupCommandDependencies = Partial<Omit<SetupFlowDependencies, "prompts" | "scanLarkPersonalAgent">> & {
  prompts?: SetupFlowDependencies["prompts"];
  scanLarkPersonalAgent?: SetupFlowDependencies["scanLarkPersonalAgent"];
};

export async function runSetupCommand(options: SetupCommandOptions, dependencies: SetupCommandDependencies = {}): Promise<void> {
  const configPath = options.config ?? defaultConfigPath();
  if (options.yes && existsSync(configPath) && !options.force) {
    throw new Error(`OpenTag config already exists at ${configPath}. Use --force with --yes to overwrite it.`);
  }

  const setupInput = await collectSetupInput(options, configPath, {
    prompts: dependencies.prompts ?? createClackPromptAdapter(),
    scanLarkPersonalAgent: dependencies.scanLarkPersonalAgent ?? scanLarkPersonalAgent,
    ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
    ...(dependencies.env ? { env: dependencies.env } : {}),
    ...(dependencies.defaults ? { defaults: dependencies.defaults } : {})
  });
  const config = createSetupConfig(setupInput);
  ensurePrivateDirectory(config.state.directory);
  ensurePrivateDirectory(config.state.worktreeRoot);
  writeCliConfigAtomic(configPath, config);

  console.log(formatSetupComplete(config, configPath));
}
