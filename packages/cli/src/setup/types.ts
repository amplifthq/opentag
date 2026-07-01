import type { LarkDomain } from "@opentag/lark";
import type { CliLanguage } from "../catalogs/languages.js";
import type { PlatformId } from "../catalogs/platforms.js";
import type { SavedLarkCredentials } from "../platforms/lark/saved-config.js";

export type LarkSetupMethod = "saved" | "scan" | "manual";
export type SlackSetupMode = "socket_mode" | "events_api";

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

export type HermesSetupInput = {
  command?: string;
  profile?: string;
  profileTemplate?: string;
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
  hermesCommand: string;
  hermesProfile: string;
  hermesProfileTemplate: string;
  agentProfile: string;
  agentProfileTemplate: string;
  savedLarkCredentials: SavedLarkCredentials;
}>;
