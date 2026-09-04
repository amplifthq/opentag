import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSetupConfig } from "../src/setup.js";
import { formatStatus, getStatusSummary, statusFromConfig } from "../src/status.js";

function config() {
  const configured = createSetupConfig({
    language: "en",
    relayUrl: "https://relay.example",
    projectPath: mkdtempSync(join(tmpdir(), "opentag-status-project-")),
    executor: "echo",
    stateDirectory: mkdtempSync(join(tmpdir(), "opentag-status-state-")),
    github: { projectTargetId: "target_1", owner: "acme", repo: "demo" },
  });
  configured.daemon.runnerToken = "runner_runtime_token";
  configured.daemon.trustedRelay = {
    schemaVersion: 1,
    origin: "https://relay.example",
    authorizedAt: "2026-08-08T00:00:00.000Z",
    authorizationMethod: "explicit_cli",
  };
  configured.daemon.controlRegistration = {
    kind: "hosted_control_v1",
    state: "paired",
    operationId: "operation_status",
    registration: {
      schemaVersion: 1,
      protocolVersion: "1.0",
      organizationId: "org_1",
      runnerId: configured.daemon.runnerId,
      registrationGeneration: 2,
      credentialGeneration: 3,
      credentialId: "credential_3",
      credentialPurpose: "runtime",
      createdAt: "2026-08-08T00:00:00.000Z",
    },
  };
  return configured;
}

describe("paired Runner status", () => {
  it("reports paired identity without claiming readiness from relay reachability", async () => {
    const summary = await statusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => Response.json({ status: "ok" })),
    });
    expect(summary).toMatchObject({
      relay: "online",
      runnerId: "runner_local",
      registrationState: "paired",
      organizationId: "org_1",
      registrationGeneration: 2,
      credentialGeneration: 3,
      readiness: "relay_reachable_unverified",
    });
    expect(summary.readinessReason).toContain("Control Plane evidence");
  });

  it("reports an unreachable relay separately from Runner identity", async () => {
    const summary = await statusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    expect(summary.relay).toBe("offline");
    expect(summary.readiness).toBe("relay_unreachable");
    expect(summary.registrationState).toBe("paired");
  });

  it("reports an unpaired config without runtime authority", async () => {
    const configured = config();
    delete configured.daemon.controlRegistration;
    delete configured.daemon.runnerToken;
    const summary = await statusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => Response.json({ status: "ok" })),
    });
    expect(summary.readiness).toBe("not_paired");
    expect(summary.readinessReason).toBe("Pair the Runner before starting it.");
  });

  it("renders only paired Runner, relay, target, and redacted credential facts", async () => {
    const formatted = formatStatus(await statusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => Response.json({ status: "ok" })),
    }));
    expect(formatted).not.toContain("Runtime:");
    expect(formatted).not.toContain("Mode Profile:");
    expect(formatted).toContain("Runner readiness: relay_reachable_unverified");
    expect(formatted).toContain("Project Targets:\n  target_1 -> github:acme/demo");
    expect(formatted).toContain("daemon.runnerToken: inline (redacted)");
    expect(formatted).not.toContain("runner_runtime_token");
    expect(formatted).not.toContain("channel");
    expect(formatted).not.toContain("WorkThread");
  });

  it("reads a private paired config and retains only the SecretRef source", async () => {
    const configured = config();
    const directory = mkdtempSync(join(tmpdir(), "opentag-status-config-"));
    const path = join(directory, "config.json");
    writeFileSync(path, `${JSON.stringify({
      ...configured,
      daemon: {
        ...configured.daemon,
        githubToken: { kind: "env", name: "OPENTAG_STATUS_GITHUB_TOKEN" },
      },
    })}\n`, { mode: 0o600 });
    vi.stubEnv("OPENTAG_STATUS_GITHUB_TOKEN", "provider-secret");
    const summary = await getStatusSummary({
      configPath: path,
      fetchImpl: vi.fn(async () => Response.json({ status: "ok" })),
    });
    const formatted = formatStatus(summary);
    expect(formatted).toContain(
      "daemon.githubToken: env ref (OPENTAG_STATUS_GITHUB_TOKEN)",
    );
    expect(formatted).not.toContain("provider-secret");
    vi.unstubAllEnvs();
  });
});
