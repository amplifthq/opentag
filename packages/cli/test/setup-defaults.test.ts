import { describe, expect, it } from "vitest";
import { parseCliConfig } from "../src/config.js";
import { setupDefaultsFromConfig } from "../src/setup/defaults.js";

function cliConfig(defaultExecutor: string) {
  return parseCliConfig({
    schemaVersion: 1,
    state: {
      directory: "/tmp/opentag-state",
      databasePath: "/tmp/opentag-state/db.sqlite",
      worktreeRoot: "/tmp/opentag-state/worktrees"
    },
    daemon: {
      runnerId: "runner_local",
      dispatcherUrl: "http://localhost:3030",
      pairingToken: "pairing_token",
      pollIntervalMs: 5000,
      heartbeatIntervalMs: 15000,
      repositories: [
        {
          provider: "github",
          owner: "acme",
          repo: "widgets",
          checkoutPath: "/tmp/acme-widgets",
          defaultExecutor,
          baseBranch: "main",
          pushRemote: "origin",
          worktreeRoot: "/tmp/acme-widgets-worktrees",
          keepWorktree: "on_failure"
        }
      ]
    },
    platforms: {}
  });
}

describe("setupDefaultsFromConfig executor", () => {
  it("preserves a custom executor so re-running setup does not silently overwrite it", () => {
    // Regression: a custom executor must survive into the wizard defaults.
    // Dropping it here caused re-running setup to overwrite it with a built-in.
    expect(setupDefaultsFromConfig(cliConfig("custom-runner")).executor).toBe("custom-runner");
  });

  it("preserves a built-in executor", () => {
    expect(setupDefaultsFromConfig(cliConfig("codex")).executor).toBe("codex");
  });

  it("normalizes a stored built-in executor before setup reuses it", () => {
    expect(setupDefaultsFromConfig(cliConfig(" codex ")).executor).toBe("codex");
  });

  it("rejects whitespace-only stored executor ids", () => {
    expect(() => cliConfig("   ")).toThrow();
  });

  it("does not reuse a legacy Hermes profile template as a setup default", () => {
    const config = cliConfig("hermes");
    config.daemon.hermes = {
      command: "custom-hermes",
      profileTemplate: "opentag-{provider}-{conversationId}"
    };

    expect(setupDefaultsFromConfig(config)).toMatchObject({
      executor: "hermes",
      hermesCommand: "custom-hermes"
    });
    expect(setupDefaultsFromConfig(config).hermesProfile).toBeUndefined();
  });

});
