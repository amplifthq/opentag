import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSetupConfig } from "../src/setup.js";
import { formatStatus, statusFromConfig } from "../src/status.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

describe("OpenTag CLI status", () => {
  it("reports offline dispatcher without failing the config summary", async () => {
    const config = createSetupConfig({
      projectPath: tempDir(),
      executor: "echo",
      stateDirectory: join(tempDir(), "state"),
      lark: { appId: "cli_test", appSecret: "secret_test", domain: "lark" }
    });

    const summary = await statusFromConfig({
      config,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      })
    });

    expect(summary.dispatcher).toBe("offline");
    expect(formatStatus(summary)).toContain("Dispatcher: offline");
    expect(formatStatus(summary)).toContain("Platforms: lark");
  });
});
