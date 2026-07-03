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
  if (config.platforms.discord?.defaultProjectBinding === false) return "bind_later";
  if (config.platforms.discord) return "default_project";
  return undefined;
}

export function setupDefaultsFromConfig(config: OpenTagCliConfig): SetupDefaults {
  const repository = config.daemon.repositories[0];
  const lark = config.platforms.lark;
  const slack = config.platforms.slack;
  const github = config.platforms.github;
  const gitlab = config.platforms.gitlab;
  const discord = config.platforms.discord;
  const hermes = config.daemon.hermes;
  const agentSessionProfile = config.daemon.agentSessionProfile;
  const lastSetup = config.preferences?.lastSetup;
  const savedLarkCredentials = savedLarkCredentialsFromCliConfig(config);
  const bindingMethod = defaultBindingMethod(config);

  return {
    ...(config.preferences?.language ? { language: config.preferences.language } : {}),
    ...(lastSetup?.platforms?.[0]
      ? { platform: lastSetup.platforms[0] }
      : lark
        ? { platform: "lark" }
        : slack
          ? { platform: "slack" }
          : github
            ? { platform: "github" }
            : gitlab
              ? { platform: "gitlab" }
              : discord
                ? { platform: "discord" }
                : {}),
    ...(repository?.checkoutPath ? { projectPath: repository.checkoutPath } : {}),
    ...(repository?.defaultExecutor ? { executor: repository.defaultExecutor } : {}),
    ...(hermes?.command ? { hermesCommand: hermes.command } : {}),
    ...(hermes?.profile ? { hermesProfile: hermes.profile } : {}),
    ...(hermes?.profileTemplate ? { hermesProfileTemplate: hermes.profileTemplate } : {}),
    ...(agentSessionProfile?.profile ? { agentProfile: agentSessionProfile.profile } : {}),
    ...(agentSessionProfile?.profileTemplate ? { agentProfileTemplate: agentSessionProfile.profileTemplate } : {}),
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
    ...(lastSetup?.gitlabProjectPathWithNamespace
      ? { gitlabProjectPathWithNamespace: lastSetup.gitlabProjectPathWithNamespace }
      : gitlab?.projectPathWithNamespace
        ? { gitlabProjectPathWithNamespace: gitlab.projectPathWithNamespace }
        : {}),
    ...(lastSetup?.gitlabBaseUrl ? { gitlabBaseUrl: lastSetup.gitlabBaseUrl } : gitlab?.baseUrl ? { gitlabBaseUrl: gitlab.baseUrl } : {}),
    ...(lastSetup?.gitlabPort ? { gitlabPort: lastSetup.gitlabPort } : gitlab?.port ? { gitlabPort: gitlab.port } : {}),
    ...(gitlab?.webhookSecret ? { gitlabWebhookSecret: gitlab.webhookSecret } : {}),
    ...(gitlab?.webhookPath ? { gitlabWebhookPath: gitlab.webhookPath } : {}),
    ...(lastSetup?.discordApplicationId
      ? { discordApplicationId: lastSetup.discordApplicationId }
      : discord?.applicationId
        ? { discordApplicationId: discord.applicationId }
        : {}),
    ...(lastSetup?.discordChannelId
      ? { discordChannelId: lastSetup.discordChannelId }
      : discord?.channelId
        ? { discordChannelId: discord.channelId }
        : {}),
    ...(discord?.publicKey ? { discordPublicKey: discord.publicKey } : {}),
    ...(discord?.webhookPath ? { discordWebhookPath: discord.webhookPath } : {}),
    ...(savedLarkCredentials ? { savedLarkCredentials } : {})
  };
}

export function loadSetupDefaults(path = defaultConfigPath()): SetupDefaults {
  if (!existsSync(path)) {
    return {};
  }
  return setupDefaultsFromConfig(readCliConfig(path));
}
