#!/usr/bin/env node
import { Command } from "commander";
import {
  defaultConfigPath,
  formatCliConfigError,
  readCliConfig,
  redactedCliConfig
} from "./config.js";
import { runDoctorCommand } from "./doctor.js";
import { runSetupCommand } from "./setup.js";
import { runStartCommand } from "./start.js";
import { runStatusCommand } from "./status.js";

const program = new Command();

function handleError(error: unknown): never {
  console.error(formatCliConfigError(error));
  process.exit(1);
}

program.name("opentag").description("OpenTag CLI");

program
  .command("setup")
  .description("Create a local OpenTag config")
  .option("--platform <platform>", "Platform to configure", "lark")
  .option("--config <path>", "Config file path")
  .option("--project <path>", "Project checkout path")
  .option("--executor <executor>", "Default executor: echo, codex, or claude-code")
  .option("--lark-setup <method>", "Lark setup method: scan or manual")
  .option("--lark-app-id <id>", "Lark app id")
  .option("--lark-app-secret <secret>", "Lark app secret")
  .option("--lark-domain <domain>", "Lark domain: lark or feishu")
  .option("--lark-bot-open-id <openId>", "Lark bot open id for group mentions")
  .option("--force", "Overwrite an existing config")
  .action(async (options) => {
    try {
      await runSetupCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("start")
  .description("Start the local OpenTag stack")
  .option("--config <path>", "Config file path")
  .action(async (options) => {
    try {
      await runStartCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("status")
  .description("Show the local OpenTag status")
  .option("--config <path>", "Config file path")
  .action(async (options) => {
    try {
      await runStatusCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("doctor")
  .description("Check dispatcher, bindings, checkouts, and executors")
  .option("--config <path>", "Config file path")
  .action(async (options) => {
    try {
      await runDoctorCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

const configCommand = program.command("config").description("Inspect OpenTag config");

configCommand
  .command("path")
  .description("Print the OpenTag config path")
  .action(() => {
    console.log(defaultConfigPath());
  });

configCommand
  .command("show")
  .description("Print the OpenTag config with secrets redacted")
  .option("--config <path>", "Config file path")
  .action((options) => {
    try {
      console.log(JSON.stringify(redactedCliConfig(readCliConfig(options.config ?? defaultConfigPath())), null, 2));
    } catch (error) {
      handleError(error);
    }
  });

await program.parseAsync(process.argv);
