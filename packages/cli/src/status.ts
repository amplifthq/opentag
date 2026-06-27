import { defaultConfigPath, readCliConfig, type OpenTagCliConfig } from "./config.js";
import { probeDispatcherHealth } from "./health.js";

export type StatusCommandOptions = {
  config?: string;
};

export type StatusSummary = {
  configPath: string;
  dispatcher: "online" | "offline";
  dispatcherUrl: string;
  runnerId: string;
  repositories: string[];
  platforms: string[];
};

export async function getStatusSummary(input: {
  configPath?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<StatusSummary> {
  const configPath = input.configPath ?? defaultConfigPath();
  const config = readCliConfig(configPath);
  return statusFromConfig({ config, configPath, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
}

export async function statusFromConfig(input: {
  config: OpenTagCliConfig;
  configPath: string;
  fetchImpl?: typeof fetch;
  healthTimeoutMs?: number;
}): Promise<StatusSummary> {
  const dispatcher = (await probeDispatcherHealth({
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    timeoutMs: input.healthTimeoutMs ?? 1_000
  }))
    ? "online"
    : "offline";

  return {
    configPath: input.configPath,
    dispatcher,
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    runnerId: input.config.daemon.runnerId,
    repositories: input.config.daemon.repositories.map((repository) => {
      return `${repository.provider}:${repository.owner}/${repository.repo} -> ${repository.checkoutPath}`;
    }),
    platforms: Object.entries(input.config.platforms)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
  };
}

export function formatStatus(summary: StatusSummary): string {
  return [
    `Config: ${summary.configPath}`,
    `Dispatcher: ${summary.dispatcher} (${summary.dispatcherUrl})`,
    `Runner: ${summary.runnerId}`,
    `Platforms: ${summary.platforms.length ? summary.platforms.join(", ") : "none"}`,
    "Project Targets:",
    ...(summary.repositories.length ? summary.repositories.map((repository) => `  ${repository}`) : ["  none"])
  ].join("\n");
}

export async function runStatusCommand(options: StatusCommandOptions): Promise<void> {
  console.log(formatStatus(await getStatusSummary({ ...(options.config ? { configPath: options.config } : {}) })));
}
