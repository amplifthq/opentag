#!/usr/bin/env node
import { Command } from "commander";
import {
  defaultConfigPath,
  formatCliConfigError,
  readRedactedCliConfig
} from "./config.js";
import { runExecutorsCommand } from "./commands/executors.js";
import { runPlatformsCommand } from "./commands/platforms.js";
import { runCancelCommand } from "./cancel.js";
import { runDoctorCommand } from "./doctor.js";
import { runIngestCommand, runIngestTemplateCommand } from "./ingest.js";
import { runMaintenancePruneSourceDeliveriesCommand } from "./maintenance.js";
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
  .option("--executor <executor>", "Default executor: echo, codex, claude-code, or hermes")
  .option("--hermes-command <command>", "Hermes CLI command")
  .option("--hermes-profile <profile>", "Hermes profile")
  .option("--hermes-profile-template <template>", "Hermes profile template")
  .option("--agent-profile <profile>", "Executor-neutral agent session profile")
  .option("--agent-profile-template <template>", "Executor-neutral agent session profile template")
  .option("--lark-setup <method>", "Lark setup method: saved, scan, or manual")
  .option("--lark-app-id <id>", "Lark app id")
  .option("--lark-app-secret <secret>", "Lark app secret")
  .option("--tenant <tenant>", "Manual Lark / Feishu tenant: feishu or lark")
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
  .command("pair")
  .description("Pair this local runner with a remote relay")
  .option("--config <path>", "Config file path")
  .option("--relay <url>", "Remote relay dispatcher URL")
  .option("--no-register", "Update config without registering runner and project targets")
  .action(async (options) => {
    try {
      await runPairCommand(options);
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
  .option("--run <runId>", "Show audit details for one run")
  .option("--channel <provider:account/conversation>", "Show active run and queued follow-ups for one source container")
  .action(async (options) => {
    try {
      await runStatusCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("cancel")
  .description("Request cancellation for a run or the active run in a source container")
  .option("--config <path>", "Config file path")
  .option("--run <runId>", "Cancel one run by id")
  .option("--channel <provider:account/conversation>", "Cancel the active run for one source container")
  .option("--reason <reason>", "Audit reason for cancellation")
  .option("--requested-by <actor>", "Audit actor requesting cancellation")
  .action(async (options) => {
    try {
      await runCancelCommand(options);
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
  .command("ingest")
  .description("Ingest a local external agent progress or completion event")
  .option("--config <path>", "Config file path")
  .requiredOption("--run <runId>", "OpenTag run id")
  .requiredOption("--event <event>", "Event: progress, post_llm_call, before_agent_finalize, agent_end, failed, cancelled, timed_out, or interrupted")
  .option("--source <source>", "External agent runtime source label")
  .option("--message <message>", "Progress or completion summary")
  .option("--type <type>", "Progress event type")
  .option("--idempotency-key <key>", "Stable replay-protection key for retrying the same progress event")
  .option("--result-json <json>", "Complete run with an OpenTagRunResult JSON object")
  .option("--conclusion <conclusion>", "Completion conclusion when --result-json is omitted")
  .option("--summary <summary>", "Completion summary when --result-json is omitted")
  .action(async (options) => {
    try {
      await runIngestCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("ingest-template")
  .description("Print a shell template or manifest for local external agent hook ingest")
  .option("--source <source>", "External agent runtime source label")
  .option("--command <command>", "OpenTag CLI command to use in the template")
  .option("--format <format>", "Template format: shell or manifest")
  .action(async (options) => {
    try {
      await runIngestTemplateCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

const serviceCommand = program.command("service").description("Install and control the OpenTag background service");

serviceCommand
  .command("install")
  .description("Install the OpenTag user LaunchAgent")
  .option("--config <path>", "Config file path")
  .option("--max-request-body-bytes <bytes>", "Persist dispatcher request body limit in the LaunchAgent")
  .option("--rate-limit-window-ms <ms>", "Persist dispatcher rate-limit window in the LaunchAgent")
  .option("--rate-limit-max-requests <n>", "Persist dispatcher rate-limit max requests in the LaunchAgent")
  .option("--rate-limit-disabled", "Persist an explicit disabled dispatcher rate-limit state in the LaunchAgent")
  .action(async (options) => {
    try {
      await runServiceInstallCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

serviceCommand
  .command("start")
  .description("Start the OpenTag background service")
  .option("--config <path>", "Config file path")
  .action(async (options) => {
    try {
      await runServiceStartCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

serviceCommand
  .command("stop")
  .description("Stop the OpenTag background service")
  .option("--config <path>", "Config file path")
  .action(async (options) => {
    try {
      await runServiceStopCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

serviceCommand
  .command("restart")
  .description("Restart the OpenTag background service")
  .option("--config <path>", "Config file path")
  .action(async (options) => {
    try {
      await runServiceRestartCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

serviceCommand
  .command("status")
  .description("Show the OpenTag background service status")
  .option("--config <path>", "Config file path")
  .action(async (options) => {
    try {
      await runServiceStatusCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

serviceCommand
  .command("logs")
  .description("Show recent OpenTag background service logs")
  .option("--config <path>", "Config file path")
  .option("--lines <n>", "Number of lines per log file")
  .action(async (options) => {
    try {
      await runServiceLogsCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

serviceCommand
  .command("uninstall")
  .description("Uninstall the OpenTag background service")
  .option("--config <path>", "Config file path")
  .action(async (options) => {
    try {
      await runServiceUninstallCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

const autostartCommand = serviceCommand.command("autostart").description("Control OpenTag service login autostart");

autostartCommand
  .command("enable")
  .description("Enable OpenTag service login autostart")
  .option("--config <path>", "Config file path")
  .action(async (options) => {
    try {
      await runServiceAutostartEnableCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

autostartCommand
  .command("disable")
  .description("Disable OpenTag service login autostart")
  .option("--config <path>", "Config file path")
  .action(async (options) => {
    try {
      await runServiceAutostartDisableCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

serviceCommand
  .command("run", { hidden: true })
  .description("Run the OpenTag service payload")
  .option("--config <path>", "Config file path")
  .option("--mode <mode>", "Service run mode", "background")
  .action(async (options) => {
    try {
      await runServiceRunCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("platforms")
  .description("List OpenTag platform setup support and runtime capabilities")
  .action(() => {
    runPlatformsCommand();
  });

program
  .command("executors")
  .description("List available coding agents and runtime capabilities")
  .action(() => {
    runExecutorsCommand();
  });

const maintenanceCommand = program.command("maintenance").description("Run explicit OpenTag maintenance operations");

maintenanceCommand
  .command("prune-source-deliveries")
  .description("Prune stale source delivery replay keys after their runs are terminal")
  .option("--config <path>", "Config file path")
  .requiredOption("--older-than <timestamp>", "Prune delivery replay keys created before this ISO timestamp")
  .option("--limit <n>", "Maximum delivery replay keys to scan")
  .action(async (options) => {
    try {
      await runMaintenancePruneSourceDeliveriesCommand(options);
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
      console.log(JSON.stringify(readRedactedCliConfig(options.config ?? defaultConfigPath()), null, 2));
    } catch (error) {
      handleError(error);
    }
  });

await program.parseAsync(process.argv);
