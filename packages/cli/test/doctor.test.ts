import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoctorCheck } from "@opentag/local-runtime";
import {
  appendCliDoctorChecks,
  formatCliDoctorChecks,
  runDoctorCommand
} from "../src/doctor.js";
import { createSetupConfig } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-doctor-"));
}

function pairedConfig(relayUrl = "https://relay.example") {
  const projectPath = tempDir();
  const built = createSetupConfig({
    language: "en",
    relayUrl,
    projectPath,
    executor: "codex",
    stateDirectory: join(tempDir(), "state"),
    github: { projectTargetId: "target_1", token: "github-token", owner: "acme", repo: "demo" }
  });
  return built;
}

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

afterEach(() => {
  consoleLogSpy.mockClear();
  process.exitCode = undefined;
  vi.unstubAllEnvs();
});

describe("OpenTag CLI doctor after platform convergence", () => {
  it("reports Project Target, Runner, ACP, and relay security without exposing secrets", () => {
    const baseChecks: DoctorCheck[] = [{
      status: "ok", name: "relay health", message: "https://relay.example"
    }];
    const formatted = formatCliDoctorChecks(
      appendCliDoctorChecks(pairedConfig(), baseChecks)
    );
    expect(formatted).toContain("OK relay health");
    expect(formatted).toContain("Project Target mapping");
    expect(formatted).toContain("ACP executor and harness");
    expect(formatted).toContain("OK relay transport: HTTPS is enabled.");
    expect(formatted).not.toContain("github-token");
  });

  it("reports paired relay checks without claiming installation certification", () => {
    const checks = appendCliDoctorChecks(pairedConfig(), []);
    expect(checks.some((check) => check.name === "relay transport")).toBe(true);
    expect(formatCliDoctorChecks(checks)).toContain(
      "installation certification: unverified",
    );
  });

  it("fails an insecure public HTTP relay declaration", () => {
    const formatted = formatCliDoctorChecks(
      appendCliDoctorChecks(pairedConfig("http://relay.example"), [])
    );
    expect(formatted).toContain("FAIL relay transport: The paired Control Plane origin must use HTTPS.");
  });

  it("reports an unresolved supported SecretRef without printing credential material", async () => {
    const path = join(tempDir(), "config.json");
    const config = pairedConfig();
    writeFileSync(path, JSON.stringify({
      ...config,
      daemon: {
        ...config.daemon,
        githubToken: { kind: "env", name: "OPENTAG_MISSING_GITHUB_TOKEN" }
      }
    }), { mode: 0o600 });
    await runDoctorCommand({ config: path });
    const output = consoleLogSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(process.exitCode).toBe(1);
    expect(output).toContain("Secret env ref OPENTAG_MISSING_GITHUB_TOKEN is not set.");
    expect(output).not.toContain("github-token");
  });

  it("reports malformed config as a bounded doctor failure", async () => {
    const path = join(tempDir(), "config.json");
    writeFileSync(path, "{ not-json\n", { mode: 0o600 });
    await runDoctorCommand({ config: path });
    const output = consoleLogSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(process.exitCode).toBe(1);
    expect(output).toContain("FAIL credential resolution:");
  });
});
