import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { projectTargetRefFromLocalPath } from "@opentag/core";
import {
  defaultStateDirectory,
  type OpenTagCliConfig,
  type PathEnvironment
} from "../config.js";
import type { OpenTagSetupInput } from "./types.js";

function pairingToken(): string {
  return randomBytes(32).toString("hex");
}

function ownerRepoFromGitLabProjectPath(pathWithNamespace: string): { owner: string; repo: string } {
  const lastSlash = pathWithNamespace.lastIndexOf("/");
  if (lastSlash <= 0 || lastSlash === pathWithNamespace.length - 1) {
    throw new Error("GitLab project must use namespace/project.");
  }
  return {
    owner: pathWithNamespace.slice(0, lastSlash),
    repo: pathWithNamespace.slice(lastSlash + 1)
  };
}

export function createSetupConfig(input: OpenTagSetupInput, env: PathEnvironment = process.env): OpenTagCliConfig {
  const checkoutPath = realpathSync.native(input.projectPath);
  const target = projectTargetRefFromLocalPath(checkoutPath);
  const gitlabTarget = input.gitlab ? ownerRepoFromGitLabProjectPath(input.gitlab.projectPathWithNamespace) : undefined;
  const stateDirectory = input.stateDirectory ?? defaultStateDirectory(env);
  const worktreeRoot = join(stateDirectory, "worktrees");
  const databasePath = join(stateDirectory, "opentag.db");
  const repositoryBindings = [
    {
      provider: target.provider,
      owner: target.owner,
      repo: target.repo,
      checkoutPath,
      defaultExecutor: input.executor,
      baseBranch: "main",
      pushRemote: "origin",
      worktreeRoot,
      keepWorktree: "on_failure" as const
    },
    ...(input.github
      ? [
          {
            provider: "github",
            owner: input.github.owner,
            repo: input.github.repo,
            checkoutPath,
            defaultExecutor: input.executor,
            baseBranch: "main",
            pushRemote: "origin",
            worktreeRoot,
            keepWorktree: "on_failure" as const
          }
        ]
      : []),
    ...(input.gitlab && gitlabTarget
      ? [
          {
            provider: "gitlab",
            owner: gitlabTarget.owner,
            repo: gitlabTarget.repo,
            checkoutPath,
            defaultExecutor: input.executor,
            baseBranch: "main",
            pushRemote: "origin",
            worktreeRoot,
            keepWorktree: "on_failure" as const
          }
        ]
      : [])
  ].filter((binding, index, bindings) => {
    return bindings.findIndex((candidate) => candidate.provider === binding.provider && candidate.owner === binding.owner && candidate.repo === binding.repo) === index;
  });

  const channelBindings = [
    ...(input.slack && input.slack.bindingMethod === "default_project"
      ? [
          {
            provider: "slack",
            accountId: input.slack.teamId,
            conversationId: input.slack.channelId,
            repoProvider: target.provider,
            owner: target.owner,
            repo: target.repo
          }
        ]
      : [])
  ];

  return {
    schemaVersion: 1,
    preferences: {
      language: input.language,
      lastSetup: {
        platforms: [input.platform],
        executor: input.executor,
        projectPath: checkoutPath,
        ...(input.lark
          ? {
              larkSetupMethod: input.lark.setupMethod,
              larkDomain: input.lark.domain,
              bindingMethod: input.lark.bindingMethod
            }
          : {}),
        ...(input.slack
          ? {
              bindingMethod: input.slack.bindingMethod,
              slackMode: input.slack.mode,
              slackTeamId: input.slack.teamId,
              slackChannelId: input.slack.channelId,
              ...(input.slack.port ? { slackPort: input.slack.port } : {})
            }
          : {}),
        ...(input.github
          ? {
              githubOwner: input.github.owner,
              githubRepo: input.github.repo,
              githubPort: input.github.port,
              githubAutoCreatePullRequest: input.github.autoCreatePullRequest
            }
          : {}),
        ...(input.gitlab
          ? {
              gitlabProjectPathWithNamespace: input.gitlab.projectPathWithNamespace,
              gitlabBaseUrl: input.gitlab.baseUrl,
              gitlabPort: input.gitlab.port
            }
          : {}),
        ...(input.telegram
          ? {
              telegramMode: input.telegram.mode,
              telegramBotId: input.telegram.botId,
              ...(input.telegram.botUsername ? { telegramBotUsername: input.telegram.botUsername } : {})
            }
          : {}),
        ...(input.discord
          ? {
              discordMode: input.discord.mode,
              ...(input.discord.webhookPath ? { discordWebhookPath: input.discord.webhookPath } : {})
            }
          : {}),
        ...(input.teams
          ? {
              ...(input.teams.tenantId ? { teamsTenantId: input.teams.tenantId } : {}),
              ...(input.teams.webhookPath ? { teamsWebhookPath: input.teams.webhookPath } : {})
            }
          : {})
      }
    },
    state: {
      directory: stateDirectory,
      databasePath,
      worktreeRoot
    },
    runtime: {
      mode: "local"
    },
    daemon: {
      runnerId: "runner_local",
      dispatcherUrl: "http://localhost:3030",
      pairingToken: pairingToken(),
      repositories: repositoryBindings,
      ...(input.hermes
        ? {
            hermes: {
              ...(input.hermes.command ? { command: input.hermes.command } : {}),
              ...(input.hermes.profile ? { profile: input.hermes.profile } : {}),
              ...(input.hermes.profileTemplate ? { profileTemplate: input.hermes.profileTemplate } : {})
            }
          }
        : {}),
      ...(input.agentSessionProfile
        ? {
            agentSessionProfile: {
              ...(input.agentSessionProfile.profile ? { profile: input.agentSessionProfile.profile } : {}),
              ...(input.agentSessionProfile.profileTemplate ? { profileTemplate: input.agentSessionProfile.profileTemplate } : {})
            }
          }
        : {}),
      ...(channelBindings.length > 0 ? { channelBindings } : {}),
      ...(input.github ? { githubToken: input.github.token } : {}),
      ...(input.github ? { preparePullRequestBranch: true } : {}),
      ...(input.github ? { allowAutoCreatePullRequest: input.github.autoCreatePullRequest } : {}),
      pollIntervalMs: 5000,
      heartbeatIntervalMs: 15000
    },
    platforms: {
      ...(input.lark
        ? {
            lark: {
              appId: input.lark.appId,
              appSecret: input.lark.appSecret,
              domain: input.lark.domain,
              defaultProjectBinding: input.lark.bindingMethod === "default_project",
              ...(input.lark.botOpenId ? { botOpenId: input.lark.botOpenId } : {})
            }
          }
        : {}),
      ...(input.slack
        ? {
            slack: {
              mode: input.slack.mode,
              ...(input.slack.appToken ? { appToken: input.slack.appToken } : {}),
              ...(input.slack.signingSecret ? { signingSecret: input.slack.signingSecret } : {}),
              botToken: input.slack.botToken,
              teamId: input.slack.teamId,
              channelId: input.slack.channelId,
              defaultProjectBinding: input.slack.bindingMethod === "default_project",
              ...(input.slack.appId ? { appId: input.slack.appId } : {}),
              ...(input.slack.port ? { port: input.slack.port } : {})
            }
          }
        : {}),
      ...(input.github
        ? {
            github: {
              webhookSecret: input.github.webhookSecret,
              owner: input.github.owner,
              repo: input.github.repo,
              webhookPath: input.github.webhookPath,
              port: input.github.port
            }
          }
        : {}),
      ...(input.gitlab
        ? {
            gitlab: {
              token: input.gitlab.token,
              webhookSecret: input.gitlab.webhookSecret,
              projectPathWithNamespace: input.gitlab.projectPathWithNamespace,
              baseUrl: input.gitlab.baseUrl,
              webhookPath: input.gitlab.webhookPath,
              port: input.gitlab.port
            }
          }
        : {}),
      ...(input.telegram
        ? {
            telegram: {
              mode: input.telegram.mode,
              botId: input.telegram.botId,
              agentId: input.telegram.agentId,
              ...(input.telegram.botUsername ? { botUsername: input.telegram.botUsername } : {}),
              botToken: input.telegram.botToken,
              ...(input.telegram.bindingAdminUserIds ? { bindingAdminUserIds: input.telegram.bindingAdminUserIds } : {}),
              ...(input.telegram.secretToken ? { secretToken: input.telegram.secretToken } : {}),
              ...(input.telegram.callbackUri ? { callbackUri: input.telegram.callbackUri } : {})
            }
          }
        : {}),
      ...(input.discord
        ? {
            discord: {
              mode: input.discord.mode,
              ...(input.discord.publicKey ? { publicKey: input.discord.publicKey } : {}),
              botToken: input.discord.botToken,
              ...(input.discord.webhookPath ? { webhookPath: input.discord.webhookPath } : {})
            }
          }
        : {}),
      ...(input.teams
        ? {
            teams: {
              appId: input.teams.appId,
              appPassword: input.teams.appPassword,
              ...(input.teams.tenantId ? { tenantId: input.teams.tenantId } : {}),
              webhookPath: input.teams.webhookPath ?? "/teams/messages"
            }
          }
        : {})
    }
  };
}
