import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  formatPruneSourceDeliveriesSummary,
  parsePruneSourceDeliveriesOptions,
  pruneSourceDeliveriesFromConfig
} from "../src/maintenance.js";
import { createSetupConfig } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function config() {
  const built = createSetupConfig({
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
  built.daemon.dispatcherUrl = "https://relay.example";
  built.daemon.runnerToken = "runner_secret";
  return built;
}

describe("OpenTag CLI maintenance", () => {
  it("calls source delivery prune with runner auth and formats bounded-retention metrics", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({
        result: {
          scanned: 5,
          pruned: 3,
          retainedActive: 2
        }
      });
    }) as unknown as typeof fetch;

    const summary = await pruneSourceDeliveriesFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      olderThan: "2026-06-24T00:00:00.000Z",
      limit: 100,
      fetchImpl
    });

    expect(requests[0]?.url).toBe("https://relay.example/v1/source-deliveries/prune");
    expect(requests[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer runner_secret"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      olderThan: "2026-06-24T00:00:00.000Z",
      limit: 100
    });

    const formatted = formatPruneSourceDeliveriesSummary(summary);
    expect(formatted).toContain("Source delivery replay-key prune:");
    expect(formatted).toContain("Dispatcher: https://relay.example");
    expect(formatted).toContain("Scanned: 5");
    expect(formatted).toContain("Pruned: 3");
    expect(formatted).toContain("Retained active: 2");
    expect(formatted).not.toContain("runner_secret");
    expect(formatted).not.toContain("github_webhook_secret");
  });

  it("validates source delivery prune maintenance options before calling the dispatcher", () => {
    expect(parsePruneSourceDeliveriesOptions({ olderThan: "2026-06-24T00:00:00.000Z", limit: "10" })).toEqual({
      olderThan: "2026-06-24T00:00:00.000Z",
      limit: 10
    });
    expect(() => parsePruneSourceDeliveriesOptions({})).toThrow("--older-than is required.");
    expect(() => parsePruneSourceDeliveriesOptions({ olderThan: "not-a-date" })).toThrow("--older-than must be a valid ISO timestamp.");
    expect(() => parsePruneSourceDeliveriesOptions({ olderThan: "2026-06-24T00:00:00.000Z", limit: "0" })).toThrow(
      "--limit must be a positive integer."
    );
  });
});
