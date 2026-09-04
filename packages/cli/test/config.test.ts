import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseCliConfig,
  readCliConfig,
  redactedCliConfigValue,
  writeCliConfigAtomic,
} from "../src/config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-config-"));
}

function rawConfig() {
  return {
    schemaVersion: 1,
    state: {
      directory: "/tmp/opentag-state",
      databasePath: "/tmp/opentag-state/opentag.db",
      worktreeRoot: "/tmp/opentag-state/worktrees",
    },
    daemon: {
      runnerId: "runner_local",
      relayUrl: "https://relay.example",
      githubToken: "github_secret",
      repositories: [{
        projectTargetId: "target_1",
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/acme-demo",
        defaultExecutor: "codex",
        baseBranch: "main",
        pushRemote: "origin",
        worktreeRoot: "/tmp/opentag-state/worktrees",
        keepWorktree: "on_failure" as const,
      }],
      pollIntervalMs: 5_000,
      heartbeatIntervalMs: 15_000,
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenTag paired-relay CLI config", () => {
  it("accepts paired relay and GitHub Project Target/publication configuration", () => {
    const parsed = parseCliConfig(rawConfig());
    expect(parsed.daemon.relayUrl).toBe("https://relay.example");
    expect(parsed).not.toHaveProperty("runtime");
    expect(parsed.daemon.repositories[0]).toMatchObject({
      projectTargetId: "target_1",
      provider: "github",
      defaultExecutor: "codex",
    });
  });

  it("rejects a repository mapping without its Control Plane Project Target ID", () => {
    const raw = rawConfig() as Record<string, any>;
    delete raw.daemon.repositories[0].projectTargetId;
    expect(() => parseCliConfig(raw)).toThrow();
  });

  it("rejects the removed top-level runtime object instead of migrating it", () => {
    const raw = rawConfig() as Record<string, any>;
    raw.runtime = { mode: "paired_relay", relayUrl: "https://relay.example" };
    expect(() => parseCliConfig(raw)).toThrow();
  });

  it("rejects the removed daemon.dispatcherUrl field", () => {
    const raw = rawConfig() as Record<string, any>;
    raw.daemon.dispatcherUrl = raw.daemon.relayUrl;
    delete raw.daemon.relayUrl;
    expect(() => parseCliConfig(raw)).toThrow();
  });

  it("rejects an insecure relay before resolving config secrets", () => {
    const raw = rawConfig();
    raw.daemon.relayUrl = "http://relay.example";
    raw.daemon.githubToken = {
      kind: "env",
      name: "OPENTAG_MISSING_GITHUB_TOKEN",
    } as never;
    expect(() => parseCliConfig(raw)).toThrow("Hosted relay URL must use HTTPS");
  });

  it("rejects a loopback relay even when it uses HTTPS", () => {
    const raw = rawConfig();
    raw.daemon.relayUrl = "https://127.0.0.1";
    expect(() => parseCliConfig(raw)).toThrow("requires a distinct relay process");
  });

  it("rejects an unsupported platform config", () => {
    const raw = rawConfig() as ReturnType<typeof rawConfig> & {
      platforms?: Record<string, unknown>;
    };
    raw.platforms = { unsupported: {} };
    expect(() => parseCliConfig(raw)).toThrow();
  });

  it("resolves supported SecretRefs while redaction retains only their source", () => {
    vi.stubEnv("OPENTAG_TEST_GITHUB_TOKEN", "resolved_github_secret");
    const raw = rawConfig();
    raw.daemon.githubToken = {
      kind: "env",
      name: "OPENTAG_TEST_GITHUB_TOKEN",
    } as never;
    const parsed = parseCliConfig(raw);
    expect(parsed.daemon.githubToken).toBe("resolved_github_secret");
    const redacted = JSON.stringify(redactedCliConfigValue(raw));
    expect(redacted).toContain("OPENTAG_TEST_GITHUB_TOKEN");
    expect(redacted).not.toContain("resolved_github_secret");
    expect(redacted).not.toContain("github_secret");
  });

  it("rejects unresolved SecretRefs", () => {
    const raw = rawConfig();
    raw.daemon.githubToken = {
      kind: "env",
      name: "OPENTAG_MISSING_GITHUB_TOKEN",
    } as never;
    expect(() => parseCliConfig(raw)).toThrow(
      "Secret env ref OPENTAG_MISSING_GITHUB_TOKEN is not set.",
    );
  });

  it("writes and reads a mode-0600 paired config atomically", () => {
    const directory = tempDir();
    const path = join(directory, "config.json");
    const config = parseCliConfig(rawConfig());
    writeCliConfigAtomic(path, config);
    expect(readCliConfig(path)).toEqual(config);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain('"relayUrl": "https://relay.example"');
    expect(readFileSync(path, "utf8")).not.toContain('"runtime"');
  });

  it("rejects unknown fields instead of retaining compatibility state", () => {
    const raw = rawConfig() as ReturnType<typeof rawConfig> & { legacy?: boolean };
    raw.legacy = true;
    expect(() => parseCliConfig(raw)).toThrow();
  });
});
