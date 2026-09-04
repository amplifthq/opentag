import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  defaultStateDirectory,
  type OpenTagCliConfig,
  type PathEnvironment
} from "../config.js";
import type { OpenTagSetupInput } from "./types.js";

export function createSetupConfig(input: OpenTagSetupInput, env: PathEnvironment = process.env): OpenTagCliConfig {
  const checkoutPath = realpathSync.native(input.projectPath);
  const stateDirectory = input.stateDirectory ?? defaultStateDirectory(env);
  const worktreeRoot = join(stateDirectory, "worktrees");
  const scratchRoot = join(stateDirectory, "scratch");
  const databasePath = join(stateDirectory, "opentag.db");
  const repositoryBindings = [{
    projectTargetId: input.github.projectTargetId,
    provider: "github",
    owner: input.github.owner,
    repo: input.github.repo,
    checkoutPath,
    defaultExecutor: input.executor,
    baseBranch: "main",
    pushRemote: "origin",
    worktreeRoot,
    keepWorktree: "on_failure" as const
  }];

  return {
    schemaVersion: 1,
    preferences: {
      language: input.language
    },
    state: {
      directory: stateDirectory,
      databasePath,
      worktreeRoot
    },
    daemon: {
      runnerId: "runner_local",
      relayUrl: input.relayUrl,
      repositories: repositoryBindings,
      agents: {},
      scratchRoot,
      keepScratch: "on_failure",
      approvalMode: "auto",
      ...(input.hermes
        ? {
            hermes: {
              ...(input.hermes.command ? { command: input.hermes.command } : {}),
              profile: input.hermes.profile
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
      ...(input.github.token ? { githubToken: input.github.token } : {}),
      pollIntervalMs: 5000,
      heartbeatIntervalMs: 15000
    }
  };
}
