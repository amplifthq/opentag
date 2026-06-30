import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { legacyLarkConfigPath, readLegacyLarkCredentials } from "../src/platforms/lark/saved-config.js";
import { createSetupConfig } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function config(): OpenTagCliConfig {
  const projectPath = tempDir();
  return createSetupConfig({
    language: "en",
    platform: "lark",
    projectPath,
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    lark: {
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      botOpenId: "ou_bot",
      setupMethod: "scan",
      bindingMethod: "default_project"
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

  it("does not chmod an existing custom config directory", () => {
    const parent = tempDir();
    chmodSync(parent, 0o755);
    const beforeMode = statSync(parent).mode & 0o777;
    const path = join(parent, "config.json");

    writeCliConfigAtomic(path, config());

    expect(statSync(parent).mode & 0o777).toBe(beforeMode);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses to read config files that expose secrets to group or others", () => {
    const path = join(tempDir(), "config.json");
    writeFileSync(path, `${JSON.stringify(config())}\n`, { mode: 0o600 });
    chmodSync(path, 0o644);

    expect(() => readCliConfig(path)).toThrow(`Fix it with: chmod 600 ${path}`);
  });

  it("refuses to reuse legacy Lark credentials from a non-private file", () => {
    const projectPath = tempDir();
    const path = legacyLarkConfigPath(projectPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ appId: "cli_test", appSecret: "secret_test", domain: "lark" }), { mode: 0o600 });
    chmodSync(path, 0o644);

    expect(() => readLegacyLarkCredentials(projectPath)).toThrow(`Fix it with: chmod 600 ${path}`);
  });

  it("reuses legacy Lark credentials from a private file", () => {
    const projectPath = tempDir();
    const path = legacyLarkConfigPath(projectPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ appId: "cli_test", appSecret: "secret_test", domain: "lark" }), { mode: 0o600 });
    chmodSync(path, 0o600);

    expect(readLegacyLarkCredentials(projectPath)).toMatchObject({
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      source: "legacy_start_lark",
      path
    });
  });

  it("redacts secrets in config output", () => {
    const redacted = redactedCliConfig(config());

    expect(JSON.stringify(redacted)).toContain("[REDACTED]");
    expect(JSON.stringify(redacted)).not.toContain("secret_test");
  });

  it("normalizes Hermes daemon config strings", () => {
    const parsed = parseCliConfig({
      ...config(),
      daemon: {
        ...config().daemon,
        hermes: {
          command: " custom-hermes ",
          profile: " opentag-fixed ",
          profileTemplate: " opentag-{provider}-{owner}-{repo} "
        }
      }
    });

    expect(parsed.daemon.hermes).toEqual({
      command: "custom-hermes",
      profile: "opentag-fixed",
      profileTemplate: "opentag-{provider}-{owner}-{repo}"
    });
  });

  it("rejects whitespace-only Hermes daemon config strings", () => {
    expect(() =>
      parseCliConfig({
        ...config(),
        daemon: {
          ...config().daemon,
          hermes: {
            profileTemplate: "   "
          }
        }
      })
    ).toThrow();
  });

  it("builds a local Project Target and state-backed worktree root during setup", () => {
    const projectPath = tempDir();
    const checkoutPath = realpathSync.native(projectPath);
    const stateDirectory = join(tempDir(), "state");
    const built = createSetupConfig({
      language: "zh-CN",
      platform: "lark",
      projectPath,
      stateDirectory,
      executor: "codex",
      lark: {
        appId: "cli_test",
        appSecret: "secret_test",
        domain: "feishu",
        setupMethod: "manual",
        bindingMethod: "bind_later"
      }
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
    expect(built.platforms.lark?.defaultProjectBinding).toBe(false);
    expect(built.preferences?.language).toBe("zh-CN");
    expect(built.preferences?.lastSetup).toMatchObject({
      platforms: ["lark"],
      executor: "codex",
      larkSetupMethod: "manual",
      bindingMethod: "bind_later"
    });
  });
});
