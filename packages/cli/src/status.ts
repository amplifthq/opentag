import { formatConfiguredCapabilities } from "./catalogs/capabilities.js";
import {
  defaultConfigPath,
  hostedRunnerAuthProblem,
  readCliConfig,
  readRedactedCliConfig,
  relayUrlFromConfig,
  type OpenTagCliConfig,
} from "./config.js";
import { probeRelayHealth } from "./health.js";
import { formatConfiguredProjectTargetSummary } from "./project-target-summary.js";
import {
  formatRelaySecurityChecks,
  relaySecurityChecksFromConfig,
} from "./relay-security.js";
import { formatSecretReadiness } from "./secret-readiness.js";

export type StatusCommandOptions = { config?: string };

export type StatusSummary = {
  configPath: string;
  relay: "online" | "offline";
  relayUrl: string;
  runnerId: string;
  registrationState: string;
  organizationId: string | null;
  registrationGeneration: number | null;
  credentialGeneration: number | null;
  readiness:
    | "not_paired"
    | "credential_unavailable"
    | "relay_unreachable"
    | "relay_reachable_unverified";
  readinessReason: string;
  relaySecurity: string[];
  secrets: string[];
  repositories: string[];
  capabilities: string[];
};

function registrationMetadata(config: OpenTagCliConfig) {
  const control = config.daemon.controlRegistration;
  return control && "registration" in control ? control.registration : undefined;
}

export async function statusFromConfig(input: {
  config: OpenTagCliConfig;
  configPath: string;
  fetchImpl?: typeof fetch;
  healthTimeoutMs?: number;
  secretConfig?: unknown;
}): Promise<StatusSummary> {
  const relayUrl = relayUrlFromConfig(input.config);
  const relay = await probeRelayHealth({
    relayUrl,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    timeoutMs: input.healthTimeoutMs ?? 1_000,
  }) ? "online" : "offline";
  const control = input.config.daemon.controlRegistration;
  const registration = registrationMetadata(input.config);
  const authProblem = control
    ? hostedRunnerAuthProblem(input.config.daemon)
    : "The local Runner is not paired with Hosted Control V1.";
  const readiness = !control
    ? "not_paired" as const
    : authProblem
      ? "credential_unavailable" as const
      : relay === "offline"
        ? "relay_unreachable" as const
        : "relay_reachable_unverified" as const;
  const readinessReason = !control
    ? "Pair the Runner before starting it."
    : authProblem
      ? authProblem
      : relay === "offline"
        ? "The paired relay health endpoint is unreachable."
        : "The relay is reachable; current Runner readiness must be confirmed by Control Plane evidence.";
  return {
    configPath: input.configPath,
    relay,
    relayUrl,
    runnerId: input.config.daemon.runnerId,
    registrationState: control?.state ?? "unpaired",
    organizationId: registration?.organizationId ?? null,
    registrationGeneration: registration?.registrationGeneration ?? null,
    credentialGeneration: registration?.credentialGeneration ?? null,
    readiness,
    readinessReason,
    relaySecurity: formatRelaySecurityChecks(
      relaySecurityChecksFromConfig(input.config),
    ),
    secrets: formatSecretReadiness(
      input.secretConfig ?? input.config,
    ),
    repositories: input.config.daemon.repositories.map(
      formatConfiguredProjectTargetSummary,
    ),
    capabilities: formatConfiguredCapabilities({
      executors: input.config.daemon.repositories.map(
        (repository) => repository.defaultExecutor,
      ),
    }),
  };
}

export async function getStatusSummary(input: {
  configPath?: string;
  fetchImpl?: typeof fetch;
  healthTimeoutMs?: number;
} = {}): Promise<StatusSummary> {
  const configPath = input.configPath ?? defaultConfigPath();
  return statusFromConfig({
    config: readCliConfig(configPath),
    configPath,
    secretConfig: readRedactedCliConfig(configPath),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.healthTimeoutMs ? { healthTimeoutMs: input.healthTimeoutMs } : {}),
  });
}

export function formatStatus(summary: StatusSummary): string {
  return [
    `Config: ${summary.configPath}`,
    `Relay: ${summary.relay} (${summary.relayUrl})`,
    ...summary.relaySecurity,
    `Runner: ${summary.runnerId}`,
    `Registration: ${summary.registrationState}`,
    `Organization: ${summary.organizationId ?? "unknown"}`,
    `Registration generation: ${summary.registrationGeneration ?? "unknown"}`,
    `Credential generation: ${summary.credentialGeneration ?? "unknown"}`,
    `Runner readiness: ${summary.readiness}`,
    `Reason: ${summary.readinessReason}`,
    ...summary.secrets,
    ...summary.capabilities,
    "Project Targets:",
    ...(summary.repositories.length
      ? summary.repositories.map((repository) => `  ${repository}`)
      : ["  none"]),
  ].join("\n");
}

export async function runStatusCommand(options: StatusCommandOptions): Promise<void> {
  console.log(await getStatusSummary({
    ...(options.config ? { configPath: options.config } : {}),
  }).then(formatStatus));
}
