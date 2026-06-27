#!/usr/bin/env node
import { Command } from "commander";
import {
  defaultConfigPath,
  formatCliConfigError,
  readCliConfig,
  redactedCliConfig
} from "./config.js";
import { runExecutorsCommand } from "./commands/executors.js";
import { runPlatformsCommand } from "./commands/platforms.js";
import { runDoctorCommand } from "./doctor.js";
import { runSetupCommand } from "./commands/setup.js";
import { runStartCommand } from "./start.js";
import { runStatusCommand } from "./status.js";

const program = new Command();

function handleError(error: unknown): never {
  console.error(formatCliConfigError(error));
  process.exit(1);
}

program.name(process.env.OPENTAG_CLI_NAME?.trim() || "opentag").description("OpenTag CLI");

program
  .command("setup")
  .description("Create a local OpenTag config")
  .option("--platform <platform>", "Platform to configure")
  .option("--config <path>", "Config file path")
  .option("--project <path>", "Project checkout path")
  .option("--language <language>", "Setup language: en or zh-CN")
  .option("--executor <executor>", "Default executor: echo, codex, or claude-code")
  .option("--lark-setup <method>", "Lark setup method: saved, scan, or manual")
  .option("--lark-app-id <id>", "Lark app id")
  .option("--lark-app-secret <secret>", "Lark app secret")
  .option("--lark-domain <domain>", "Lark domain: lark or feishu")
  .option("--lark-bot-open-id <openId>", "Lark bot open id for group mentions")
  .option("--slack-mode <mode>", "Slack connection mode: socket_mode or events_api")
  .option("--slack-app-token <token>", "Slack app-level token for Socket Mode")
  .option("--slack-signing-secret <secret>", "Slack signing secret")
  .option("--slack-bot-token <token>", "Slack bot user OAuth token")
  .option("--slack-app-id <id>", "Slack app id")
  .option("--slack-team-id <id>", "Slack team id")
  .option("--slack-channel-id <id>", "Slack channel id")
  .option("--slack-port <port>", "Local Slack Events API port")
  .option("--github-token <token>", "GitHub token for comments and apply-1 pull requests")
  .option("--github-webhook-secret <secret>", "GitHub webhook secret; generated when omitted")
  .option("--github-repository <ownerRepo>", "GitHub repository as owner/repo")
  .option("--github-webhook-path <path>", "GitHub webhook path")
  .option("--github-port <port>", "Local GitHub webhook port")
  .option("--github-auto-create-pr", "Create pull requests immediately after runs")
  .option("--no-github-auto-create-pr", "Use the default apply-1 pull request flow")
  .option("--binding <method>", "Binding method: default_project or bind_later")
  .option("--force", "Overwrite an existing config")
  .option("--start", "Start OpenTag immediately after setup")
  .option("--no-start", "Do not ask to start OpenTag after setup")
  .option("-y, --yes", "Skip setup confirmation")
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

program
  .command("platforms")
  .description("List OpenTag platform setup support")
  .action(() => {
    runPlatformsCommand();
  });

program
  .command("executors")
  .description("List available coding agents")
  .action(() => {
    runExecutorsCommand();
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
