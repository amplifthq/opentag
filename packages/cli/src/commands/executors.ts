import { formatExecutorCapability } from "../catalogs/capabilities.js";
import { EXECUTOR_CATALOG, formatExecutors } from "../catalogs/executors.js";

export type ExecutorsCommandOptions = {
  env?: NodeJS.ProcessEnv;
  logger?: Pick<typeof console, "log">;
};

export function formatExecutorCapabilityCatalog(): string {
  return ["Executor capabilities:", ...EXECUTOR_CATALOG.map((executor) => `  ${formatExecutorCapability(executor.id)}`)].join("\n");
}

export function formatExecutorsCommandOutput(env: NodeJS.ProcessEnv = process.env): string {
  return [formatExecutors(env), formatExecutorCapabilityCatalog()].join("\n\n");
}

export function runExecutorsCommand(options: ExecutorsCommandOptions = {}): void {
  const logger = options.logger ?? console;
  logger.log(formatExecutorsCommandOutput(options.env ?? process.env));
}
