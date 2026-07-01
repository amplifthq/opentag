import { defaultConfigPath, readCliConfig, writeCliConfigAtomic, type OpenTagCliConfig } from "./config.js";
import { probeDispatcherHealth } from "./health.js";
import { formatConfiguredProjectTargetSummary } from "./project-target-summary.js";
import { assertRelayTransportAllowed, relayTrustWarning } from "./relay-security.js";
import { bootstrapLocalDispatcher, type BootstrapClient } from "./start.js";

export type PairCommandOptions = {
  config?: string;
  relay?: string;
  register?: boolean;
};

export type PairRelayDependencies = {
  fetchImpl?: typeof fetch;
  bootstrapClient?: BootstrapClient;
  logger?: Pick<Console, "log" | "warn">;
  healthTimeoutMs?: number;
};

type PairRelaySummaryInput = {
  configPath: string;
  config: OpenTagCliConfig;
  relayUrl: string;
  registered: boolean;
};

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function normalizeRelayUrl(rawRelayUrl: string): string {
  const raw = rawRelayUrl.trim();
  if (!raw) {
    throw new Error("Relay URL must not be empty.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Relay URL must be a valid http or https URL: ${rawRelayUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Relay URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Relay URL must not include credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("Relay URL must not include a query string or fragment.");
  }
  return stripTrailingSlash(url.toString());
}

export function inferRelayProvider(relayUrl: string): string {
  const hostname = new URL(relayUrl).hostname.toLowerCase();
  return hostname.includes("railway") ? "railway" : "custom";
}

export function relayConfigFrom(input: { config: OpenTagCliConfig; relayUrl: string }): OpenTagCliConfig {
  const relayProvider = inferRelayProvider(input.relayUrl);
  return {
    ...input.config,
    runtime: {
      mode: "relay",
      relayUrl: input.relayUrl,
      relayProvider
    },
    daemon: {
      ...input.config.daemon,
      dispatcherUrl: input.relayUrl
    }
  };
}

function githubRelayWebhookUrl(relayUrl: string): string {
  return `${stripTrailingSlash(relayUrl)}/github/webhooks`;
}

export function formatPairRelaySummary(input: PairRelaySummaryInput): string {
  const projectTargets = input.config.daemon.repositories.map((repository) => {
    return `  ${formatConfiguredProjectTargetSummary(repository)}`;
  });
  return [
    "OpenTag relay pairing updated.",
    `Config: ${input.configPath}`,
    `Relay: ${input.relayUrl}`,
    `Runner: ${input.config.daemon.runnerId}`,
    `Registration: ${input.registered ? "completed" : "skipped"}`,
    relayTrustWarning(input.relayUrl),
    "Project Targets:",
    ...(projectTargets.length ? projectTargets : ["  none"]),
    ...(input.config.platforms.github ? [`GitHub webhook URL: ${githubRelayWebhookUrl(input.relayUrl)}`] : []),
    "Next steps:",
    `  opentag start --config ${input.configPath}`,
    "  opentag service start"
  ].join("\n");
}

export async function runPairCommand(options: PairCommandOptions, dependencies: PairRelayDependencies = {}): Promise<void> {
  if (!options.relay) {
    throw new Error("opentag pair currently requires --relay <url>.");
  }

  const logger = dependencies.logger ?? console;
  const configPath = options.config ?? defaultConfigPath();
  const relayUrl = normalizeRelayUrl(options.relay);
  assertRelayTransportAllowed(relayUrl);
  const config = readCliConfig(configPath);

  const healthy = await probeDispatcherHealth({
    dispatcherUrl: relayUrl,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    timeoutMs: dependencies.healthTimeoutMs ?? 5_000
  });
  if (!healthy) {
    throw new Error(`Relay health check failed at ${relayUrl}/healthz.`);
  }

  const updated = relayConfigFrom({ config, relayUrl });

  const shouldRegister = options.register !== false;
  if (shouldRegister) {
    await bootstrapLocalDispatcher(updated, dependencies.bootstrapClient);
  }

  writeCliConfigAtomic(configPath, updated);

  logger.log(
    formatPairRelaySummary({
      configPath,
      config: updated,
      relayUrl,
      registered: shouldRegister
    })
  );
}
