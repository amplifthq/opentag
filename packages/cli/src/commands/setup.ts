import { existsSync } from "node:fs";
import { probeHermesProfile as probeHermesProfileReadiness } from "@opentag/local-runtime";
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
import { probeDispatcherHealth } from "../health.js";
import { formatPairRelaySummary, normalizeRelayUrl, relayConfigFrom, validateRelayPlatformCapabilities } from "../pair.js";
import { assertRelayTransportAllowed } from "../relay-security.js";
import { bootstrapLocalDispatcher, runStartCommand, type BootstrapClient, type StartCommandOptions } from "../start.js";
import { installAndStartService, serviceControllerForPlatform, type ServiceCommandOptions } from "../service.js";

export type { SetupCommandOptions };

export type SetupCommandDependencies = Partial<Omit<SetupFlowDependencies, "prompts" | "scanLarkPersonalAgent">> & {
  platform?: NodeJS.Platform;
  prompts?: SetupFlowDependencies["prompts"];
  scanLarkPersonalAgent?: SetupFlowDependencies["scanLarkPersonalAgent"];
  validateLarkCredentials?: SetupFlowDependencies["validateLarkCredentials"];
  bootstrapClient?: BootstrapClient;
  fetchImpl?: typeof fetch;
  healthTimeoutMs?: number;
  probeHermesProfile?: typeof probeHermesProfileReadiness;
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
    ...(dependencies.exchangeLinearOAuthCode ? { exchangeLinearOAuthCode: dependencies.exchangeLinearOAuthCode } : {}),
    ...(dependencies.discoverLinearMetadata ? { discoverLinearMetadata: dependencies.discoverLinearMetadata } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
    ...(dependencies.env ? { env: dependencies.env } : {}),
    ...(dependencies.defaults ? { defaults: dependencies.defaults } : {})
  });
  if (setupInput.hermes) {
    const readiness = await (dependencies.probeHermesProfile ?? probeHermesProfileReadiness)({
      ...(setupInput.hermes.command ? { hermesCommand: setupInput.hermes.command } : {}),
      profile: setupInput.hermes.profile,
      cwd: setupInput.projectPath
    });
    if (!readiness.ready) {
      throw new Error(readiness.reason ?? `Hermes profile '${setupInput.hermes.profile}' is not ready.`);
    }
  }
  let config = createSetupConfig(setupInput, env);
  let relayUrl: string | undefined;
  let relayRegistered = false;
  if (options.relay) {
    relayUrl = normalizeRelayUrl(options.relay);
    assertRelayTransportAllowed(relayUrl);
    const healthy = await probeDispatcherHealth({
      dispatcherUrl: relayUrl,
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      timeoutMs: dependencies.healthTimeoutMs ?? 5_000
    });
    if (!healthy) {
      throw new Error(`Relay health check failed at ${relayUrl}/healthz.`);
    }
    config = relayConfigFrom({ config, relayUrl });
    await validateRelayPlatformCapabilities({
      config,
      relayUrl,
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      timeoutMs: dependencies.healthTimeoutMs ?? 5_000
    });
    await bootstrapLocalDispatcher(config, dependencies.bootstrapClient);
    relayRegistered = true;
  }
  ensurePrivateDirectory(config.state.directory);
  ensurePrivateDirectory(config.state.worktreeRoot);
  writeCliConfigAtomic(configPath, config);

  prompts.note(formatSetupComplete(config, configPath));
  if (relayUrl) {
    prompts.note(
      formatPairRelaySummary({
        configPath,
        config,
        relayUrl,
        registered: relayRegistered
      })
    );
  }

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
