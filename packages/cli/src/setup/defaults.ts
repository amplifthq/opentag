import { existsSync } from "node:fs";
import { defaultConfigPath, readCliConfig, type OpenTagCliConfig } from "../config.js";
import { savedLarkCredentialsFromCliConfig } from "../platforms/lark/saved-config.js";
import type { BindingMethod, SetupDefaults } from "./types.js";

function defaultBindingMethod(config: OpenTagCliConfig): BindingMethod | undefined {
  const lastSetup = config.preferences?.lastSetup;
  if (lastSetup?.bindingMethod) return lastSetup.bindingMethod;
  if (config.platforms.lark?.defaultProjectBinding === false) return "bind_later";
  if (config.platforms.lark) return "default_project";
  if (config.platforms.slack?.defaultProjectBinding === false) return "bind_later";
  if (config.platforms.slack) return "default_project";
  return undefined;
}

export function setupDefaultsFromConfig(config: OpenTagCliConfig): SetupDefaults {
  const repository = config.daemon.repositories[0];
  const lark = config.platforms.lark;
  const slack = config.platforms.slack;
  const github = config.platforms.github;
  const lastSetup = config.preferences?.lastSetup;
  const savedLarkCredentials = savedLarkCredentialsFromCliConfig(config);
  const bindingMethod = defaultBindingMethod(config);

  return {
    ...(config.preferences?.language ? { language: config.preferences.language } : {}),
    ...(lastSetup?.platforms?.[0] ? { platform: lastSetup.platforms[0] } : lark ? { platform: "lark" } : slack ? { platform: "slack" } : github ? { platform: "github" } : {}),
    ...(repository?.checkoutPath ? { projectPath: repository.checkoutPath } : {}),
    ...(repository?.defaultExecutor ? { executor: repository.defaultExecutor } : {}),
    ...(lastSetup?.larkSetupMethod ? { larkSetupMethod: lastSetup.larkSetupMethod } : {}),
    ...(lastSetup?.larkDomain ? { larkDomain: lastSetup.larkDomain } : lark?.domain ? { larkDomain: lark.domain } : {}),
    ...(bindingMethod ? { bindingMethod } : {}),
    ...(lastSetup?.slackMode ? { slackMode: lastSetup.slackMode } : slack ? { slackMode: slack.mode ?? "events_api" } : {}),
    ...(lastSetup?.slackTeamId ? { slackTeamId: lastSetup.slackTeamId } : slack?.teamId ? { slackTeamId: slack.teamId } : {}),
    ...(lastSetup?.slackChannelId ? { slackChannelId: lastSetup.slackChannelId } : slack?.channelId ? { slackChannelId: slack.channelId } : {}),
    ...(lastSetup?.slackPort ? { slackPort: lastSetup.slackPort } : slack?.port ? { slackPort: slack.port } : {}),
    ...(lastSetup?.githubOwner ? { githubOwner: lastSetup.githubOwner } : github?.owner ? { githubOwner: github.owner } : {}),
    ...(lastSetup?.githubRepo ? { githubRepo: lastSetup.githubRepo } : github?.repo ? { githubRepo: github.repo } : {}),
    ...(lastSetup?.githubPort ? { githubPort: lastSetup.githubPort } : github?.port ? { githubPort: github.port } : {}),
    ...(github?.webhookSecret ? { githubWebhookSecret: github.webhookSecret } : {}),
    ...(github?.webhookPath ? { githubWebhookPath: github.webhookPath } : {}),
    ...(lastSetup?.githubAutoCreatePullRequest !== undefined
      ? { githubAutoCreatePullRequest: lastSetup.githubAutoCreatePullRequest }
      : config.daemon.allowAutoCreatePullRequest !== undefined
        ? { githubAutoCreatePullRequest: config.daemon.allowAutoCreatePullRequest }
        : {}),
    ...(savedLarkCredentials ? { savedLarkCredentials } : {})
  };
}

export function loadSetupDefaults(path = defaultConfigPath()): SetupDefaults {
  if (!existsSync(path)) {
    return {};
  }
  return setupDefaultsFromConfig(readCliConfig(path));
}
