import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { computeGitHubProjectTargetBindingDigestV1 } from "@opentag/control-protocol";
import {
  readCliConfig,
  readCliRawConfig,
  writeCliConfigAtomic,
} from "../src/config.js";
import { normalizeRelayUrl, runPairCommand } from "../src/pair.js";
import { createSetupConfig } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-pair-"));
}

function initialConfig() {
  return createSetupConfig({
    language: "en",
    relayUrl: "https://relay.example",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    github: { projectTargetId: "target_1", token: "ghp_token", owner: "acme", repo: "demo" },
  });
}

function configPath() {
  const path = join(tempDir(), "config.json");
  writeCliConfigAtomic(path, initialConfig());
  return path;
}

function controlCapabilities(
  capability: "relay.registration.v1" | "relay.credential-reprovision.v1",
) {
  return {
    schemaVersion: 1,
    protocolVersion: "1.0",
    registryVersion: "opentag.control.capabilities/v1",
    capabilities: [capability, "relay.repository-binding.v1"].sort(),
    minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
    deployment: { environment: "test", releaseSha: "a".repeat(40) },
  };
}

function credentialResponse(input: {
  operationId: string;
  replayed: boolean;
  credentialGeneration?: number;
}) {
  return {
    schemaVersion: 1,
    protocolVersion: "1.0",
    operationId: input.operationId,
    organizationId: "org_1",
    runnerId: "runner_local",
    registrationGeneration: 1,
    credentialGeneration: input.credentialGeneration ?? 1,
    credentialId: `credential_${input.credentialGeneration ?? 1}`,
    credentialPurpose: "runtime",
    createdAt: "2026-08-08T00:00:00.000Z",
    replayed: input.replayed,
    ...(input.replayed ? {} : { runnerToken: "runner_runtime_token" }),
  };
}

function registrationClient(input: {
  replayed?: boolean;
  registerError?: Error;
  targetError?: Error;
  targetOrganizationId?: string;
  capabilities?: string[];
} = {}) {
  const registerRunnerControlV1 = vi.fn(async (request: { operationId: string }) => {
    if (input.registerError) throw input.registerError;
    return credentialResponse({
      operationId: request.operationId,
      replayed: input.replayed ?? false,
    });
  });
  const getRelayCapabilitiesControlV1 = vi.fn(async () => ({
    ...controlCapabilities("relay.registration.v1"),
    capabilities: input.capabilities
      ?? ["relay.registration.v1", "relay.repository-binding.v1"].sort(),
  }));
  const upsertRunnerProjectTargetControlV1 = vi.fn(async (requestInput: {
    runnerId: string;
    request: {
      expectedAuthority: {
        credentialId: string;
        registrationGeneration: number;
        credentialGeneration: number;
      };
      target: {
        projectTargetId: string;
        provider: "github";
        owner: string;
        repo: string;
        defaultExecutor: string;
        defaultBranch: string | null;
      };
    };
  }) => {
    if (input.targetError) throw input.targetError;
    return ({
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    contextKind: "runner_control" as const,
    organizationId: input.targetOrganizationId ?? "org_1",
    runnerId: requestInput.runnerId,
    ...requestInput.request.expectedAuthority,
    capabilities: ["relay.repository-binding.v1"] as const,
    targets: [{
      ...requestInput.request.target,
      bindingDigest: await computeGitHubProjectTargetBindingDigestV1(
        requestInput.request.target,
      ),
    }],
      observedAt: "2026-08-08T00:00:01.000Z",
    });
  });
  return {
    client: {
      getRelayCapabilitiesControlV1,
      getRunnerControlContextV1: vi.fn(),
      registerRunnerControlV1,
      reprovisionRunnerControlV1: vi.fn(),
      upsertRunnerProjectTargetControlV1,
    },
    getRelayCapabilitiesControlV1,
    registerRunnerControlV1,
    upsertRunnerProjectTargetControlV1,
  };
}

describe("OpenTag CLI Hosted Control V1 pairing", () => {
  it("normalizes relay URLs", () => {
    expect(normalizeRelayUrl(" https://example.up.railway.app/ ")).toBe(
      "https://example.up.railway.app",
    );
    expect(() => normalizeRelayUrl("ftp://relay.example")).toThrow(
      "Relay URL must use http or https.",
    );
    expect(() => normalizeRelayUrl("https://relay.example?token=secret")).toThrow(
      "Relay URL must not include a query string",
    );
  });

  it("rejects public HTTP and loopback relay URLs before provider calls", async () => {
    for (const relay of ["http://relay.example", "http://127.0.0.1:3030"]) {
      const createControlClient = vi.fn();
      await expect(runPairCommand({
        config: configPath(),
        relay,
        trustRelayOrigin: relay,
      }, { createControlClient: createControlClient as never })).rejects.toThrow();
      expect(createControlClient).not.toHaveBeenCalled();
    }
  });

  it("requires explicit relay-origin trust before mutation or secret access", async () => {
    const path = configPath();
    const createControlClient = vi.fn();
    await expect(runPairCommand({
      config: path,
      relay: "https://relay.example",
    }, { createControlClient: createControlClient as never })).rejects.toThrow(
      "requires --trust-relay-origin",
    );
    expect(createControlClient).not.toHaveBeenCalled();
    expect(readCliConfig(path).daemon.controlRegistration).toBeUndefined();
  });

  it("persists trust and a paired scoped Runner credential", async () => {
    const path = configPath();
    const before = readCliConfig(path);
    const runtime = registrationClient();
    const createControlClient = vi.fn(() => runtime.client as never);
    const output: string[] = [];
    const paired = await runPairCommand({
      config: path,
      relay: "https://relay.example",
      trustRelayOrigin: "https://relay.example",
    }, {
      createControlClient,
      readBootstrapSecret: () => "bootstrap_secret",
      randomUUID: () => "operation_pair",
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      logger: {
        log: (message) => output.push(message),
        warn: (message) => output.push(message),
      },
    });

    expect(runtime.getRelayCapabilitiesControlV1).toHaveBeenCalledOnce();
    expect(createControlClient).toHaveBeenNthCalledWith(2, expect.objectContaining({
      controlCredential: {
        kind: "bootstrap_pairing",
        token: "bootstrap_secret",
      },
    }));
    expect(runtime.registerRunnerControlV1).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "operation_pair",
        runnerId: "runner_local",
        requiredCapabilities: ["relay.registration.v1"],
      }),
    );
    expect(createControlClient).toHaveBeenNthCalledWith(3, expect.objectContaining({
      controlCredential: {
        kind: "runtime",
        token: "runner_runtime_token",
      },
    }));
    expect(runtime.upsertRunnerProjectTargetControlV1).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerId: "runner_local",
        projectTargetId: "target_1",
        request: expect.objectContaining({
          requiredCapabilities: ["relay.repository-binding.v1"],
          target: expect.objectContaining({
            projectTargetId: "target_1",
            provider: "github",
            owner: "acme",
            repo: "demo",
          }),
        }),
      }),
    );
    expect(paired.daemon.runnerToken).toBe("runner_runtime_token");
    expect(paired.daemon.controlRegistration).toMatchObject({
      state: "paired",
      operationId: "operation_pair",
    });
    expect(paired.daemon.trustedRelay).toMatchObject({
      origin: "https://relay.example",
      authorizationMethod: "explicit_cli",
    });
    expect(paired.daemon.repositories).toEqual(before.daemon.repositories);
    expect(JSON.stringify(readCliRawConfig(path))).not.toContain("bootstrap_secret");
    expect(output.join("\n")).toContain("Registration: completed");
    expect(output.join("\n")).not.toContain("webhook");
  });

  it("retains a replayed registration as recovery-required without a token", async () => {
    const path = configPath();
    const runtime = registrationClient({ replayed: true });
    await expect(runPairCommand({
      config: path,
      relay: "https://relay.example",
      trustRelayOrigin: "https://relay.example",
    }, {
      createControlClient: () => runtime.client as never,
      readBootstrapSecret: () => "bootstrap_secret",
      randomUUID: () => "operation_replay",
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      logger: { log() {}, warn() {} },
    })).rejects.toThrow("recovery_required");
    const persisted = readCliConfig(path);
    expect(persisted.daemon.controlRegistration).toMatchObject({
      state: "unpaired",
      reason: "recovery_required",
    });
    expect(persisted.daemon.runnerToken).toBeUndefined();
  });

  it("records outcome_unknown after an ambiguous registration failure", async () => {
    const path = configPath();
    const runtime = registrationClient({
      registerError: new Error("transport canary secret"),
    });
    await expect(runPairCommand({
      config: path,
      relay: "https://relay.example",
      trustRelayOrigin: "https://relay.example",
    }, {
      createControlClient: () => runtime.client as never,
      readBootstrapSecret: () => "bootstrap_secret",
      randomUUID: () => "operation_unknown",
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      logger: { log() {}, warn() {} },
    })).rejects.toThrow("mutation outcome is unknown");

    const raw = JSON.stringify(readCliRawConfig(path));
    expect(raw).toContain('"reason":"outcome_unknown"');
    expect(raw).not.toContain("transport canary secret");
  });

  it("retains a staged runtime credential and retries the same target sync without registering again", async () => {
    const path = configPath();
    const failing = registrationClient({ targetError: new Error("target sync unavailable") });
    await expect(runPairCommand({
      config: path,
      relay: "https://relay.example",
      trustRelayOrigin: "https://relay.example",
    }, {
      createControlClient: () => failing.client as never,
      readBootstrapSecret: () => "bootstrap_secret",
      randomUUID: () => "operation_staged_target",
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      logger: { log() {}, warn() {} },
    })).rejects.toThrow("target sync unavailable");
    expect(readCliConfig(path).daemon.controlRegistration).toMatchObject({
      state: "credential_staged",
      operationId: "operation_staged_target",
    });
    expect(readCliConfig(path).daemon.runnerToken).toBe("runner_runtime_token");
    expect(failing.registerRunnerControlV1).toHaveBeenCalledTimes(1);

    const retried = registrationClient();
    const readBootstrapSecret = vi.fn(() => "must_not_be_read");
    const reconciled = await runPairCommand({
      config: path,
      relay: "https://relay.example",
    }, {
      createControlClient: () => retried.client as never,
      readBootstrapSecret,
      randomUUID: () => "operation_must_not_replace_staged",
      logger: { log() {}, warn() {} },
    });
    expect(retried.registerRunnerControlV1).not.toHaveBeenCalled();
    expect(retried.upsertRunnerProjectTargetControlV1).toHaveBeenCalledTimes(1);
    expect(retried.upsertRunnerProjectTargetControlV1.mock.calls[0]?.[0].request.requestId)
      .toBe(failing.upsertRunnerProjectTargetControlV1.mock.calls[0]?.[0].request.requestId);
    expect(readBootstrapSecret).not.toHaveBeenCalled();
    expect(reconciled.daemon.controlRegistration).toMatchObject({
      state: "paired",
      operationId: "operation_staged_target",
    });
  });

  it("does not finalize pairing when target readback has different Runner authority", async () => {
    const path = configPath();
    const runtime = registrationClient({ targetOrganizationId: "org_other" });
    await expect(runPairCommand({ config: path, relay: "https://relay.example",
      trustRelayOrigin: "https://relay.example" }, {
      createControlClient: () => runtime.client as never,
      readBootstrapSecret: () => "bootstrap_secret",
      randomUUID: () => "operation_mismatched_readback",
      logger: { log() {}, warn() {} },
    })).rejects.toThrow("readback did not match the staged Runner authority");
    expect(readCliConfig(path).daemon.controlRegistration).toMatchObject({
      state: "credential_staged",
      operationId: "operation_mismatched_readback",
    });
  });

  it("reconciles targets for an already paired Runner without registering again", async () => {
    const path = configPath();
    const initial = registrationClient();
    await runPairCommand({ config: path, relay: "https://relay.example",
      trustRelayOrigin: "https://relay.example" }, {
      createControlClient: () => initial.client as never,
      readBootstrapSecret: () => "bootstrap_secret",
      randomUUID: () => "operation_existing_pair",
      logger: { log() {}, warn() {} },
    });

    const reconciler = registrationClient();
    const secretReader = vi.fn(() => "must_not_be_read");
    await runPairCommand({ config: path, relay: "https://relay.example" }, {
      createControlClient: () => reconciler.client as never,
      readBootstrapSecret: secretReader,
      randomUUID: () => "operation_must_not_be_used",
      logger: { log() {}, warn() {} },
    });
    expect(reconciler.registerRunnerControlV1).not.toHaveBeenCalled();
    expect(reconciler.upsertRunnerProjectTargetControlV1).toHaveBeenCalledTimes(1);
    expect(secretReader).not.toHaveBeenCalled();
  });

  it("rejects an incomplete config with no Project Target before network access", async () => {
    const path = configPath();
    const config = readCliConfig(path);
    writeCliConfigAtomic(path, { ...config, daemon: { ...config.daemon, repositories: [] } });
    const createControlClient = vi.fn();
    await expect(runPairCommand({ config: path, relay: "https://relay.example",
      trustRelayOrigin: "https://relay.example" }, {
      createControlClient: createControlClient as never,
    })).rejects.toThrow("Project Target setup is incomplete");
    expect(createControlClient).not.toHaveBeenCalled();
  });

  it("reuses the persisted operation and asks for bootstrap authority again after outcome_unknown", async () => {
    const path = configPath();
    const failing = registrationClient({ registerError: new Error("ambiguous transport") });
    await expect(runPairCommand({
      config: path,
      relay: "https://relay.example",
      trustRelayOrigin: "https://relay.example",
    }, {
      createControlClient: () => failing.client as never,
      readBootstrapSecret: () => "bootstrap_secret_first",
      randomUUID: () => "operation_original",
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      logger: { log() {}, warn() {} },
    })).rejects.toThrow("reuse the persisted operation");

    const retried = registrationClient();
    const createControlClient = vi.fn(() => retried.client as never);
    await runPairCommand({
      config: path,
      relay: "https://relay.example",
    }, {
      createControlClient,
      readBootstrapSecret: () => "bootstrap_secret_retry",
      randomUUID: () => "operation_must_not_replace_original",
      logger: { log() {}, warn() {} },
    });

    expect(retried.registerRunnerControlV1).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "operation_original" }),
    );
    expect(createControlClient).toHaveBeenNthCalledWith(2, expect.objectContaining({
      controlCredential: {
        kind: "bootstrap_pairing",
        token: "bootstrap_secret_retry",
      },
    }));
    expect(JSON.stringify(readCliRawConfig(path))).not.toContain("bootstrap_secret");
  });

  it("reprovisions a recovery-required Runner with injected recovery authority", async () => {
    const path = configPath();
    const replayed = registrationClient({ replayed: true });
    await expect(runPairCommand({
      config: path,
      relay: "https://relay.example",
      trustRelayOrigin: "https://relay.example",
    }, {
      createControlClient: () => replayed.client as never,
      readBootstrapSecret: () => "bootstrap_secret",
      randomUUID: () => "operation_replayed",
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      logger: { log() {}, warn() {} },
    })).rejects.toThrow("recovery_required");

    const reprovisionRunnerControlV1 = vi.fn(async (request: { operationId: string }) =>
      credentialResponse({ operationId: request.operationId, replayed: false, credentialGeneration: 2 }));
    const targetClient = registrationClient();
    const recoveryClient = {
      ...targetClient.client,
      getRelayCapabilitiesControlV1: vi.fn(async () =>
        controlCapabilities("relay.credential-reprovision.v1")),
      registerRunnerControlV1: vi.fn(),
      reprovisionRunnerControlV1,
    };
    const createControlClient = vi.fn(() => recoveryClient as never);
    const recovered = await runPairCommand({
      config: path,
      relay: "https://relay.example",
      recover: "recovery_credential_1",
    }, {
      createControlClient,
      readRecoverySecret: async () => "recovery_secret",
      randomUUID: () => "operation_recovery",
      logger: { log() {}, warn() {} },
    });

    expect(createControlClient).toHaveBeenNthCalledWith(2, expect.objectContaining({
      controlCredential: {
        kind: "recovery_pairing",
        token: "recovery_secret",
      },
    }));
    expect(reprovisionRunnerControlV1).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "operation_recovery",
      recoveryCredentialId: "recovery_credential_1",
      expectedCredentialGeneration: 1,
    }));
    expect(recovered.daemon.controlRegistration).toMatchObject({
      state: "paired",
      operationId: "operation_recovery",
      registration: { credentialGeneration: 2 },
    });
    expect(recovered.daemon.runnerToken).toBe("runner_runtime_token");
    expect(JSON.stringify(readCliRawConfig(path))).not.toContain("recovery_secret");
  });

  it("fails closed when the relay lacks registration capability", async () => {
    const path = configPath();
    const runtime = registrationClient({ capabilities: [] });
    await expect(runPairCommand({
      config: path,
      relay: "https://relay.example",
      trustRelayOrigin: "https://relay.example",
    }, {
      createControlClient: () => runtime.client as never,
      randomUUID: () => "operation_missing_capability",
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      logger: { log() {}, warn() {} },
    })).rejects.toThrow("does not advertise required capability relay.registration.v1");
    expect(runtime.registerRunnerControlV1).not.toHaveBeenCalled();
  });
});
