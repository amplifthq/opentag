import { readFileSync } from "node:fs";

export type RepositoryBindingConfig = {
  provider: string;
  owner: string;
  repo: string;
  checkoutPath: string;
  defaultExecutor?: string;
  baseBranch?: string;
  pushRemote?: string;
};

export type SlackChannelBindingConfig = {
  teamId: string;
  channelId: string;
  owner: string;
  repo: string;
};

export type OpenTagDaemonConfig = {
  runnerId: string;
  dispatcherUrl: string;
  repositories: RepositoryBindingConfig[];
  slackChannels?: SlackChannelBindingConfig[];
  githubToken?: string;
  pairingToken?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
};

export function loadConfigFromEnv(): OpenTagDaemonConfig {
  const configPath = process.env.OPENTAG_CONFIG_PATH;
  if (configPath) {
    return JSON.parse(readFileSync(configPath, "utf8")) as OpenTagDaemonConfig;
  }

  const owner = process.env.OPENTAG_REPO_OWNER;
  const repo = process.env.OPENTAG_REPO_NAME;
  const checkoutPath = process.env.OPENTAG_WORKSPACE_PATH;
  const repositories =
    owner && repo && checkoutPath
      ? [
          {
            provider: "github",
            owner,
            repo,
          checkoutPath,
            defaultExecutor: process.env.OPENTAG_DEFAULT_EXECUTOR ?? "echo",
            baseBranch: process.env.OPENTAG_BASE_BRANCH ?? "main",
            pushRemote: process.env.OPENTAG_PUSH_REMOTE ?? "origin"
          }
        ]
      : [];

  const config: OpenTagDaemonConfig = {
    runnerId: process.env.OPENTAG_RUNNER_ID ?? "runner_local",
    dispatcherUrl: process.env.OPENTAG_DISPATCHER_URL ?? "http://localhost:3030",
    repositories,
    ...(process.env.OPENTAG_SLACK_TEAM_ID && process.env.OPENTAG_SLACK_CHANNEL_ID && owner && repo
      ? {
          slackChannels: [
            {
              teamId: process.env.OPENTAG_SLACK_TEAM_ID,
              channelId: process.env.OPENTAG_SLACK_CHANNEL_ID,
              owner,
              repo
            }
          ]
        }
      : {}),
    ...(process.env.OPENTAG_GITHUB_TOKEN ? { githubToken: process.env.OPENTAG_GITHUB_TOKEN } : {}),
    ...(process.env.OPENTAG_PAIRING_TOKEN ? { pairingToken: process.env.OPENTAG_PAIRING_TOKEN } : {}),
    ...(process.env.OPENTAG_POLL_INTERVAL_MS ? { pollIntervalMs: Number(process.env.OPENTAG_POLL_INTERVAL_MS) } : {}),
    ...(process.env.OPENTAG_HEARTBEAT_INTERVAL_MS ? { heartbeatIntervalMs: Number(process.env.OPENTAG_HEARTBEAT_INTERVAL_MS) } : {})
  };
  return config;
}
