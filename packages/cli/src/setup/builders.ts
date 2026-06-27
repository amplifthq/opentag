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

export function createSetupConfig(input: OpenTagSetupInput, env: PathEnvironment = process.env): OpenTagCliConfig {
  const checkoutPath = realpathSync.native(input.projectPath);
  const target = projectTargetRefFromLocalPath(checkoutPath);
  const stateDirectory = input.stateDirectory ?? defaultStateDirectory(env);
  const worktreeRoot = join(stateDirectory, "worktrees");
  const databasePath = join(stateDirectory, "opentag.db");

  return {
    schemaVersion: 1,
    preferences: {
      language: input.language,
      lastSetup: {
        platforms: [input.platform],
        executor: input.executor,
        projectPath: checkoutPath,
        larkSetupMethod: input.lark.setupMethod,
        larkDomain: input.lark.domain,
        bindingMethod: input.lark.bindingMethod
      }
    },
    state: {
      directory: stateDirectory,
      databasePath,
      worktreeRoot
    },
    daemon: {
      runnerId: "runner_local",
      dispatcherUrl: "http://localhost:3030",
      pairingToken: pairingToken(),
      repositories: [
        {
          provider: target.provider,
          owner: target.owner,
          repo: target.repo,
          checkoutPath,
          defaultExecutor: input.executor,
          baseBranch: "main",
          pushRemote: "origin",
          worktreeRoot,
          keepWorktree: "on_failure"
        }
      ],
      pollIntervalMs: 5000,
      heartbeatIntervalMs: 15000
    },
    platforms: {
      lark: {
        appId: input.lark.appId,
        appSecret: input.lark.appSecret,
        domain: input.lark.domain,
        defaultProjectBinding: input.lark.bindingMethod === "default_project",
        ...(input.lark.botOpenId ? { botOpenId: input.lark.botOpenId } : {})
      }
    }
  };
}
