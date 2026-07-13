import { defaultConfigPath, readCliConfig, writeCliConfigAtomic, type OpenTagCliConfig } from "./config.js";
import { evaluateRelayIngressCapability, probeDispatcherHealth, probeRelayCapabilities, type RelayIngressRequirement } from "./health.js";
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

function linearRelayIngressRequirement(config: OpenTagCliConfig): RelayIngressRequirement | undefined {
  const linear = config.platforms.linear;
  if (!linear) return undefined;
  if ((linear.webhookPath ?? "/linear/webhooks").startsWith("/linear/webhooks/")) return undefined;
  return {
    provider: "linear",
    path: linear.webhookPath ?? "/linear/webhooks",
    requireCallback: true,
    requireApply: true
  };
}

function formatOptionalRelayEnv(name: string, value: string | undefined): string[] {
  return value ? [`  ${name}=${value}`] : [];
}

export function formatLinearRelayProvisioningHint(config: OpenTagCliConfig): string {
  const linear = config.platforms.linear;
  if (!linear) return "";
  const target = linear.projectTarget;
  if (linear.auth?.method === "hosted_oauth_app") {
    return [
      "Configure the relay process for hosted Linear OAuth installs, then restart the relay and retry pairing:",
      "  OPENTAG_LINEAR_OAUTH_CLIENT_ID=<Linear OAuth app client id>",
      "  OPENTAG_LINEAR_OAUTH_REDIRECT_URI=<relay URL>/linear/oauth/callback",
      "  OPENTAG_LINEAR_OAUTH_CLIENT_SECRET=<optional Linear OAuth app client secret>",
      "  OPENTAG_LINEAR_OAUTH_WEBHOOK_SECRET=<Linear OAuth app webhook signing secret>",
      "  OPENTAG_LINEAR_OAUTH_WEBHOOK_PATH=/linear/oauth/webhooks",
      "Secrets are intentionally not printed here."
    ].join("\n");
  }
  return [
    "Configure the relay process with Linear environment variables, then restart the relay and retry pairing:",
    "  OPENTAG_LINEAR_API_KEY=<Linear OAuth access token or raw lin_api_... key>",
    "  OPENTAG_LINEAR_WEBHOOK_SECRET=<copy platforms.linear.webhookSecret from the local OpenTag config>",
    `  OPENTAG_LINEAR_WEBHOOK_PATH=${linear.webhookPath ?? "/linear/webhooks"}`,
    `  OPENTAG_LINEAR_REPO_PROVIDER=${target?.repoProvider ?? "<Project Target repo provider>"}`,
    `  OPENTAG_LINEAR_REPO_OWNER=${target?.owner ?? "<Project Target owner>"}`,
    `  OPENTAG_LINEAR_REPO_NAME=${target?.repo ?? "<Project Target repo>"}`,
    ...formatOptionalRelayEnv("OPENTAG_LINEAR_GRAPHQL_URL", linear.graphqlUrl),
    "Secrets are intentionally not printed here."
  ].join("\n");
}

export async function validateRelayPlatformCapabilities(input: {
  config: OpenTagCliConfig;
  relayUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<void> {
  const linear = input.config.platforms.linear;
  if (linear?.auth?.method === "hosted_oauth_app") {
    const probe = await probeRelayCapabilities({
      dispatcherUrl: input.relayUrl,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      timeoutMs: input.timeoutMs
    });
    if (probe.status !== "unknown") {
      const platform = probe.capabilities.platforms.find((candidate) => candidate.provider === "linear");
      if (platform?.oauthInstall?.enabled !== true) {
        const reason = platform?.oauthInstall?.reason ?? "Linear hosted OAuth install is not enabled.";
        const hint = formatLinearRelayProvisioningHint(input.config);
        throw new Error(
          `Relay ${input.relayUrl} is not ready for Linear hosted OAuth install: ${reason}${hint ? `\n\n${hint}` : ""}`
        );
      }
      if (platform?.ingress?.enabled !== true) {
        const reason = platform?.ingress?.reason ?? "Linear hosted OAuth webhook ingress is not enabled.";
        const hint = formatLinearRelayProvisioningHint(input.config);
        throw new Error(
          `Relay ${input.relayUrl} is not ready for Linear hosted OAuth webhooks: ${reason}${hint ? `\n\n${hint}` : ""}`
        );
      }
    }
    return;
  }
  const requirement = linearRelayIngressRequirement(input.config);
  if (!requirement) return;

  const probe = await probeRelayCapabilities({
    dispatcherUrl: input.relayUrl,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    timeoutMs: input.timeoutMs
  });
  if (probe.status === "unknown") return;

  const support = evaluateRelayIngressCapability(probe.capabilities, requirement);
  if (!support.ok) {
    const hint = formatLinearRelayProvisioningHint(input.config);
    throw new Error(
      `Relay ${input.relayUrl} is not ready for Linear at ${requirement.path}: ${support.reason}${hint ? `\n\n${hint}` : ""}`
    );
  }
}

function githubRelayWebhookUrl(relayUrl: string): string {
  return `${stripTrailingSlash(relayUrl)}/github/webhooks`;
}

function gitlabRelayWebhookUrl(relayUrl: string, webhookPath = "/gitlab/webhooks"): string {
  return `${stripTrailingSlash(relayUrl)}${webhookPath}`;
}

function linearRelayWebhookUrl(relayUrl: string, webhookPath = "/linear/webhooks"): string {
  return `${stripTrailingSlash(relayUrl)}${webhookPath}`;
}

function discordRelayInteractionsUrl(relayUrl: string, webhookPath = "/discord/interactions"): string {
  return `${stripTrailingSlash(relayUrl)}${webhookPath}`;
}

function teamsRelayWebhookUrl(relayUrl: string, webhookPath = "/teams/messages"): string {
  return `${stripTrailingSlash(relayUrl)}${webhookPath}`;
}

export function formatPairRelaySummary(input: PairRelaySummaryInput): string {
  const projectTargets = input.config.daemon.repositories.map((repository) => {
    return `  ${formatConfiguredProjectTargetSummary(repository)}`;
  });
  const discord = input.config.platforms.discord;
  const teams = input.config.platforms.teams;
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
    ...(input.config.platforms.gitlab
      ? [`GitLab webhook URL: ${gitlabRelayWebhookUrl(input.relayUrl, input.config.platforms.gitlab.webhookPath)}`]
      : []),
    ...(input.config.platforms.linear
      ? [`Linear webhook URL: ${linearRelayWebhookUrl(input.relayUrl, input.config.platforms.linear.webhookPath)}`]
      : []),
    ...(input.config.platforms.linear?.auth?.method === "hosted_oauth_app" && input.config.platforms.linear.auth.authorizationUrl
      ? [`Linear OAuth install URL: ${input.config.platforms.linear.auth.authorizationUrl}`]
      : []),
    ...(discord?.mode === "webhook" ? [`Discord Interactions Endpoint URL: ${discordRelayInteractionsUrl(input.relayUrl, discord.webhookPath)}`] : []),
    ...(teams ? [`Microsoft Teams Messaging Endpoint URL: ${teamsRelayWebhookUrl(input.relayUrl, teams.webhookPath)}`] : []),
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
  await validateRelayPlatformCapabilities({
    config: updated,
    relayUrl,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    timeoutMs: dependencies.healthTimeoutMs ?? 5_000
  });

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
