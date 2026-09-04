import {
  createDaemonRuntimeInput,
  hostedRunnerAuthProblem,
  serveDaemon,
} from "@opentag/local-runtime";
import {
  defaultConfigPath,
  ensurePrivateDirectory,
  readCliConfig,
  relayUrlFromConfig,
  type OpenTagCliConfig,
} from "./config.js";
import { probeRelayHealth } from "./health.js";
import {
  assertHostedRelayAuthorization,
  assertRelayTransportAllowed,
  relayTrustWarning,
} from "./relay-security.js";

export type StartCommandOptions = { config?: string; background?: boolean };

export type StartRuntimeDependencies = {
  createDaemonRuntimeInput?: typeof createDaemonRuntimeInput;
  logger?: Pick<Console, "log">;
  readConfig?: typeof readCliConfig;
  serveDaemon?: typeof serveDaemon;
  waitForRelay?: typeof waitForRelay;
};

export type StartFromConfigInput = {
  config: OpenTagCliConfig;
  configPath: string;
  dependencies?: StartRuntimeDependencies;
  listenForProcessSignals?: boolean;
  signal?: AbortSignal;
};

export async function waitForRelay(input: {
  relayUrl: string;
  fetchImpl?: typeof fetch;
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
}): Promise<void> {
  const attempts = input.attempts ?? 60;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await probeRelayHealth({
      relayUrl: input.relayUrl,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      timeoutMs: input.timeoutMs ?? 1_000,
    })) return;
    await new Promise((resolve) => setTimeout(resolve, input.delayMs ?? 500));
  }
  throw new Error(
    `Relay did not become healthy at ${input.relayUrl.replace(/\/$/u, "")}/healthz.`,
  );
}

export function shouldRethrowAbortReason(input: {
  shutdownRequested: boolean;
  reason: unknown;
}): boolean {
  return !input.shutdownRequested && input.reason instanceof Error;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function addAbortHandlers(input: StartFromConfigInput, controller: AbortController) {
  let shutdownRequested = false;
  const abort = (reason?: unknown) => {
    shutdownRequested = true;
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onSignal = () => abort();
  const onExternal = () => abort(input.signal?.reason);
  if (input.listenForProcessSignals !== false) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  if (input.signal) {
    if (input.signal.aborted) onExternal();
    else input.signal.addEventListener("abort", onExternal, { once: true });
  }
  return {
    shutdownRequested: () => shutdownRequested,
    dispose() {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      input.signal?.removeEventListener("abort", onExternal);
    },
  };
}

function abortOnFailure(promise: Promise<void>, controller: AbortController): void {
  promise.catch((error) => {
    if (!controller.signal.aborted) controller.abort(error);
  });
}

function defaultStartDependencies(dependencies: StartRuntimeDependencies = {}) {
  return {
    createDaemonRuntimeInput:
      dependencies.createDaemonRuntimeInput ?? createDaemonRuntimeInput,
    logger: dependencies.logger ?? console,
    readConfig: dependencies.readConfig ?? readCliConfig,
    serveDaemon: dependencies.serveDaemon ?? serveDaemon,
    waitForRelay: dependencies.waitForRelay ?? waitForRelay,
  };
}

export async function startFromConfig(input: StartFromConfigInput): Promise<void> {
  const config = input.config;
  const relayUrl = relayUrlFromConfig(config);
  assertRelayTransportAllowed(relayUrl);
  if (!config.daemon.controlRegistration) {
    throw new Error(
      "The local Runner is not paired with Hosted Control V1; run `opentag pair` before `opentag start`.",
    );
  }
  assertHostedRelayAuthorization({
    relayUrl,
    trustedRelay: config.daemon.trustedRelay,
  });
  const authProblem = hostedRunnerAuthProblem(config.daemon);
  if (authProblem) throw new Error(authProblem);

  ensurePrivateDirectory(config.state.directory);
  ensurePrivateDirectory(config.state.worktreeRoot);

  const dependencies = defaultStartDependencies(input.dependencies);
  await dependencies.waitForRelay({ relayUrl });
  const controller = new AbortController();
  const handlers = addAbortHandlers(input, controller);
  try {
    const daemonPromise = dependencies.serveDaemon({
      ...dependencies.createDaemonRuntimeInput(config.daemon, {
        databasePath: config.state.databasePath,
      }),
      signal: controller.signal,
    });
    abortOnFailure(daemonPromise, controller);
    dependencies.logger.log("OpenTag paired Runner is running.");
    dependencies.logger.log(`Relay: ${relayUrl}`);
    dependencies.logger.log(relayTrustWarning(relayUrl));
    dependencies.logger.log(`Runner: ${config.daemon.runnerId}`);
    dependencies.logger.log("Press Ctrl-C to stop.");
    try {
      await waitForAbort(controller.signal);
      const reason = controller.signal.reason;
      if (shouldRethrowAbortReason({
        shutdownRequested: handlers.shutdownRequested(),
        reason,
      })) throw reason;
    } finally {
      controller.abort();
      await Promise.allSettled([daemonPromise]);
    }
  } finally {
    handlers.dispose();
  }
}

export async function runStartCommand(options: StartCommandOptions): Promise<void> {
  const configPath = options.config ?? defaultConfigPath();
  const dependencies = defaultStartDependencies();
  const config = dependencies.readConfig(configPath);
  await startFromConfig({ config, configPath });
}
