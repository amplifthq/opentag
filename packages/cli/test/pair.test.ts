import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readCliConfig, writeCliConfigAtomic } from "../src/config.js";
import { formatPairRelaySummary, inferRelayProvider, normalizeRelayUrl, runPairCommand } from "../src/pair.js";
import { createSetupConfig } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function githubConfig() {
  return createSetupConfig({
    language: "en",
    platform: "github",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    github: {
      token: "ghp_token",
      webhookSecret: "github_webhook_secret",
      owner: "acme",
      repo: "demo",
      webhookPath: "/github/webhooks",
      autoCreatePullRequest: false,
      port: 3050
    }
  });
}

function okFetch(): typeof fetch {
  return vi.fn(async () => Response.json({ ok: true })) as unknown as typeof fetch;
}

describe("OpenTag CLI pair relay", () => {
  it("normalizes and validates relay URLs", () => {
    expect(normalizeRelayUrl(" https://example.up.railway.app/ ")).toBe("https://example.up.railway.app");
    expect(inferRelayProvider("https://example.up.railway.app")).toBe("railway");
    expect(inferRelayProvider("https://relay.example")).toBe("custom");
    expect(() => normalizeRelayUrl("ftp://relay.example")).toThrow("Relay URL must use http or https.");
    expect(() => normalizeRelayUrl("https://relay.example?token=secret")).toThrow("Relay URL must not include a query string");
    expect(normalizeRelayUrl("http://localhost:8787/")).toBe("http://localhost:8787");
  });

  it("rejects public HTTP relay URLs before health checks", async () => {
    const configPath = join(tempDir(), "config.json");
    writeCliConfigAtomic(configPath, githubConfig());
    const fetchImpl = okFetch();

    await expect(
      runPairCommand(
        { config: configPath, relay: "http://relay.example", register: false },
        {
          fetchImpl
        }
      )
    ).rejects.toThrow("Relay URL must use HTTPS unless it points to localhost for local testing.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("updates config for relay mode without dropping existing runner and project target fields", async () => {
    const configPath = join(tempDir(), "config.json");
    const source = githubConfig();
    writeCliConfigAtomic(configPath, source);
    const fetchImpl = okFetch();
    const output: string[] = [];

    await runPairCommand(
      { config: configPath, relay: "https://example.up.railway.app", register: false },
      {
        fetchImpl,
        logger: {
          log(message) {
            output.push(message);
          },
          warn(message) {
            output.push(message);
          }
        }
      }
    );

    const updated = readCliConfig(configPath);
    expect(updated.runtime).toEqual({
      mode: "relay",
      relayUrl: "https://example.up.railway.app",
      relayProvider: "railway"
    });
    expect(updated.daemon.dispatcherUrl).toBe("https://example.up.railway.app");
    expect(updated.daemon.runnerId).toBe(source.daemon.runnerId);
    expect(updated.daemon.repositories).toEqual(source.daemon.repositories);
    expect(fetchImpl).toHaveBeenCalledWith("https://example.up.railway.app/healthz", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(output.join("\n")).toContain("GitHub webhook URL: https://example.up.railway.app/github/webhooks");
    expect(output.join("\n")).toContain("Registration: skipped");
    expect(output.join("\n")).toContain("Security: only pair with a relay you operate or trust");
  });

  it("registers the runner and configured bindings with the relay by default", async () => {
    const configPath = join(tempDir(), "config.json");
    const source = githubConfig();
    source.daemon.channelBindings = [
      {
        provider: "github",
        accountId: "acme",
        conversationId: "demo",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    ];
    writeCliConfigAtomic(configPath, source);
    const calls: string[] = [];

    await runPairCommand(
      { config: configPath, relay: "https://relay.example" },
      {
        fetchImpl: okFetch(),
        bootstrapClient: {
          async registerRunner(name) {
            calls.push(`runner:${name}`);
          },
          async bindRepository(binding) {
            calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
          },
          async bindChannel(binding) {
            calls.push(`channel:${binding.provider}:${binding.accountId}/${binding.conversationId}`);
          }
        },
        logger: {
          log() {},
          warn() {}
        }
      }
    );

    expect(calls).toEqual([
      "runner:runner_local",
      ...source.daemon.repositories.map((repository) => `repo:${repository.provider}:${repository.owner}/${repository.repo}`),
      "channel:github:acme/demo"
    ]);
  });

  it("fails before writing config when relay health is unavailable", async () => {
    const configPath = join(tempDir(), "config.json");
    const source = githubConfig();
    writeCliConfigAtomic(configPath, source);

    await expect(
      runPairCommand(
        { config: configPath, relay: "https://relay.example", register: false },
        {
          fetchImpl: vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch
        }
      )
    ).rejects.toThrow("Relay health check failed at https://relay.example/healthz.");
    expect(readCliConfig(configPath).daemon.dispatcherUrl).toBe(source.daemon.dispatcherUrl);
  });

  it("formats project targets and next steps", () => {
    const source = githubConfig();
    const checkoutPath = source.daemon.repositories[0]?.checkoutPath;

    const formatted = formatPairRelaySummary({
      configPath: "/tmp/config.json",
      config: source,
      relayUrl: "https://relay.example",
      registered: true
    });

    expect(formatted).toContain("github:acme/demo (hasWorkspacePath=yes)");
    expect(formatted).toContain("opentag service start");
    expect(checkoutPath).toBeTruthy();
    expect(formatted).not.toContain(checkoutPath);
  });
});
