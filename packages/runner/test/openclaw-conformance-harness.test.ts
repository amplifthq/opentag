import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  newGatewaySessions,
  parseOpenClawVersion,
  resolveConformanceReportPath,
  resolveDefaultWorkspacePath,
  type GatewaySession
} from "../../../scripts/test/openclaw-acp-conformance.js";

describe("OpenClaw ACP conformance harness", () => {
  it("parses an exact CLI version instead of accepting a longer semver prefix", () => {
    expect(parseOpenClawVersion("OpenClaw 2026.7.1 (2d2ddc4)")).toBe("2026.7.1");
    expect(parseOpenClawVersion("OpenClaw 2026.7.10 (future)")).toBe("2026.7.10");
  });

  it("parses the CLI version after leading diagnostic lines", () => {
    expect(parseOpenClawVersion("Warning: profile migrated\nOpenClaw 2026.7.1 (2d2ddc4)")).toBe("2026.7.1");
  });

  it("finds only Gateway sessions that were absent from the previous snapshot", () => {
    const existing: GatewaySession = { key: "agent:main:acp-bridge:existing", status: "done" };
    const added: GatewaySession = { key: "agent:main:acp-bridge:new", status: "done" };
    const previous = new Map([[existing.key, existing]]);
    const current = new Map([
      [existing.key, existing],
      [added.key, added]
    ]);

    expect(newGatewaySessions(previous, current)).toEqual([added]);
  });

  it("resolves evidence reports from the repository root", () => {
    expect(resolveConformanceReportPath(".omx/live-e2e/openclaw-acp.json")).toBe(
      resolve(process.cwd(), ".omx/live-e2e/openclaw-acp.json")
    );
  });

  it("keeps a normalized absolute default workspace path when the directory does not exist yet", () => {
    const missing = join(tmpdir(), `opentag-openclaw-missing-workspace-${process.pid}`);
    expect(resolveDefaultWorkspacePath(missing)).toBe(resolve(missing));
  });
});
