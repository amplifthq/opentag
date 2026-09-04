import type { CliLanguage } from "../catalogs/languages.js";

export type GitHubSetupInput = {
  projectTargetId: string;
  token?: string;
  owner: string;
  repo: string;
};

export type HermesSetupInput = {
  command?: string;
  profile: string;
};

export type AgentSessionProfileSetupInput = {
  profile?: string;
  profileTemplate?: string;
};

export type OpenTagSetupInput = {
  language: CliLanguage;
  relayUrl: string;
  bootstrapPairingToken?: string;
  projectPath: string;
  executor: string;
  stateDirectory?: string;
  github: GitHubSetupInput;
  hermes?: HermesSetupInput;
  agentSessionProfile?: AgentSessionProfileSetupInput;
};
