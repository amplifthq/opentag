import type { LarkDomain } from "@opentag/lark";
import type { AdapterMutationMapping } from "@opentag/core";
import type { CliLanguage } from "../catalogs/languages.js";
import type { PlatformId } from "../catalogs/platforms.js";
import type { SavedLarkCredentials } from "../platforms/lark/saved-config.js";

export type LarkSetupMethod = "saved" | "scan" | "manual";
export type SlackSetupMode = "socket_mode" | "events_api";
export type TelegramSetupMode = "polling" | "webhook";
export type DiscordSetupMode = "gateway" | "webhook";
export type LinearAuthMethod = "api_key" | "oauth_app";

export type BindingMethod = "default_project" | "bind_later";

export type LarkSetupInput = {
  appId: string;
  appSecret: string;
  domain: LarkDomain;
  botOpenId?: string;
  setupMethod: LarkSetupMethod;
  bindingMethod: BindingMethod;
  savedCredentialsSource?: SavedLarkCredentials["source"];
};

export type SlackSetupInput = {
  mode: SlackSetupMode;
  appToken?: string;
  signingSecret?: string;
  botToken: string;
  teamId: string;
  channelId: string;
  appId?: string;
  bindingMethod: BindingMethod;
  port?: number;
};

export type GitHubSetupInput = {
  token: string;
  webhookSecret: string;
  owner: string;
  repo: string;
  webhookPath: string;
  autoCreatePullRequest: boolean;
  port: number;
};

export type GitLabSetupInput = {
  token: string;
  webhookSecret: string;
  projectPathWithNamespace: string;
  baseUrl: string;
  webhookPath: string;
  port: number;
};

export type LinearSetupInput = {
  token?: string;
  auth?: {
    method: "api_key";
  } | {
    method: "oauth_app";
    actor: "app";
    clientId: string;
    clientSecret?: string;
    redirectUri?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: string;
    scopes?: string[];
  } | {
    method: "hosted_oauth_app";
    actor: "app";
    installationId?: string;
    authorizationUrl?: string;
    stateExpiresAt?: string;
    scopes?: string[];
  };
  webhookSecret?: string;
  teamId?: string;
  teamKey?: string;
  graphqlUrl?: string;
  webhookPath: string;
  port: number;
  mappings?: AdapterMutationMapping[];
};

export type TelegramSetupInput = {
  mode: TelegramSetupMode;
  botId: string;
  agentId: string;
  botUsername?: string;
  botToken: string;
  bindingAdminUserIds?: string[];
  secretToken?: string;
  callbackUri?: string;
};

export type DiscordSetupInput = {
  mode: DiscordSetupMode;
  publicKey?: string;
  botToken: string;
  webhookPath?: string;
};

export type HermesSetupInput = {
  command?: string;
};

export type AgentSessionProfileSetupInput = {
  profile?: string;
  profileTemplate?: string;
};

export type OpenTagSetupInput = {
  language: CliLanguage;
  platform: PlatformId;
  projectPath: string;
  executor: string;
  stateDirectory?: string;
  lark?: LarkSetupInput;
  slack?: SlackSetupInput;
  github?: GitHubSetupInput;
  gitlab?: GitLabSetupInput;
  linear?: LinearSetupInput;
  telegram?: TelegramSetupInput;
  discord?: DiscordSetupInput;
  hermes?: HermesSetupInput;
  agentSessionProfile?: AgentSessionProfileSetupInput;
};

export type SetupDefaults = Partial<{
  language: CliLanguage;
  platform: PlatformId;
  projectPath: string;
  executor: string;
  larkSetupMethod: LarkSetupMethod;
  larkDomain: LarkDomain;
  slackMode: SlackSetupMode;
  bindingMethod: BindingMethod;
  slackTeamId: string;
  slackChannelId: string;
  slackPort?: number;
  githubOwner: string;
  githubRepo: string;
  githubPort: number;
  githubWebhookSecret: string;
  githubWebhookPath: string;
  githubAutoCreatePullRequest: boolean;
  gitlabProjectPathWithNamespace: string;
  gitlabBaseUrl: string;
  gitlabPort: number;
  gitlabWebhookSecret: string;
  gitlabWebhookPath: string;
  linearAuth: LinearAuthMethod;
  linearTeamId: string;
  linearTeamKey: string;
  linearPort: number;
  linearWebhookSecret: string;
  linearWebhookPath: string;
  linearGraphqlUrl: string;
  telegramBotId: string;
  telegramMode: TelegramSetupMode;
  telegramBotUsername: string;
  telegramSecretToken: string;
  telegramBindingAdminUserIds: string[];
  telegramCallbackUri: string;
  discordMode: DiscordSetupMode;
  discordWebhookPath: string;
  hermesCommand: string;
  agentProfile: string;
  agentProfileTemplate: string;
  savedLarkCredentials: SavedLarkCredentials;
}>;
