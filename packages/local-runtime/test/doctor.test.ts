import { createHash } from "node:crypto";
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
  capability: {
    id: "codex",
    invocation: "spawn",
    supportsProfile: false,
    supportsStreaming: false,
    supportsCancel: false,
    supportsHookCompletion: false,
    progressEvents: "audit",
    approvalMode: "opentag_policy",
    contextAccess: ["context_packet", "context_pointers", "workspace"],
    promptAssembly: "executor_adapter",
    writeAccess: "workspace",
    conversationAccess: "request",
    promptMutation: "none",
    rawContextAccess: false,
    writeActionAccess: "none",
    workspaceIsolation: "worktree",
    requiredSecrets: [],
    completionSignals: [
      {
        type: "process_exit",
        required: true,
        description: "Codex exits after producing a result."
      }
    ]
  },
  async canRun() {
    return { ready: true };
  },
  async run() {
    throw new Error("not used in doctor tests");
  },
  async cancel() {}
};

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function runCodexDoctor(
  codexConfig: string,
  configOverrides: Partial<OpenTagDaemonConfig> = {},
  options: { executors?: Record<string, ExecutorAdapter>; env?: Record<string, string | undefined> } = {}
) {
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
      executors: options.executors ?? { codex: codexExecutor },
      commandRunner,
      codexConfigPath,
      ...(options.env ? { env: options.env } : {}),
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
    expect(formatDoctorChecks(checks)).toContain("WARN hook ingest auth: No runner-scoped dispatcher token is configured");
    expect(formatDoctorChecks(checks)).toContain("OK   codex capability: invocation=spawn, profile=no");
    expect(formatDoctorChecks(checks)).toContain("progress=audit, approval=opentag_policy");
    expect(formatDoctorChecks(checks)).toContain("context=context_packet,context_pointers,workspace");
    expect(formatDoctorChecks(checks)).toContain("prompt=executor_adapter, write=workspace");
    expect(formatDoctorChecks(checks)).toContain("conversation=request, prompt_mutation=none, raw_context=no, write_actions=none");
    expect(formatDoctorChecks(checks)).toContain("OK   github:acme/demo checkout: Workspace path configured (hasWorkspacePath=yes).");
    expect(formatDoctorChecks(checks)).not.toContain("opentag-local-runtime-doctor-");
  });

  it("checks executor required env secrets without printing secret values", async () => {
    const secretExecutor: ExecutorAdapter = {
      ...codexExecutor,
      capability: {
        ...codexExecutor.capability!,
        requiredSecrets: [
          {
            id: "agent_token",
            label: "Agent token",
            required: true,
            env: "AGENT_TOKEN",
            description: "Needed for the external runtime."
          }
        ]
      }
    };

    const missing = await runCodexDoctor('service_tier = "fast"\n', {}, { executors: { codex: secretExecutor }, env: {} });
    expect(doctorHasFailures(missing)).toBe(true);
    expect(formatDoctorChecks(missing)).toContain(
      "FAIL codex secret agent_token: Agent token is required but env AGENT_TOKEN is not configured. Needed for the external runtime."
    );

    const configured = await runCodexDoctor(
      'service_tier = "fast"\n',
      {},
      { executors: { codex: secretExecutor }, env: { AGENT_TOKEN: "super-secret-value" } }
    );
    const formatted = formatDoctorChecks(configured);
    expect(doctorHasFailures(configured)).toBe(false);
    expect(formatted).toContain("OK   codex secret agent_token: Agent token configured via env AGENT_TOKEN (required).");
    expect(formatted).not.toContain("super-secret-value");
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

  it("reports legacy pairing-token fallback for hook ingest", async () => {
    const checks = await runCodexDoctor('service_tier = "fast"\n', {
      pairingToken: "pairing_token"
    });

    expect(formatDoctorChecks(checks)).toContain(
      "OK   hook ingest auth: Legacy daemon pairing token is configured for runner calls and local hook ingest"
    );
  });

  it("reports runner-scoped auth when a separate runner token protects hook ingest", async () => {
    const checks = await runCodexDoctor('service_tier = "fast"\n', {
      pairingToken: "pairing_token",
      runnerToken: "runner_token"
    });

    expect(formatDoctorChecks(checks)).toContain(
      "OK   hook ingest auth: Runner-scoped dispatcher token is configured separately from the pairing token"
    );
  });

  it("reports runner token rotation and revocation readiness", async () => {
    const checks = await runCodexDoctor('service_tier = "fast"\n', {
      pairingToken: "pairing_token",
      runnerToken: "runner_token",
      runnerTokens: ["runner_old"],
      revokedRunnerTokenFingerprints: [tokenFingerprint("runner_older")]
    });

    const formatted = formatDoctorChecks(checks);
    expect(formatted).toContain("OK   runner token rotation: 1 additional runner token(s) configured for the rotation window.");
    expect(formatted).toContain("OK   runner token revocation: 1 revoked runner token fingerprint(s) configured");
  });

  it("fails when the current runner token has been revoked", async () => {
    const checks = await runCodexDoctor('service_tier = "fast"\n', {
      pairingToken: "pairing_token",
      runnerToken: "runner_token",
      revokedRunnerTokenFingerprints: [tokenFingerprint("runner_token")]
    });

    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatDoctorChecks(checks)).toContain("FAIL runner token revocation: Current daemon.runnerToken fingerprint is revoked");
  });

  it("fails when a configured rotation runner token has been revoked", async () => {
    const checks = await runCodexDoctor('service_tier = "fast"\n', {
      pairingToken: "pairing_token",
      runnerToken: "runner_token",
      runnerTokens: ["runner_old"],
      revokedRunnerTokenFingerprints: [tokenFingerprint("runner_old")]
    });

    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatDoctorChecks(checks)).toContain("FAIL runner token revocation: 1 daemon.runnerTokens fingerprint(s) are revoked");
  });
});
