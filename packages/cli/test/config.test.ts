import { mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultConfigPath,
  defaultStateDirectory,
  parseCliConfig,
  readCliConfig,
  redactedCliConfig,
  writeCliConfigAtomic,
  type OpenTagCliConfig
} from "../src/config.js";
import { createSetupConfig } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function config(): OpenTagCliConfig {
  const projectPath = tempDir();
  return createSetupConfig({
    projectPath,
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    lark: {
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      botOpenId: "ou_bot"
    }
  });
}

describe("OpenTag CLI config", () => {
  it("resolves config and state paths from XDG-style environment", () => {
    const home = tempDir();
    expect(defaultConfigPath({ XDG_CONFIG_HOME: join(home, "xdg-config") }, home)).toBe(
      join(home, "xdg-config", "opentag", "config.json")
    );
    expect(defaultStateDirectory({ XDG_STATE_HOME: join(home, "xdg-state") }, home)).toBe(join(home, "xdg-state", "opentag"));
  });

  it("rejects empty config instead of filling daemon defaults", () => {
    expect(() => parseCliConfig({})).toThrow("schemaVersion");
  });

  it("writes config atomically with private file permissions", () => {
    const path = join(tempDir(), "config.json");
    const expected = config();

    writeCliConfigAtomic(path, expected);

    expect(readCliConfig(path)).toEqual(expected);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("redacts secrets in config output", () => {
    const redacted = redactedCliConfig(config());

    expect(JSON.stringify(redacted)).toContain("[REDACTED]");
    expect(JSON.stringify(redacted)).not.toContain("secret_test");
  });

  it("builds a local Project Target and state-backed worktree root during setup", () => {
    const projectPath = tempDir();
    const checkoutPath = realpathSync.native(projectPath);
    const stateDirectory = join(tempDir(), "state");
    const built = createSetupConfig({
      projectPath,
      stateDirectory,
      executor: "codex",
      lark: { appId: "cli_test", appSecret: "secret_test", domain: "feishu" }
    });

    expect(built.daemon.repositories[0]).toMatchObject({
      provider: "local",
      repo: projectPath.split("/").at(-1),
      checkoutPath,
      defaultExecutor: "codex",
      worktreeRoot: join(stateDirectory, "worktrees")
    });
    expect(built.state.databasePath).toBe(join(stateDirectory, "opentag.db"));
    expect(built.platforms.lark?.domain).toBe("feishu");
  });
});
