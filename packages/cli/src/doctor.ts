import { doctorHasFailures, executorsFromConfig, formatDoctorChecks, runDoctor } from "@opentag/local-runtime";
import { defaultConfigPath, readCliConfig } from "./config.js";

export type DoctorCommandOptions = {
  config?: string;
};

export async function runDoctorCommand(options: DoctorCommandOptions): Promise<void> {
  const config = readCliConfig(options.config ?? defaultConfigPath());
  const checks = await runDoctor({
    config: config.daemon,
    executors: executorsFromConfig(config.daemon)
  });
  console.log(formatDoctorChecks(checks));
  if (doctorHasFailures(checks)) {
    process.exitCode = 1;
  }
}
