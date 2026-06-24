#!/usr/bin/env node
import { createCodexExecutor, createEchoExecutor } from "@opentag/runner";
import { Command } from "commander";
import { createDispatcherAdminClient, createDispatcherClient } from "./client.js";
import { loadConfigFromEnv } from "./config.js";
import { runOneDaemonIteration, serveDaemon } from "./daemon.js";

const program = new Command();

program
  .name("opentagd")
  .description("OpenTag local daemon");

program
  .command("register-runner")
  .description("Register this local daemon with the dispatcher")
  .action(async () => {
    const config = loadConfigFromEnv();
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
    const config = loadConfigFromEnv();
    const client = createDispatcherAdminClient({
      dispatcherUrl: config.dispatcherUrl,
      runnerId: config.runnerId,
      ...(config.pairingToken ? { pairingToken: config.pairingToken } : {})
    });
    for (const repository of config.repositories) {
      await client.bindRepository(repository);
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
    const config = loadConfigFromEnv();
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
  .command("run-once")
  .description("Claim and execute one run if available")
  .action(async () => {
    const config = loadConfigFromEnv();
    const didWork = await runOneDaemonIteration({
      runnerId: config.runnerId,
      repositories: config.repositories,
      executors: {
        echo: createEchoExecutor(),
        codex: createCodexExecutor()
      },
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
    const config = loadConfigFromEnv();
    await serveDaemon({
      runnerId: config.runnerId,
      repositories: config.repositories,
      executors: {
        echo: createEchoExecutor(),
        codex: createCodexExecutor()
      },
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
