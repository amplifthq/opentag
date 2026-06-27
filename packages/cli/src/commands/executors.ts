import { formatExecutors } from "../catalogs/executors.js";

export type ExecutorsCommandOptions = {
  env?: NodeJS.ProcessEnv;
};

export function runExecutorsCommand(options: ExecutorsCommandOptions = {}): void {
  console.log(formatExecutors(options.env ?? process.env));
}
