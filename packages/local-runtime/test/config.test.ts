import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalHostedRelayOrigin,
  hostedRunnerAuthProblem,
  loadConfigFromEnv,
  parseDaemonConfig,
  readKeychainSecret,
} from "../src/config.js";

function registration() {
  return {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    organizationId: "org_1",
    runnerId: "runner_1",
    registrationGeneration: 1,
    credentialGeneration: 1,
    credentialId: "credential_1",
    credentialPurpose: "runtime" as const,
    createdAt: "2026-08-08T00:00:00.000Z",
  };
}

function trust(origin = "https://control.example") {
  return {
    schemaVersion: 1 as const,
    origin,
    authorizedAt: "2026-08-08T00:00:00.000Z",
    authorizationMethod: "explicit_cli" as const,
  };
}

function base() {
  return {
    runnerId: "runner_1",
    relayUrl: "https://control.example",
    repositories: [],
    agents: {},
    scratchRoot: join(tmpdir(), "opentag-config-scratch"),
    pollIntervalMs: 5_000,
    heartbeatIntervalMs: 15_000,
  };
}

function paired() {
  return {
    ...base(),
    runnerToken: "runner_secret",
    trustedRelay: trust(),
    controlRegistration: {
      kind: "hosted_control_v1" as const,
      state: "paired" as const,
      operationId: "operation_pair",
      registration: registration(),
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("paired Runner config", () => {
  it("accepts only relayUrl as the canonical relay endpoint", () => {
    expect(parseDaemonConfig(base()).relayUrl).toBe("https://control.example");

    const legacy: Record<string, unknown> = {
      ...base(),
      dispatcherUrl: "https://control.example",
    };
    delete legacy.relayUrl;
    expect(() => parseDaemonConfig(legacy)).toThrow();
    expect(() => parseDaemonConfig({
      ...base(),
      relayUrl: "http://control.example",
    })).toThrow("must use HTTPS");
  });

  it("accepts only GitHub repository bindings and canonicalizes their identity", () => {
    const parsed = parseDaemonConfig({
      ...base(),
      repositories: [{
        projectTargetId: "target_1",
        provider: "github",
        owner: "AcMe",
        repo: "DeMo",
        checkoutPath: "/tmp/demo",
        defaultExecutor: "codex",
      }],
    });
    expect(parsed.repositories[0]).toMatchObject({
      projectTargetId: "target_1",
      provider: "github",
      owner: "acme",
      repo: "demo",
      baseBranch: "main",
      pushRemote: "origin",
      keepWorktree: "on_failure",
    });
    expect(() => parseDaemonConfig({
      ...base(),
      repositories: [{
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        defaultExecutor: "codex",
      }],
    })).toThrow();
    expect(() => parseDaemonConfig({
      ...base(),
      repositories: [{
        provider: "gitlab",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
      }],
    })).toThrow();
  });

  it("accepts custom executor ids but rejects collisions with built-ins", () => {
    const custom = parseDaemonConfig({
      ...base(),
      agents: {
        reviewer: {
          command: "reviewer-acp",
          workspaceCwd: "required",
        },
      },
      repositories: [{
        projectTargetId: "target_1",
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        defaultExecutor: "reviewer",
      }],
    });
    expect(custom.repositories[0]?.defaultExecutor).toBe("reviewer");
    expect(() => parseDaemonConfig({
      ...base(),
      agents: {
        codex: { command: "replacement", workspaceCwd: "required" },
      },
    })).toThrow("cannot replace the built-in executor");
  });

  it("parses bounded runtime, profile, and security settings", () => {
    const parsed = parseDaemonConfig({
      ...base(),
      runTimeoutMs: 60_000,
      keepScratch: "always",
      approvalMode: "auto",
      hermes: { command: " hermes ", profile: " team " },
      openclaw: { command: " openclaw ", profile: " default " },
      agentSessionProfile: { profileTemplate: "agent-{provider}" },
      security: { mode: "enforce", allowedWorkspaceRoot: "/tmp" },
    });
    expect(parsed.hermes).toEqual({ command: "hermes", profile: "team" });
    expect(parsed.openclaw).toMatchObject({ command: "openclaw", profile: "default" });
    expect(parsed.runTimeoutMs).toBe(60_000);
    expect(() => parseDaemonConfig({ ...base(), runTimeoutMs: 0 })).toThrow();
  });

  it("requires exact canonical HTTPS relay trust before resolving secrets", () => {
    vi.stubEnv("OPENTAG_CONFIG_RUNNER_TOKEN", "runner_secret");
    const raw = {
      ...paired(),
      runnerToken: { kind: "env", name: "OPENTAG_CONFIG_RUNNER_TOKEN" },
    };
    expect(parseDaemonConfig(raw).runnerToken).toBe("runner_secret");
    expect(() => parseDaemonConfig({
      ...raw,
      trustedRelay: trust("https://other.example"),
      runnerToken: { kind: "env", name: "OPENTAG_SECRET_MUST_NOT_BE_READ" },
    })).toThrow("does not match the explicitly trusted relay origin");
    expect(() => canonicalHostedRelayOrigin("http://control.example")).toThrow("must use HTTPS");
    expect(() => canonicalHostedRelayOrigin("https://control.example/path")).toThrow("origin-only");
  });

  it("persists initial pending and outcome-unknown registration without bootstrap secret custody", () => {
    for (const reason of ["pending", "outcome_unknown"] as const) {
      const parsed = parseDaemonConfig({
        ...base(),
        trustedRelay: trust(),
        controlRegistration: {
          kind: "hosted_control_v1",
          state: "unpaired",
          flow: "registration",
          operationId: "operation_pair",
          reason,
        },
      });
      expect(parsed.controlRegistration).toMatchObject({ reason, operationId: "operation_pair" });
      expect(parsed).not.toHaveProperty("pairingToken");
      expect(parsed).not.toHaveProperty("runnerToken");
    }
  });

  it("keeps recovery-required and reprovision states token-free", () => {
    const recovery = parseDaemonConfig({
      ...base(),
      trustedRelay: trust(),
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "unpaired",
        reason: "recovery_required",
        registration: registration(),
      },
    });
    expect(hostedRunnerAuthProblem(recovery)).toContain("recovery is required");

    const reprovision = parseDaemonConfig({
      ...base(),
      trustedRelay: trust(),
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "unpaired",
        flow: "reprovision",
        operationId: "operation_recover",
        reason: "outcome_unknown",
        recoveryCredentialId: "recovery_1",
        registration: registration(),
      },
    });
    expect(reprovision.controlRegistration).toMatchObject({
      flow: "reprovision",
      operationId: "operation_recover",
      reason: "outcome_unknown",
    });
    expect(reprovision).not.toHaveProperty("runnerToken");
  });

  it("requires a runtime token only for staged and paired registration", () => {
    for (const state of ["credential_staged", "paired"] as const) {
      const controlRegistration = {
        kind: "hosted_control_v1" as const,
        state,
        operationId: "operation_pair",
        registration: registration(),
      };
      expect(() => parseDaemonConfig({
        ...base(),
        trustedRelay: trust(),
        controlRegistration,
      })).toThrow("requires a runtime runner token");
      expect(parseDaemonConfig({
        ...base(),
        runnerToken: "runner_secret",
        trustedRelay: trust(),
        controlRegistration,
      }).controlRegistration?.state).toBe(state);
    }
  });

  it("reports paired auth state without exposing credentials", () => {
    expect(hostedRunnerAuthProblem(parseDaemonConfig(paired()))).toBeUndefined();
    expect(hostedRunnerAuthProblem(parseDaemonConfig({
      ...base(),
      trustedRelay: trust(),
      controlRegistration: {
        kind: "hosted_control_v1",
        state: "unpaired",
        flow: "registration",
        operationId: "operation_pair",
        reason: "outcome_unknown",
      },
    }))).toContain("outcome-unknown pairing state");
  });

  it("resolves GitHub and Runner secrets from env and file refs", () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-config-secret-"));
    const tokenFile = join(directory, "github-token");
    writeFileSync(tokenFile, " github_from_file \n", { mode: 0o600 });
    vi.stubEnv("OPENTAG_CONFIG_RUNNER_TOKEN", "runner_from_env");
    const parsed = parseDaemonConfig({
      ...paired(),
      runnerToken: { kind: "env", name: "OPENTAG_CONFIG_RUNNER_TOKEN" },
      githubToken: { kind: "file", path: tokenFile },
    });
    expect(parsed.runnerToken).toBe("runner_from_env");
    expect(parsed.githubToken).toBe("github_from_file");
  });

  it("resolves keychain refs without leaking command output", () => {
    const calls: unknown[] = [];
    expect(readKeychainSecret(
      { kind: "keychain", service: "opentag", account: "runner" },
      (file, args) => {
        calls.push({ file, args });
        return " keychain_secret \n";
      },
    )).toBe("keychain_secret");
    expect(calls).toEqual([{
      file: "/usr/bin/security",
      args: ["find-generic-password", "-w", "-s", "opentag", "-a", "runner"],
    }]);
  });

  it("loads only the explicit OPENTAG_CONFIG_PATH", () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-config-load-"));
    const path = join(directory, "config.json");
    writeFileSync(path, JSON.stringify(paired()), { mode: 0o600 });
    vi.stubEnv("OPENTAG_CONFIG_PATH", path);
    expect(loadConfigFromEnv().controlRegistration?.state).toBe("paired");
    vi.stubEnv("OPENTAG_CONFIG_PATH", "");
    expect(() => loadConfigFromEnv()).toThrow("OPENTAG_CONFIG_PATH is required");
  });
});
