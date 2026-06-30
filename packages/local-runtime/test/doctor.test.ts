import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandRunner, ExecutorAdapter } from "@opentag/runner";
import type { OpenTagDaemonConfig } from "../src/config.js";
import { doctorHasFailures, formatDoctorChecks, runDoctor } from "../src/doctor.js";

const commandRunner: CommandRunner = {
  async run(command, args) {
    if (command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree") {
      return { exitCode: 0, stdout: "true\n", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
  }
};

const codexExecutor: ExecutorAdapter = {
  id: "codex",
  displayName: "Codex Executor",
  async canRun() {
    return { ready: true };
  },
  async run() {
    throw new Error("not used in doctor tests");
  },
  async cancel() {}
};

async function runCodexDoctor(codexConfig: string, configOverrides: Partial<OpenTagDaemonConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), "opentag-local-runtime-doctor-"));
  const checkoutPath = join(root, "demo");
  const codexConfigPath = join(root, "codex-config.toml");
  mkdirSync(checkoutPath, { recursive: true });
  writeFileSync(join(checkoutPath, ".git"), "gitdir: /tmp/fake-git\n");
  writeFileSync(codexConfigPath, codexConfig);

  try {
    return await runDoctor({
      config: {
        runnerId: "runner_local",
        dispatcherUrl: "http://dispatcher.test",
        repositories: [
          {
            provider: "github",
            owner: "acme",
            repo: "demo",
            checkoutPath,
            defaultExecutor: "codex",
            baseBranch: "main",
            pushRemote: "origin",
            keepWorktree: "on_failure"
          }
        ],
        githubToken: "ghs_test",
        pollIntervalMs: 5000,
        heartbeatIntervalMs: 15000,
        ...configOverrides
      },
      executors: { codex: codexExecutor },
      commandRunner,
      codexConfigPath,
      fetchImpl: async (url) => {
        const stringUrl = String(url);
        if (stringUrl.endsWith("/healthz")) {
          return Response.json({ ok: true });
        }
        if (stringUrl.endsWith("/v1/runners/runner_local")) {
          return Response.json({
            runner: { runnerId: "runner_local", name: "Local Runner", createdAt: "2026-06-24T00:00:00.000Z" }
          });
        }
        if (stringUrl.endsWith("/v1/repo-bindings/github/acme/demo")) {
          return Response.json({
            binding: {
              provider: "github",
              owner: "acme",
              repo: "demo",
              runnerId: "runner_local",
              workspacePath: checkoutPath,
              defaultExecutor: "codex"
            }
          });
        }
        return new Response("not found", { status: 404 });
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("local-runtime doctor", () => {
  it("passes when the Codex service tier is supported", async () => {
    const checks = await runCodexDoctor('service_tier = "fast" # use the low-latency tier\n');

    expect(doctorHasFailures(checks)).toBe(false);
    expect(formatDoctorChecks(checks)).toContain("OK   Codex config: service_tier=fast");
  });

  it("fails when the Codex service tier is a known deprecated value", async () => {
    const checks = await runCodexDoctor("service_tier = 'default' # old setting\n");

    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatDoctorChecks(checks)).toContain("FAIL Codex config: Deprecated service_tier 'default'");
  });

  it("passes when the Codex service tier is priority", async () => {
    const checks = await runCodexDoctor('service_tier = "priority"\n');

    expect(doctorHasFailures(checks)).toBe(false);
    expect(formatDoctorChecks(checks)).toContain("OK   Codex config: service_tier=priority");
  });

  it("passes when the Codex service tier is a catalog-provided id", async () => {
    const checks = await runCodexDoctor('service_tier = "acme-enterprise-tier"\n');

    expect(doctorHasFailures(checks)).toBe(false);
    expect(formatDoctorChecks(checks)).toContain("OK   Codex config: service_tier=acme-enterprise-tier");
  });

  it("warns when direct GitHub apply is explicitly disabled", async () => {
    const checks = await runCodexDoctor('service_tier = "fast"\n', {
      preparePullRequestBranch: true,
      githubApplyToken: null
    });

    expect(formatDoctorChecks(checks)).toContain(
      "WARN GitHub PR actions: Run branches can be pushed, but a GitHub apply token is required for direct `apply 1` PR creation"
    );
  });
});
