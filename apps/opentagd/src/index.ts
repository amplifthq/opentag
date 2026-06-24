#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createCodexExecutor, createEchoExecutor } from "@opentag/runner";
import { createDispatcherAdminClient, createDispatcherClient } from "@opentag/client";
import { Command } from "commander";
import { createInitialConfig, formatConfigError, loadConfigFromEnv } from "./config.js";
import { runOneDaemonIteration, serveDaemon } from "./daemon.js";
import { doctorHasFailures, formatDoctorChecks, runDoctor } from "./doctor.js";

const program = new Command();

program
  .name("opentagd")
  .description("OpenTag local daemon");

function loadConfigOrExit() {
  try {
    return loadConfigFromEnv();
  } catch (error) {
    console.error(`Invalid OpenTag daemon config:\n${formatConfigError(error)}`);
    process.exit(1);
  }
}

function executors() {
  return {
    echo: createEchoExecutor(),
    codex: createCodexExecutor()
  };
}

program
  .command("init")
  .description("Create a minimal OpenTag local daemon config")
  .requiredOption("--owner <owner>", "GitHub repository owner")
  .requiredOption("--repo <repo>", "GitHub repository name")
  .requiredOption("--checkout <path>", "Local checkout path")
  .option("--output <path>", "Config file path", "opentag.local.json")
  .option("--runner-id <id>", "Runner id", "runner_local")
  .option("--dispatcher-url <url>", "Dispatcher URL", "http://localhost:3030")
  .option("--pairing-token <token>", "Dispatcher pairing token")
  .option("--executor <executor>", "Default executor: echo or codex", "echo")
  .option("--base-branch <branch>", "Base branch for PR creation", "main")
  .option("--push-remote <remote>", "Git remote for PR branches", "origin")
  .option("--worktree-root <path>", "Directory for Codex run worktrees")
  .option("--keep-worktree <policy>", "Worktree retention: always, on_failure, or never", "on_failure")
  .action((options: {
    owner: string;
    repo: string;
    checkout: string;
    output: string;
    runnerId: string;
    dispatcherUrl: string;
    pairingToken?: string;
    executor: "echo" | "codex";
    baseBranch: string;
    pushRemote: string;
    worktreeRoot?: string;
    keepWorktree: "always" | "on_failure" | "never";
  }) => {
    try {
      const config = createInitialConfig({
        owner: options.owner,
        repo: options.repo,
        checkoutPath: options.checkout,
        runnerId: options.runnerId,
        dispatcherUrl: options.dispatcherUrl,
        ...(options.pairingToken ? { pairingToken: options.pairingToken } : {}),
        executor: options.executor,
        baseBranch: options.baseBranch,
        pushRemote: options.pushRemote,
        ...(options.worktreeRoot ? { worktreeRoot: options.worktreeRoot } : {}),
        keepWorktree: options.keepWorktree
      });
      writeFileSync(options.output, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`Wrote OpenTag config to ${options.output}`);
    } catch (error) {
      console.error(`Could not create config:\n${formatConfigError(error)}`);
      process.exit(1);
    }
  });

program
  .command("register-runner")
  .description("Register this local daemon with the dispatcher")
  .action(async () => {
    const config = loadConfigOrExit();
    await createDispatcherAdminClient({
      dispatcherUrl: config.dispatcherUrl,
      runnerId: config.runnerId,
      ...(config.pairingToken ? { pairingToken: config.pairingToken } : {})
    }).registerRunner(config.runnerId);
    console.log(`Registered OpenTag runner ${config.runnerId}`);
  });

program
  .command("bind-repos")
  .description("Sync configured repository bindings to the dispatcher")
  .action(async () => {
    const config = loadConfigOrExit();
    const client = createDispatcherAdminClient({
      dispatcherUrl: config.dispatcherUrl,
      runnerId: config.runnerId,
      ...(config.pairingToken ? { pairingToken: config.pairingToken } : {})
    });
    for (const repository of config.repositories) {
      await client.bindRepository({
        provider: repository.provider,
        owner: repository.owner,
        repo: repository.repo,
        checkoutPath: repository.checkoutPath,
        defaultExecutor: repository.defaultExecutor,
        baseBranch: repository.baseBranch,
        pushRemote: repository.pushRemote,
        ...(repository.worktreeRoot ? { worktreeRoot: repository.worktreeRoot } : {}),
        keepWorktree: repository.keepWorktree
      });
      console.log(`Bound ${repository.provider}:${repository.owner}/${repository.repo} to ${repository.checkoutPath}`);
    }
    if (config.repositories.length === 0) {
      console.log("No repositories configured. Set OPENTAG_CONFIG_PATH or OPENTAG_REPO_OWNER/OPENTAG_REPO_NAME/OPENTAG_WORKSPACE_PATH.");
    }
  });

program
  .command("bind-slack-channels")
  .description("Sync configured Slack channel bindings to the dispatcher")
  .action(async () => {
    const config = loadConfigOrExit();
    const client = createDispatcherAdminClient({
      dispatcherUrl: config.dispatcherUrl,
      runnerId: config.runnerId,
      ...(config.pairingToken ? { pairingToken: config.pairingToken } : {})
    });
    for (const binding of config.slackChannels ?? []) {
      await client.bindSlackChannel(binding);
      console.log(`Bound Slack ${binding.teamId}/${binding.channelId} to ${binding.owner}/${binding.repo}`);
    }
    if (!(config.slackChannels?.length ?? 0)) {
      console.log("No Slack channels configured.");
    }
  });

program
  .command("doctor")
  .description("Check dispatcher, bindings, checkouts, and executors")
  .action(async () => {
    const config = loadConfigOrExit();
    const checks = await runDoctor({
      config,
      executors: executors()
    });
    console.log(formatDoctorChecks(checks));
    if (doctorHasFailures(checks)) {
      process.exit(1);
    }
  });

program
  .command("run-once")
  .description("Claim and execute one run if available")
  .action(async () => {
    const config = loadConfigOrExit();
    const didWork = await runOneDaemonIteration({
      runnerId: config.runnerId,
      repositories: config.repositories,
      executors: executors(),
      pullRequestOptions: {
        ...(config.githubToken ? { githubToken: config.githubToken } : {})
      },
      ...(config.heartbeatIntervalMs ? { heartbeatIntervalMs: config.heartbeatIntervalMs } : {}),
      client: createDispatcherClient({
        dispatcherUrl: config.dispatcherUrl,
        runnerId: config.runnerId,
        ...(config.pairingToken ? { pairingToken: config.pairingToken } : {})
      })
    });
    console.log(didWork ? "OpenTag run completed" : "No OpenTag run available");
  });

program
  .command("serve")
  .description("Continuously poll for and execute OpenTag runs")
  .action(async () => {
    const config = loadConfigOrExit();
    await serveDaemon({
      runnerId: config.runnerId,
      repositories: config.repositories,
      executors: executors(),
      ...(config.githubToken ? { pullRequestOptions: { githubToken: config.githubToken } } : {}),
      ...(config.heartbeatIntervalMs ? { heartbeatIntervalMs: config.heartbeatIntervalMs } : {}),
      ...(config.pollIntervalMs ? { pollIntervalMs: config.pollIntervalMs } : {}),
      client: createDispatcherClient({
        dispatcherUrl: config.dispatcherUrl,
        runnerId: config.runnerId,
        ...(config.pairingToken ? { pairingToken: config.pairingToken } : {})
      })
    });
  });

await program.parseAsync(process.argv);
