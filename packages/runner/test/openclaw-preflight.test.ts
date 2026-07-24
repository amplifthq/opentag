import { describe, expect, it, vi } from "vitest";
import {
  checkOpenClawCompatibility,
  type OpenClawCommandResult
} from "../src/openclaw-preflight.js";
import * as runnerPublicApi from "../src/index.js";

function result(stdout: string, exitCode = 0, stderr = ""): OpenClawCommandResult {
  return { exitCode, stdout, stderr };
}

describe("OpenClaw compatibility preflight", () => {
  it("keeps the OpenClaw compatibility helpers out of the public runner API", () => {
    expect(runnerPublicApi).not.toHaveProperty("checkOpenClawCompatibility");
    expect(runnerPublicApi).not.toHaveProperty("createOpenClawPreflight");
    expect(runnerPublicApi).not.toHaveProperty("parseOpenClawCliVersion");
  });

  it("rejects an installed CLI older than the configured profile authority before querying Gateway", async () => {
    const run = vi.fn(async () => result("OpenClaw 2026.7.1 (2d2ddc4)\n"));

    await expect(checkOpenClawCompatibility({
      command: "openclaw",
      profile: "opentag",
      expectedVersion: "2026.7.2",
      run
    })).resolves.toEqual({
      ready: false,
      reason: expect.stringMatching(/CLI 2026\.7\.1.*expected 2026\.7\.2.*upgrade/iu)
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects a profile or Gateway that the selected CLI cannot inspect without rewriting it", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(result("OpenClaw 2026.7.1 (2d2ddc4)\n"))
      .mockResolvedValueOnce(result("", 1, "Profile was written by a newer OpenClaw"));

    const compatibility = await checkOpenClawCompatibility({
      command: "openclaw",
      profile: "opentag",
      gatewayUrl: "ws://127.0.0.1:19093",
      run
    });

    expect(compatibility).toEqual({
      ready: false,
      reason: expect.stringMatching(/profile 'opentag'.*upgrade.*compatible profile/iu)
    });
    expect(compatibility.reason).not.toContain("Profile was written by a newer OpenClaw");
    expect(run).toHaveBeenNthCalledWith(2, "openclaw", [
      "--profile", "opentag", "gateway", "status", "--json", "--url", "ws://127.0.0.1:19093"
    ], 15_000);
  });

  it("rejects CLI and Gateway version skew and accepts an exact compatible pair", async () => {
    const mismatchRun = vi
      .fn()
      .mockResolvedValueOnce(result("OpenClaw 2026.7.2 (new)\n"))
      .mockResolvedValueOnce(result(JSON.stringify({ rpc: { ok: true, version: "2026.7.1" } })));

    await expect(checkOpenClawCompatibility({
      command: "openclaw",
      profile: "opentag",
      expectedVersion: "2026.7.2",
      run: mismatchRun
    })).resolves.toEqual({
      ready: false,
      reason: expect.stringMatching(/Gateway 2026\.7\.1.*CLI 2026\.7\.2/iu)
    });

    const compatibleRun = vi
      .fn()
      .mockResolvedValueOnce(result("OpenClaw 2026.7.2 (new)\n"))
      .mockResolvedValueOnce(result(JSON.stringify({ rpc: { ok: true, server: { version: "2026.7.2" } } })));
    await expect(checkOpenClawCompatibility({
      command: "openclaw",
      profile: "opentag",
      expectedVersion: "2026.7.2",
      run: compatibleRun
    })).resolves.toEqual({ ready: true });
  });
});
