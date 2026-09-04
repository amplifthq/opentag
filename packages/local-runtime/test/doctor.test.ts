import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAcpExecutor, createBuiltInAcpExecutors, type CommandRunner, type ExecutorAdapter } from "@opentag/runner";
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
  ...createBuiltInAcpExecutors().codex,
  async canRun() {
    return { ready: true };
  },
  async run() {
    throw new Error("not used in doctor tests");
  },
  async cancel() {}
};

function withUnverifiedWorkspaceCapability(executor: ExecutorAdapter): ExecutorAdapter {
  if (!executor.capability) throw new Error("Expected executor capability in doctor test fixture.");
  return {
    ...executor,
    capability: {
      ...executor.capability,
      writeAccess: "external",
      workspaceIsolation: "external",
      workspaceCwdConformance: "unverified"
    }
  };
}

const hostedRegistration = {
  schemaVersion: 1 as const,
  protocolVersion: "1.0" as const,
  organizationId: "org_1",
  runnerId: "runner_local",
  registrationGeneration: 1,
  credentialGeneration: 1,
  credentialId: "credential_runtime_1",
  credentialPurpose: "runtime" as const,
  createdAt: "2026-08-08T00:00:00.000Z"
};

function responseAt(url: string, response: Response): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function hostedControl(state: "credential_staged" | "paired", runnerId = "runner_local") {
  return {
    kind: "hosted_control_v1" as const,
    state,
    operationId: "operation_pair_1",
    registration: { ...hostedRegistration, runnerId }
  };
}

async function runCodexDoctor(
  codexConfig: string,
  configOverrides: Partial<OpenTagDaemonConfig> = {},
  options: {
    executors?: Record<string, ExecutorAdapter>;
    env?: Record<string, string | undefined>;
    repositoryDefaultExecutor?: string;
    requestObserver?: (url: string, init?: RequestInit) => void;
    repositoryFree?: boolean;
    controlContextResponse?: () => Response;
  } = {}
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
        relayUrl: "https://control.example",
        repositories: options.repositoryFree
          ? []
          : [
              {
                projectTargetId: "target_1",
                provider: "github",
                owner: "acme",
                repo: "demo",
                checkoutPath,
                defaultExecutor: options.repositoryDefaultExecutor ?? "codex",
                baseBranch: "main",
                pushRemote: "origin",
                keepWorktree: "on_failure"
              }
            ],
        githubToken: "ghs_test",
        runnerToken: "runtime_paired_secret",
        controlRegistration: hostedControl("paired"),
        pollIntervalMs: 5000,
        heartbeatIntervalMs: 15000,
        ...configOverrides
      },
      executors: options.executors ?? { codex: codexExecutor },
      commandRunner,
      codexConfigPath,
      ...(options.env ? { env: options.env } : {}),
      fetchImpl: async (url, init) => {
        const stringUrl = String(url);
        options.requestObserver?.(stringUrl, init);
        if (stringUrl.endsWith("/healthz")) {
          return Response.json({ ok: true });
        }
        if (stringUrl.endsWith("/v1/runners/runner_local/control-context")) {
          if (options.controlContextResponse) return responseAt(stringUrl, options.controlContextResponse());
          return responseAt(stringUrl, Response.json({
            schemaVersion: 1,
            protocolVersion: "1.0",
            contextKind: "runner_control",
            organizationId: "org_1",
            runnerId: "runner_local",
            credentialId: "credential_runtime_1",
            registrationGeneration: 1,
            credentialGeneration: 1,
            capabilities: [],
            targets: options.repositoryFree ? [] : [{
              projectTargetId: "target_1",
              bindingDigest: `sha256:${"a".repeat(64)}`,
              provider: "github",
              owner: "acme",
              repo: "demo",
              defaultExecutor: options.repositoryDefaultExecutor ?? "codex",
              defaultBranch: "main"
            }],
            observedAt: "2026-08-08T00:00:00.000Z"
          }));
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
    expect(formatDoctorChecks(checks)).toContain("OK   paired runner auth: Hosted Control V1 paired runtime credential is configured");
    expect(formatDoctorChecks(checks)).toContain("OK   codex capability: invocation=spawn, profile=no");
    expect(formatDoctorChecks(checks)).toContain("progress=audit, approval=opentag_policy");
    expect(formatDoctorChecks(checks)).toContain("context=context_packet,context_pointers,workspace");
    expect(formatDoctorChecks(checks)).toContain("prompt=opentag, write=workspace");
    expect(formatDoctorChecks(checks)).toContain("conversation=request, prompt_mutation=none, raw_context=no, write_actions=propose");
    expect(formatDoctorChecks(checks)).toContain("isolation=worktree, cwd_conformance=declared");
    expect(formatDoctorChecks(checks)).toContain("OK   github:acme/demo checkout: Workspace path configured (hasWorkspacePath=yes).");
    expect(formatDoctorChecks(checks)).not.toContain("opentag-local-runtime-doctor-");
  });

  it("reports a repository-free executor's unverified workspace capability", async () => {
    const manifest = {
      protocol: "opentag.integration.v1" as const,
      id: "scratch-agent",
      label: "Scratch ACP Agent",
      bindings: {
        agent: { kind: "stdio" as const, command: "scratch-agent", args: ["acp"] }
      },
      roles: {
        agent: {
          protocol: "agent-client-protocol" as const,
          protocolVersion: 1 as const,
          binding: "agent",
          workspace: { sessionCwd: "required" as const }
        }
      },
      resources: {}
    };
    const executor = withUnverifiedWorkspaceCapability(createAcpExecutor({ manifest }));
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      { repositories: [], agents: { "scratch-agent": manifest } },
      { executors: { "scratch-agent": executor } }
    );
    const output = formatDoctorChecks(checks);

    expect(output).toContain("OK   scratch-agent configured agent: Scratch ACP Agent (scratch-agent)");
    expect(output).toContain("FAIL scratch-agent capability:");
    expect(output).toContain("isolation=external, cwd_conformance=unverified");
    expect(doctorHasFailures(checks)).toBe(true);
  });

  it("passes repository-free doctor checks for a declared scratch-only ACP agent", async () => {
    const manifest = {
      protocol: "opentag.integration.v1" as const,
      id: "declared-agent",
      label: "Declared ACP Agent",
      bindings: { agent: { kind: "stdio" as const, command: "declared-agent" } },
      roles: {
        agent: {
          protocol: "agent-client-protocol" as const,
          protocolVersion: 1 as const,
          binding: "agent",
          workspace: { sessionCwd: "required" as const }
        }
      },
      resources: {}
    };
    const executor = createAcpExecutor({ manifest });
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      { repositories: [], agents: { "declared-agent": manifest } },
      { executors: { "declared-agent": executor } }
    );
    const output = formatDoctorChecks(checks);

    expect(output).toContain("OK   repository config: 1 configured agent supports repository-free Runs.");
    expect(output).toContain("OK   declared-agent capability:");
    expect(doctorHasFailures(checks)).toBe(false);
  });

  it("fails repository configuration when neither repositories nor agents are configured", async () => {
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      { repositories: [], agents: {} },
      { executors: {} }
    );

    expect(formatDoctorChecks(checks)).toContain(
      "FAIL repository config: No repositories or agents are configured."
    );
    expect(doctorHasFailures(checks)).toBe(true);
  });

  it("fails when a repository-free configured ACP agent has no local executor", async () => {
    const manifest = {
      protocol: "opentag.integration.v1" as const,
      id: "missing-agent",
      label: "Missing ACP Agent",
      bindings: { agent: { kind: "stdio" as const, command: "missing-agent" } },
      roles: {
        agent: {
          protocol: "agent-client-protocol" as const,
          protocolVersion: 1 as const,
          binding: "agent",
          workspace: { sessionCwd: "required" as const }
        }
      },
      resources: {}
    };
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      { repositories: [], agents: { "missing-agent": manifest } },
      { executors: {} }
    );

    expect(formatDoctorChecks(checks)).toContain(
      "FAIL missing-agent configured agent: No local executor is configured with this id."
    );
  });

  it("does not duplicate an unverified executor capability already covered by a repository default", async () => {
    const manifest = {
      protocol: "opentag.integration.v1" as const,
      id: "repo-agent",
      label: "Repository ACP Agent",
      bindings: { agent: { kind: "stdio" as const, command: "repo-agent" } },
      roles: {
        agent: {
          protocol: "agent-client-protocol" as const,
          protocolVersion: 1 as const,
          binding: "agent",
          workspace: { sessionCwd: "required" as const }
        }
      },
      resources: {}
    };
    const acpExecutor = withUnverifiedWorkspaceCapability(createAcpExecutor({ manifest }));
    const executor: ExecutorAdapter = { ...acpExecutor, canRun: async () => ({ ready: true }) };
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      { agents: { "repo-agent": manifest } },
      { executors: { "repo-agent": executor }, repositoryDefaultExecutor: "repo-agent" }
    );
    const output = formatDoctorChecks(checks);

    expect(output.match(/repo-agent capability:/gu)).toHaveLength(1);
    expect(output).toContain("FAIL repo-agent capability:");
    expect(output).not.toContain("repo-agent configured agent:");
    expect(doctorHasFailures(checks)).toBe(true);
  });

  it("fails a healthy repository doctor when a secondary configured ACP agent is unverified", async () => {
    const manifest = {
      protocol: "opentag.integration.v1" as const,
      id: "secondary-agent",
      label: "Secondary ACP Agent",
      bindings: { agent: { kind: "stdio" as const, command: "secondary-agent" } },
      roles: {
        agent: {
          protocol: "agent-client-protocol" as const,
          protocolVersion: 1 as const,
          binding: "agent",
          workspace: { sessionCwd: "required" as const }
        }
      },
      resources: {}
    };
    const secondaryExecutor = withUnverifiedWorkspaceCapability(createAcpExecutor({ manifest }));
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      { agents: { "secondary-agent": manifest } },
      { executors: { codex: codexExecutor, "secondary-agent": secondaryExecutor } }
    );
    const output = formatDoctorChecks(checks);

    expect(output).toContain("OK   github:acme/demo git repo: Git checkout detected");
    expect(output).toContain("FAIL secondary-agent capability:");
    expect(output).toContain("cwd_conformance=unverified");
    expect(doctorHasFailures(checks)).toBe(true);
  });

  it("fails Hermes readiness when the configured fixed profile is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "opentag-hermes-doctor-"));
    const checkoutPath = join(root, "demo");
    mkdirSync(checkoutPath, { recursive: true });
    writeFileSync(join(checkoutPath, ".git"), "gitdir: /tmp/fake-git\n");
    const hermesExecutor = createBuiltInAcpExecutors({ hermes: { profile: "opentag-fixed" } }).hermes;
    const unavailableHermesExecutor: ExecutorAdapter = {
      ...hermesExecutor,
      async canRun() {
        return {
          ready: false,
          reason: "Hermes profile 'opentag-fixed' is not ready: Profile 'opentag-fixed' does not exist"
        };
      }
    };

    try {
      const checks = await runDoctor({
        config: {
          runnerId: "runner_local",
          relayUrl: "https://control.example",
          repositories: [
            {
              projectTargetId: "target_1",
              provider: "github",
              owner: "acme",
              repo: "demo",
              checkoutPath,
              defaultExecutor: "hermes",
              baseBranch: "main",
              pushRemote: "origin",
              keepWorktree: "on_failure"
            }
          ],
          hermes: { profile: "opentag-fixed" },
          pollIntervalMs: 5000,
          heartbeatIntervalMs: 15000
        },
        executors: { hermes: unavailableHermesExecutor },
        commandRunner,
        fetchImpl: async (url) => {
          const stringUrl = String(url);
          if (stringUrl.endsWith("/healthz")) return Response.json({ ok: true });
          if (stringUrl.endsWith("/v1/runners/runner_local/control-context")) {
            return responseAt(stringUrl, Response.json({
              schemaVersion: 1,
              protocolVersion: "1.0",
              contextKind: "runner_control",
              organizationId: "org_1",
              runnerId: "runner_local",
              credentialId: "credential_runtime_1",
              registrationGeneration: 1,
              credentialGeneration: 1,
              capabilities: [],
              targets: [{
                projectTargetId: "target_1",
                bindingDigest: `sha256:${"a".repeat(64)}`,
                provider: "github",
                owner: "acme",
                repo: "demo",
                defaultExecutor: "hermes",
                defaultBranch: "main"
              }],
              observedAt: "2026-08-08T00:00:00.000Z"
            }));
          }
          return new Response("not found", { status: 404 });
        }
      });

      expect(doctorHasFailures(checks)).toBe(true);
      expect(formatDoctorChecks(checks)).toContain(
        "FAIL hermes executor: Hermes profile 'opentag-fixed' is not ready: Profile 'opentag-fixed' does not exist"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("fails closed for an unpaired hosted runner without sending pairing auth", async () => {
    const requests: Array<{ url: string; authorization?: string }> = [];
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      {
        controlRegistration: {
          kind: "hosted_control_v1",
          state: "unpaired",
          flow: "registration",
          operationId: "operation_pair_1",
          reason: "pending"
        }
      },
      {
        requestObserver(url, init) {
          const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
          requests.push({ url, ...(authorization ? { authorization } : {}) });
        }
      }
    );

    const formatted = formatDoctorChecks(checks);
    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatted).toContain("FAIL hosted runner auth: Hosted Control V1 runner is not paired");
    expect(formatted).not.toContain("pairing_secret_must_not_leak");
    expect(requests.filter(({ url }) => url.includes("/v1/"))).toEqual([]);
  });

  it("fails closed on recovery-required state while making no authenticated request", async () => {
    const runnerRequests: string[] = [];
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      {
        controlRegistration: {
          kind: "hosted_control_v1",
          state: "unpaired",
          reason: "recovery_required",
          registration: hostedRegistration
        }
      },
      {
        requestObserver(url) {
          if (url.includes("/v1/")) runnerRequests.push(url);
        }
      }
    );

    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatDoctorChecks(checks)).toContain(
      "FAIL hosted runner auth: Hosted Control V1 runner credential recovery is required"
    );
    expect(runnerRequests).toEqual([]);
  });

  it("does not authenticate a staged hosted credential", async () => {
    const runnerRequests: string[] = [];
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      {
        runnerToken: "runtime_staged_secret",
        controlRegistration: hostedControl("credential_staged")
      },
      {
        requestObserver(url) {
          if (url.includes("/v1/")) runnerRequests.push(url);
        }
      }
    );

    const formatted = formatDoctorChecks(checks);
    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatted).toContain("FAIL hosted runner auth: Hosted Control V1 runner credential is staged");
    expect(formatted).not.toContain("runtime_staged_secret");
    expect(runnerRequests).toEqual([]);
  });

  it("uses the runtime token for a valid paired hosted runner", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      {
        runnerToken: "runtime_paired_secret",
        controlRegistration: hostedControl("paired")
      },
      {
        requestObserver(url, init) {
          if (!url.includes("/v1/")) return;
          requests.push({
            url,
            authorization: new Headers(init?.headers).get("authorization")
          });
        }
      }
    );

    expect(doctorHasFailures(checks)).toBe(false);
    expect(formatDoctorChecks(checks)).toContain("OK   paired runner auth: Hosted Control V1 paired runtime credential is configured");
    expect(requests).toEqual([{
      url: "https://control.example/v1/runners/runner_local/control-context",
      authorization: "Bearer runtime_paired_secret"
    }]);
  });

  it("fails hosted remote auth without exposing the relay response body", async () => {
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      {
        runnerToken: "runtime_paired_secret",
        controlRegistration: hostedControl("paired")
      },
      {
        repositoryFree: true,
        controlContextResponse: () => Response.json(
          { error: "secret_shaped_error_must_not_leak", detail: "remote_body_secret_must_not_leak" },
          { status: 401 }
        )
      }
    );

    const formatted = formatDoctorChecks(checks);
    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatted).toContain("FAIL runner registration: Relay request failed with HTTP 401.");
    expect(formatted).toContain("remote authentication is checked separately");
    expect(formatted).not.toContain("remote_body_secret_must_not_leak");
    expect(formatted).not.toContain("secret_shaped_error_must_not_leak");
    expect(formatted).not.toContain("runtime_paired_secret");
  });

  it("fails closed on hosted identity mismatch without leaking the runtime credential", async () => {
    const runnerRequests: string[] = [];
    const checks = await runCodexDoctor(
      'service_tier = "fast"\n',
      {
        runnerToken: "runtime_mismatch_secret",
        controlRegistration: hostedControl("paired", "runner_other")
      },
      {
        requestObserver(url) {
          if (url.includes("/v1/")) runnerRequests.push(url);
        }
      }
    );
    const formatted = formatDoctorChecks(checks);

    expect(doctorHasFailures(checks)).toBe(true);
    expect(formatted).toContain("FAIL hosted runner auth:");
    expect(formatted).not.toContain("runtime_mismatch_secret");
    expect(runnerRequests).toEqual([]);
  });

});
