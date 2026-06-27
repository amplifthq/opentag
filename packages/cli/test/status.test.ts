import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSetupConfig } from "../src/setup.js";
import { formatStatus, statusFromConfig } from "../src/status.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function config() {
  return createSetupConfig({
    language: "en",
    platform: "lark",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    lark: {
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      setupMethod: "scan",
      bindingMethod: "default_project"
    }
  });
}

function hangingFetch(): typeof fetch {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as unknown as typeof fetch;
}

describe("OpenTag CLI status", () => {
  it("reports offline dispatcher without failing the config summary", async () => {
    const summary = await statusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      })
    });

    expect(summary.dispatcher).toBe("offline");
    expect(formatStatus(summary)).toContain("Dispatcher: offline");
    expect(formatStatus(summary)).toContain("Platforms: lark");
  });

  it("reports offline when dispatcher health hangs until timeout", async () => {
    const fetchImpl = hangingFetch();

    const summary = await statusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      fetchImpl,
      healthTimeoutMs: 5
    });

    expect(summary.dispatcher).toBe("offline");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
