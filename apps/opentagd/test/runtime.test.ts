import { describe, expect, it } from "vitest";
import type { OpenTagDaemonConfig } from "../src/config.js";
import { createDaemonRuntimeInput, pullRequestOptionsFromConfig, securityFromConfig } from "../src/runtime.js";

const config: OpenTagDaemonConfig = {
  runnerId: "runner_local",
  dispatcherUrl: "http://localhost:3030",
  repositories: [
    {
      provider: "github",
      owner: "acme",
      repo: "demo",
      checkoutPath: "/tmp/demo",
      defaultExecutor: "codex",
      baseBranch: "main",
      pushRemote: "origin",
      keepWorktree: "on_failure"
    }
  ],
  security: {
    mode: "enforce",
    allowedWorkspaceRoot: "/tmp",
    allowUnsafePrompts: false,
    extraSafeEnv: ["OPENTAG_DEBUG"]
  },
  githubToken: "ghs_test",
  allowAutoCreatePullRequest: true,
  pairingToken: "pairing_test",
  pollIntervalMs: 1000,
  heartbeatIntervalMs: 15000
};

describe("opentagd runtime helpers", () => {
  it("normalizes configured runner security policy", () => {
    expect(securityFromConfig(config)).toEqual({
      mode: "enforce",
      allowedWorkspaceRoot: "/tmp",
      allowUnsafePrompts: false,
      extraSafeEnv: ["OPENTAG_DEBUG"]
    });
  });

  it("omits pull request options when GitHub PR creation is not configured", () => {
    const { githubToken: _githubToken, allowAutoCreatePullRequest: _allowAutoCreatePullRequest, ...configWithoutPullRequests } = config;
    expect(pullRequestOptionsFromConfig(configWithoutPullRequests)).toBeUndefined();
  });

  it("creates reusable daemon runtime input from daemon config", () => {
    const input = createDaemonRuntimeInput(config);

    expect(input.runnerId).toBe("runner_local");
    expect(input.repositories).toEqual(config.repositories);
    expect(input.executors.echo.id).toBe("echo");
    expect(input.executors.codex.id).toBe("codex");
    expect(input.executors["claude-code"].id).toBe("claude-code");
    expect(input.security).toEqual(securityFromConfig(config));
    expect(input.pullRequestOptions).toEqual({ githubToken: "ghs_test", allowAutoCreatePullRequest: true });
    expect(input.pollIntervalMs).toBe(1000);
    expect(input.heartbeatIntervalMs).toBe(15000);
    expect(input.client).toEqual({
      claim: expect.any(Function),
      markRunning: expect.any(Function),
      heartbeat: expect.any(Function),
      progress: expect.any(Function),
      complete: expect.any(Function)
    });
  });
});
