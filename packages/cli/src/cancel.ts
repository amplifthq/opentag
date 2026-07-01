import { createOpenTagClient } from "@opentag/client";
import type { OpenTagRun } from "@opentag/core";
import { defaultConfigPath, readCliConfig, runnerDispatcherToken, type OpenTagCliConfig } from "./config.js";
import { parseChannelRef } from "./status.js";

export type CancelCommandOptions = {
  config?: string;
  run?: string;
  channel?: string;
  reason?: string;
  requestedBy?: string;
};

export type CancelCommandDependencies = {
  fetchImpl?: typeof fetch;
  logger?: Pick<typeof console, "log">;
};

export type CancelSummary = {
  configPath: string;
  dispatcherUrl: string;
  scope: string;
  run: OpenTagRun;
};

function nonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function cancellationReason(options: CancelCommandOptions): string {
  return options.reason?.trim() || "Cancellation requested from opentag CLI.";
}

function requestedBy(options: CancelCommandOptions): string {
  return options.requestedBy?.trim() || "cli:opentag";
}

function validateCancelTarget(options: CancelCommandOptions): void {
  if (options.run && options.channel) {
    throw new Error("Use either --run or --channel, not both.");
  }
  if (!options.run && !options.channel) {
    throw new Error("Provide --run <run_id> or --channel provider:account/conversation.");
  }
}

export async function cancelFromConfig(input: {
  config: OpenTagCliConfig;
  configPath: string;
  options: CancelCommandOptions;
  fetchImpl?: typeof fetch;
}): Promise<CancelSummary> {
  validateCancelTarget(input.options);
  const token = runnerDispatcherToken(input.config.daemon);
  const client = createOpenTagClient({
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    ...(token ? { pairingToken: token } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  const reason = cancellationReason(input.options);
  const requester = requestedBy(input.options);

  if (input.options.channel) {
    const channel = parseChannelRef(input.options.channel);
    const result = await client.cancelActiveChannelRun({
      ...channel,
      reason,
      requestedBy: requester
    });
    return {
      configPath: input.configPath,
      dispatcherUrl: input.config.daemon.dispatcherUrl,
      scope: `${channel.provider}:${channel.accountId}/${channel.conversationId}`,
      run: result.run
    };
  }

  const runId = nonEmpty(input.options.run, "--run");
  const result = await client.cancelRun({
    runId,
    reason,
    requestedBy: requester
  });
  return {
    configPath: input.configPath,
    dispatcherUrl: input.config.daemon.dispatcherUrl,
    scope: runId,
    run: result.run
  };
}

export function formatCancelSummary(summary: CancelSummary): string {
  const conclusion = summary.run.result?.conclusion;
  return [
    "Cancellation requested.",
    `Config: ${summary.configPath}`,
    `Dispatcher: ${summary.dispatcherUrl}`,
    `Scope: ${summary.scope}`,
    `Run: ${summary.run.id}`,
    `Status: ${summary.run.status}${conclusion ? ` (${conclusion})` : ""}`,
    "Stop is not treated as successful completion.",
    `Inspect audit detail with \`opentag status --run ${summary.run.id}\`.`
  ].join("\n");
}

export async function runCancelCommand(options: CancelCommandOptions, dependencies: CancelCommandDependencies = {}): Promise<void> {
  const configPath = options.config ?? defaultConfigPath();
  const config = readCliConfig(configPath);
  const logger = dependencies.logger ?? console;
  logger.log(formatCancelSummary(await cancelFromConfig({ config, configPath, options, ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}) })));
}
