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
import { installAndStartService, serviceControllerForPlatform, type ServiceCommandOptions } from "../service.js";

export type { SetupCommandOptions };

export type SetupCommandDependencies = Partial<Omit<SetupFlowDependencies, "prompts" | "scanLarkPersonalAgent">> & {
  platform?: NodeJS.Platform;
  prompts?: SetupFlowDependencies["prompts"];
  scanLarkPersonalAgent?: SetupFlowDependencies["scanLarkPersonalAgent"];
  validateLarkCredentials?: SetupFlowDependencies["validateLarkCredentials"];
  startOpenTag?(options: StartCommandOptions): Promise<void>;
  startOpenTagService?(options: ServiceCommandOptions): Promise<void>;
};

type SetupRunMode = "service" | "terminal" | "later";

function setupCompleteMessage(language: string | undefined): string {
  return language === "zh-CN" ? "OpenTag 设置完成。" : "OpenTag setup complete.";
}

function startingMessage(language: string | undefined): string {
  return language === "zh-CN" ? "正在启动 OpenTag..." : "Starting OpenTag...";
}

function serviceStartingMessage(language: string | undefined): string {
  return language === "zh-CN" ? "正在安装并启动 OpenTag 后台服务..." : "Installing and starting the OpenTag background service...";
}

function serviceStartedMessage(language: string | undefined): string {
  return language === "zh-CN" ? "OpenTag 设置完成，后台服务已启动。" : "OpenTag setup complete. The background service is running.";
}

function runModePromptMessage(language: string | undefined): string {
  return language === "zh-CN" ? "OpenTag 要如何运行？" : "How should OpenTag run?";
}

function runModeOptions(language: string | undefined, serviceSupported: boolean) {
  if (language === "zh-CN") {
    return [
      ...(serviceSupported ? [{ value: "service" as const, label: "关闭这个终端后继续运行（推荐）" }] : []),
      { value: "terminal" as const, label: "只在当前终端里运行" },
      { value: "later" as const, label: "暂时不启动" }
    ];
  }
  return [
    ...(serviceSupported ? [{ value: "service" as const, label: "Keep running after I close this terminal (recommended)" }] : []),
    { value: "terminal" as const, label: "Run only in this terminal" },
    { value: "later" as const, label: "Do not start now" }
  ];
}

async function collectRunMode(
  options: SetupCommandOptions,
  prompts: SetupFlowDependencies["prompts"],
  language: string | undefined,
  platform: NodeJS.Platform
): Promise<SetupRunMode> {
  if (options.service) return "service";
  if (options.start === true) return "terminal";
  if (options.start === false || options.yes) return "later";
  const serviceSupported = serviceControllerForPlatform(platform) !== "unsupported";
  return prompts.select({
    message: runModePromptMessage(language),
    initialValue: serviceSupported ? "service" : "terminal",
    options: runModeOptions(language, serviceSupported)
  });
}

export async function runSetupCommand(options: SetupCommandOptions, dependencies: SetupCommandDependencies = {}): Promise<void> {
  if (options.service && options.start !== undefined) {
    throw new Error("--service cannot be combined with --start or --no-start.");
  }
  const platform = dependencies.platform ?? process.platform;
  if (options.service && serviceControllerForPlatform(platform) === "unsupported") {
    throw new Error("OpenTag background service is not supported on this platform. Use `opentag start` to run OpenTag in this terminal.");
  }

  const env = dependencies.env ?? process.env;
  const configPath = options.config ?? defaultConfigPath(env);
  if (options.yes && existsSync(configPath) && !options.force) {
    throw new Error(`OpenTag config already exists at ${configPath}. Use --force with --yes to overwrite it.`);
  }

  const prompts = dependencies.prompts ?? createClackPromptAdapter();
  const setupInput = await collectSetupInput(options, configPath, {
    prompts,
    scanLarkPersonalAgent: dependencies.scanLarkPersonalAgent ?? scanLarkPersonalAgent,
    ...(dependencies.validateLarkCredentials ? { validateLarkCredentials: dependencies.validateLarkCredentials } : {}),
    ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
    ...(dependencies.env ? { env: dependencies.env } : {}),
    ...(dependencies.defaults ? { defaults: dependencies.defaults } : {})
  });
  const config = createSetupConfig(setupInput, env);
  ensurePrivateDirectory(config.state.directory);
  ensurePrivateDirectory(config.state.worktreeRoot);
  writeCliConfigAtomic(configPath, config);

  prompts.note(formatSetupComplete(config, configPath));

  const runMode = await collectRunMode(options, prompts, config.preferences?.language, platform);

  if (runMode === "service") {
    prompts.note(serviceStartingMessage(config.preferences?.language));
    await (dependencies.startOpenTagService ?? installAndStartService)({ config: configPath });
    prompts.outro(serviceStartedMessage(config.preferences?.language));
    return;
  }

  if (runMode === "terminal") {
    prompts.outro(startingMessage(config.preferences?.language));
    await (dependencies.startOpenTag ?? runStartCommand)({ config: configPath });
  } else {
    prompts.outro(setupCompleteMessage(config.preferences?.language));
  }
}
