import { afterEach, describe, expect, it } from "vitest";
import { createInitialConfig, formatConfigError, loadConfigFromEnv, parseDaemonConfig } from "../src/config.js";

const envKeys = [
  "OPENTAG_CONFIG_PATH",
  "OPENTAG_REPO_OWNER",
  "OPENTAG_REPO_NAME",
  "OPENTAG_WORKSPACE_PATH",
  "OPENTAG_DEFAULT_EXECUTOR",
  "OPENTAG_BASE_BRANCH",
  "OPENTAG_PUSH_REMOTE",
  "OPENTAG_WORKTREE_ROOT",
  "OPENTAG_KEEP_WORKTREE",
  "OPENTAG_RUNNER_ID",
  "OPENTAG_DISPATCHER_URL",
  "OPENTAG_POLL_INTERVAL_MS",
  "OPENTAG_HEARTBEAT_INTERVAL_MS"
];

describe("opentagd config", () => {
  afterEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  it("creates a minimal init config with validated defaults", () => {
    expect(
      createInitialConfig({
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo"
      })
    ).toEqual({
      runnerId: "runner_local",
      dispatcherUrl: "http://localhost:3030",
      repositories: [
        {
          provider: "github",
          owner: "acme",
          repo: "demo",
          checkoutPath: "/tmp/demo",
          defaultExecutor: "echo",
          baseBranch: "main",
          pushRemote: "origin",
          keepWorktree: "on_failure"
        }
      ],
      pollIntervalMs: 5000,
      heartbeatIntervalMs: 15000
    });
  });

  it("reports invalid config fields with readable paths", () => {
    expect(() =>
      parseDaemonConfig({
        dispatcherUrl: "not a url",
        repositories: [{ owner: "", repo: "demo", checkoutPath: "/tmp/demo", defaultExecutor: "nope" }],
        pollIntervalMs: Number.NaN
      })
    ).toThrow();

    try {
      parseDaemonConfig({
        dispatcherUrl: "not a url",
        repositories: [{ owner: "", repo: "demo", checkoutPath: "/tmp/demo", defaultExecutor: "nope" }],
        pollIntervalMs: Number.NaN
      });
    } catch (error) {
      expect(formatConfigError(error)).toContain("dispatcherUrl:");
      expect(formatConfigError(error)).toContain("repositories.0.owner:");
      expect(formatConfigError(error)).toContain("repositories.0.defaultExecutor:");
      expect(formatConfigError(error)).toContain("pollIntervalMs:");
    }
  });

  it("validates env-derived numeric and worktree values", () => {
    process.env.OPENTAG_REPO_OWNER = "acme";
    process.env.OPENTAG_REPO_NAME = "demo";
    process.env.OPENTAG_WORKSPACE_PATH = "/tmp/demo";
    process.env.OPENTAG_DEFAULT_EXECUTOR = "codex";
    process.env.OPENTAG_WORKTREE_ROOT = "/tmp/opentag-worktrees";
    process.env.OPENTAG_KEEP_WORKTREE = "never";
    process.env.OPENTAG_POLL_INTERVAL_MS = "fast";

    expect(() => loadConfigFromEnv()).toThrow();
    try {
      loadConfigFromEnv();
    } catch (error) {
      expect(formatConfigError(error)).toContain("pollIntervalMs:");
    }

    process.env.OPENTAG_POLL_INTERVAL_MS = "1000";
    expect(loadConfigFromEnv().repositories[0]).toMatchObject({
      defaultExecutor: "codex",
      worktreeRoot: "/tmp/opentag-worktrees",
      keepWorktree: "never"
    });
  });
});
