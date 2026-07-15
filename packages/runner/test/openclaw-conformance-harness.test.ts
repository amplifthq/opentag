import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultMarkersSafeToClean,
  newGatewaySessions,
  parseOpenClawVersion,
  runBoundedCommand,
  resolveConformanceReportPath,
  resolveDefaultWorkspacePath,
  writePrivateReport,
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

  it("bounds external commands that do not exit", () => {
    expect(() =>
      runBoundedCommand(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], 50)
    ).toThrow();
  });

  it("does not authorize cleanup when a default-workspace marker already exists", () => {
    const root = mkdtempSync(join(tmpdir(), "opentag-openclaw-marker-"));
    const marker = join(root, "pre-existing");
    try {
      writeFileSync(marker, "owned by another run\n");
      expect(() => defaultMarkersSafeToClean([marker])).toThrow(/Refusing to overwrite pre-existing marker/u);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces mode 0600 when overwriting an existing evidence report", () => {
    const root = mkdtempSync(join(tmpdir(), "opentag-openclaw-report-"));
    const report = join(root, "report.json");
    try {
      writeFileSync(report, "old\n", { mode: 0o644 });
      chmodSync(report, 0o644);
      writePrivateReport(report, "new\n");
      expect(statSync(report).mode & 0o777).toBe(0o600);
      expect(readFileSync(report, "utf8")).toBe("new\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
