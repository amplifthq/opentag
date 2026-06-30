import { createOpenTagClient, type RunMetrics } from "@opentag/client";
import type { OpenTagEvent, OpenTagRun } from "@opentag/core";
import { defaultConfigPath, readCliConfig, type OpenTagCliConfig } from "./config.js";
import { probeDispatcherHealth } from "./health.js";

export type StatusCommandOptions = {
  config?: string;
  run?: string;
};

export type StatusSummary = {
  configPath: string;
  dispatcher: "online" | "offline";
  dispatcherUrl: string;
  runnerId: string;
  repositories: string[];
  platforms: string[];
};

type RunAuditEvent = {
  type?: unknown;
  visibility?: unknown;
  importance?: unknown;
  message?: unknown;
  createdAt?: unknown;
};

export type RunStatusSummary = {
  configPath: string;
  dispatcherUrl: string;
  run: OpenTagRun;
  event: OpenTagEvent;
  metrics: RunMetrics;
  events: RunAuditEvent[];
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

export async function getRunStatusSummary(input: {
  runId: string;
  configPath?: string;
  fetchImpl?: typeof fetch;
}): Promise<RunStatusSummary> {
  const configPath = input.configPath ?? defaultConfigPath();
  const config = readCliConfig(configPath);
  return runStatusFromConfig({
    config,
    configPath,
    runId: input.runId,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
}

export async function runStatusFromConfig(input: {
  config: OpenTagCliConfig;
  configPath: string;
  runId: string;
  fetchImpl?: typeof fetch;
}): Promise<RunStatusSummary> {
  const client = createOpenTagClient({
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    ...(input.config.daemon.pairingToken ? { pairingToken: input.config.daemon.pairingToken } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  const [claimed, events, metrics] = await Promise.all([
    client.getRun({ runId: input.runId }),
    client.listRunEvents({ runId: input.runId }),
    client.getRunMetrics({ runId: input.runId })
  ]);
  return {
    configPath: input.configPath,
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    run: claimed.run,
    event: claimed.event,
    metrics: metrics.metrics,
    events: events.events as RunAuditEvent[]
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

function displayValue(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function formatRunEvent(event: RunAuditEvent): string {
  const createdAt = displayValue(event.createdAt);
  const visibility = displayValue(event.visibility);
  const importance = displayValue(event.importance);
  const message = typeof event.message === "string" && event.message.length > 0 ? ` - ${event.message}` : "";
  return `  ${createdAt} ${visibility}/${importance} ${displayValue(event.type)}${message}`;
}

export function formatRunStatus(summary: RunStatusSummary): string {
  const latestEvents = summary.events.slice(-5);
  const conclusion = summary.run.result?.conclusion;
  return [
    `Config: ${summary.configPath}`,
    `Dispatcher: ${summary.dispatcherUrl}`,
    `Run: ${summary.run.id}`,
    `Status: ${summary.run.status}${conclusion ? ` (${conclusion})` : ""}`,
    `Source: ${summary.event.source} (${summary.event.sourceEventId})`,
    `Command: ${summary.event.command.rawText}`,
    `Updated: ${summary.run.updatedAt}`,
    `Metrics: ${summary.metrics.totalEventCount} events, ${summary.metrics.suggestedChangesCount} suggested action(s), ${summary.metrics.applyPlanCount} apply plan(s), ${summary.metrics.staleIntentCount} stale intent(s)`,
    "Recent Events:",
    ...(latestEvents.length ? latestEvents.map(formatRunEvent) : ["  none"])
  ].join("\n");
}

export async function runStatusCommand(options: StatusCommandOptions): Promise<void> {
  if (options.run) {
    console.log(formatRunStatus(await getRunStatusSummary({ runId: options.run, ...(options.config ? { configPath: options.config } : {}) })));
    return;
  }
  console.log(formatStatus(await getStatusSummary({ ...(options.config ? { configPath: options.config } : {}) })));
}
