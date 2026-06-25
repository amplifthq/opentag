import { afterEach, describe, expect, it } from "vitest";
import {
  createInitialConfig,
  formatConfigError,
  loadConfigFromEnv,
  parseDaemonConfig,
  type OpenTagDaemonConfig
} from "../src/config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("opentagd config", () => {
  it("rejects invalid Claude Code permission modes", () => {
    delete process.env.OPENTAG_CONFIG_PATH;
    process.env.OPENTAG_REPO_OWNER = "acme";
    process.env.OPENTAG_REPO_NAME = "demo";
    process.env.OPENTAG_WORKSPACE_PATH = "/tmp/demo";
    process.env.OPENTAG_CLAUDE_PERMISSION_MODE = "typo";

    expect(() => loadConfigFromEnv()).toThrow("Invalid OPENTAG_CLAUDE_PERMISSION_MODE: typo");
  });

  it("builds an initial daemon config with worktree defaults", () => {
    const config = createInitialConfig({
      owner: "acme",
      repo: "demo",
      checkoutPath: "/tmp/demo"
    });

    expect(config).toMatchObject({
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
      ]
    });
  });

  it("parses JSON config files through the validated schema", () => {
    const parsed = parseDaemonConfig({
      runnerId: "runner_test",
      dispatcherUrl: "http://localhost:3030",
      repositories: [
        {
          owner: "acme",
          repo: "demo",
          checkoutPath: "/tmp/demo",
          defaultExecutor: "codex",
          worktreeRoot: "/tmp/worktrees",
          keepWorktree: "always"
        }
      ]
    } satisfies Partial<OpenTagDaemonConfig>);

    expect(parsed.repositories[0]).toMatchObject({
      provider: "github",
      defaultExecutor: "codex",
      worktreeRoot: "/tmp/worktrees",
      keepWorktree: "always"
    });
  });

  it("formats zod config errors into a readable message", () => {
    const error = (() => {
      try {
        parseDaemonConfig({
          dispatcherUrl: "not-a-url",
          repositories: [{ owner: "acme", repo: "demo", checkoutPath: "" }]
        });
      } catch (caught) {
        return caught;
      }
      return new Error("expected parse to fail");
    })();

    expect(formatConfigError(error)).toContain("dispatcherUrl");
    expect(formatConfigError(error)).toContain("repositories.0.checkoutPath");
  });
});
