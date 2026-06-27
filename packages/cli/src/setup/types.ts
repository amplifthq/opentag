import type { LarkDomain } from "@opentag/lark";
import type { CliLanguage } from "../catalogs/languages.js";
import type { ExecutorId } from "../catalogs/executors.js";
import type { PlatformId } from "../catalogs/platforms.js";
import type { SavedLarkCredentials } from "../platforms/lark/saved-config.js";

export type LarkSetupMethod = "saved" | "scan" | "manual";

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
  signingSecret: string;
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
  port?: number;
};

export type OpenTagSetupInput = {
  language: CliLanguage;
  platform: PlatformId;
  projectPath: string;
  executor: ExecutorId;
  stateDirectory?: string;
  lark?: LarkSetupInput;
  slack?: SlackSetupInput;
  github?: GitHubSetupInput;
};

export type SetupDefaults = Partial<{
  language: CliLanguage;
  platform: PlatformId;
  projectPath: string;
  executor: ExecutorId;
  larkSetupMethod: LarkSetupMethod;
  larkDomain: LarkDomain;
  bindingMethod: BindingMethod;
  slackTeamId: string;
  slackChannelId: string;
  githubOwner: string;
  githubRepo: string;
  savedLarkCredentials: SavedLarkCredentials;
}>;
