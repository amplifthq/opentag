#!/usr/bin/env node
import { Command } from "commander";
import {
  defaultConfigPath,
  formatCliConfigError,
  readRedactedCliConfig
} from "./config.js";
import { runExecutorsCommand } from "./commands/executors.js";
import { runSetupCommand } from "./commands/setup.js";
import { runDoctorCommand } from "./doctor.js";
import { runPairCommand } from "./pair.js";
import {
  runServiceAutostartDisableCommand,
  runServiceAutostartEnableCommand,
  runServiceInstallCommand,
  runServiceLogsCommand,
  runServiceRestartCommand,
  runServiceRunCommand,
  runServiceStartCommand,
  runServiceStatusCommand,
  runServiceStopCommand,
  runServiceUninstallCommand
} from "./service.js";
import { runStartCommand } from "./start.js";
import { runStatusCommand } from "./status.js";
import { createClackPromptAdapter } from "./ui/clack.js";
import { CLI_VERSION } from "./version.js";

const program = new Command();
program.version(CLI_VERSION);
program.name(process.env.OPENTAG_CLI_NAME?.trim() || "opentag")
  .description("OpenTag CLI");

function handleError(error: unknown): never {
  console.error(formatCliConfigError(error));
  process.exit(1);
}

function runCliAction<T extends unknown[]>(
  handler: (...args: T) => Promise<void> | void
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await handler(...args);
    } catch (error) {
      handleError(error);
    }
  };
}

program.command("setup")
  .description("Pair a local Runner and configure its ACP executor and GitHub Project Target")
  .option("--config <path>", "Config file path")
  .option("--project <path>", "Project checkout path")
  .option("--language <language>", "Setup language: en or zh-CN")
  .option("--executor <executor>", "ACP executor")
  .option("--hermes-command <command>", "Hermes CLI command")
  .option("--hermes-profile <profile>", "Fixed, pre-existing Hermes profile")
  .option("--agent-profile <profile>", "Executor-neutral agent session profile")
  .option("--agent-profile-template <template>", "Executor-neutral agent session profile template")
  .option("--github-repository <ownerRepo>", "GitHub Project Target as owner/repo")
  .option("--project-target-id <id>", "Project Target ID matching OPENTAG_SLACK_PROJECT_TARGET_ID")
  .requiredOption("--relay <url>", "Trusted remote relay")
  .option("--start", "Start OpenTag immediately after setup")
  .option("--no-start", "Do not ask to start OpenTag after setup")
  .option("--service", "Install and start OpenTag as a background service after setup")
  .option("-y, --yes", "Skip setup confirmation")
  .action(runCliAction(runSetupCommand));

program.command("pair")
  .description("Pair this local Runner with a remote relay")
  .option("--config <path>", "Config file path")
  .requiredOption("--relay <url>", "Remote relay URL")
  .option("--trust-relay-origin <origin>", "Authorize this exact HTTPS relay origin")
  .option("--recover <recoveryCredentialId>", "Re-provision using a recovery credential id")
  .action(runCliAction(async (options) => {
    const prompts = createClackPromptAdapter();
    await runPairCommand(options, {
      readBootstrapSecret: async () => {
        const configured = process.env.OPENTAG_BOOTSTRAP_PAIRING_TOKEN?.trim();
        if (configured) return configured;
        return prompts.password({ message: "Control Plane bootstrap pairing token" });
      },
      readRecoverySecret: async () => {
        const configured = process.env.OPENTAG_RECOVERY_CREDENTIAL?.trim();
        if (configured) return configured;
        return prompts.password({ message: "Runner recovery credential" });
      }
    });
  }));

program.command("start")
  .description("Start the paired local Runner")
  .option("--config <path>", "Config file path")
  .action(runCliAction(runStartCommand));

program.command("status")
  .description("Show local OpenTag status")
  .option("--config <path>", "Config file path")
  .action(runCliAction(runStatusCommand));

program.command("doctor")
  .description("Check relay, Runner, Project Target, and ACP readiness")
  .option("--config <path>")
  .action(runCliAction(runDoctorCommand));

const service = program.command("service").description("Control the OpenTag background service");
service.command("install").option("--config <path>")
  .action(runCliAction(runServiceInstallCommand));
service.command("start").option("--config <path>").action(runCliAction(runServiceStartCommand));
service.command("stop").option("--config <path>").action(runCliAction(runServiceStopCommand));
service.command("restart").option("--config <path>").action(runCliAction(runServiceRestartCommand));
service.command("status").option("--config <path>").action(runCliAction(runServiceStatusCommand));
service.command("logs").option("--config <path>").option("--lines <n>").action(runCliAction(runServiceLogsCommand));
service.command("uninstall").option("--config <path>").action(runCliAction(runServiceUninstallCommand));
const autostart = service.command("autostart");
autostart.command("enable").option("--config <path>").action(runCliAction(runServiceAutostartEnableCommand));
autostart.command("disable").option("--config <path>").action(runCliAction(runServiceAutostartDisableCommand));
service.command("run", { hidden: true }).option("--config <path>").option("--mode <mode>", "", "background").action(runCliAction(runServiceRunCommand));

program.command("executors").description("List available ACP executors").action(runExecutorsCommand);

const config = program.command("config").description("Inspect OpenTag config");
config.command("path").action(() => console.log(defaultConfigPath()));
config.command("show").option("--config <path>").action(runCliAction((options) => {
  console.log(JSON.stringify(readRedactedCliConfig(options.config ?? defaultConfigPath()), null, 2));
}));

await program.parseAsync(process.argv);
