import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSetupConfig } from "../src/setup.js";
import {
  shouldRethrowAbortReason,
  startFromConfig,
  waitForRelay,
} from "../src/start.js";

function pairedConfig() {
  const projectPath = mkdtempSync(join(tmpdir(), "opentag-cli-start-project-"));
  const stateDirectory = mkdtempSync(join(tmpdir(), "opentag-cli-start-state-"));
  const config = createSetupConfig({
    language: "en",
    relayUrl: "https://relay.example",
    projectPath,
    executor: "echo",
    stateDirectory,
    github: {
      projectTargetId: "target_1",
      owner: "acme",
      repo: "demo",
    },
  });
  config.daemon.runnerToken = "runner_runtime_token";
  config.daemon.trustedRelay = {
    schemaVersion: 1,
    origin: "https://relay.example",
    authorizedAt: "2026-08-08T00:00:00.000Z",
    authorizationMethod: "explicit_cli",
  };
  config.daemon.controlRegistration = {
    kind: "hosted_control_v1",
    state: "paired",
    operationId: "operation_start",
    registration: {
      schemaVersion: 1,
      protocolVersion: "1.0",
      organizationId: "org_1",
      runnerId: config.daemon.runnerId,
      registrationGeneration: 1,
      credentialGeneration: 1,
      credentialId: "credential_1",
      credentialPurpose: "runtime",
      createdAt: "2026-08-08T00:00:00.000Z",
    },
  };
  return config;
}

function controlV1RuntimeInput() {
  return {
    controlLoop: {
      beforeIteration: async () => false,
      afterIteration: async () => undefined,
      abort: () => undefined,
      close: async () => undefined,
    },
  };
}

describe("OpenTag CLI paired Runner start", () => {
  it("waits for the relay and starts only the Control V1 Runner loop", async () => {
    const config = pairedConfig();
    const external = new AbortController();
    const calls: string[] = [];
    const createDaemonRuntimeInput = vi.fn(() => controlV1RuntimeInput());
    const logs: string[] = [];

    const started = startFromConfig({
      config,
      configPath: "/tmp/opentag/config.json",
      signal: external.signal,
      listenForProcessSignals: false,
      dependencies: {
        createDaemonRuntimeInput: createDaemonRuntimeInput as never,
        async waitForRelay({ relayUrl }) {
          calls.push(`relay:${relayUrl}`);
        },
        async serveDaemon(input) {
          calls.push("runner");
          await new Promise<void>((resolve) => {
            input.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        logger: { log: (line) => logs.push(line) },
      },
    });

    await vi.waitFor(() => {
      expect(calls).toEqual([
        "relay:https://relay.example",
        "runner",
      ]);
    });
    external.abort();
    await started;

    expect(createDaemonRuntimeInput).toHaveBeenCalledWith(
      config.daemon,
      { databasePath: config.state.databasePath },
    );
    expect(logs.join("\n")).toContain("OpenTag paired Runner is running.");
    expect(logs.join("\n")).toContain("Relay: https://relay.example");
  });

  it("refuses an unpaired config before relay or Runner startup", async () => {
    const config = pairedConfig();
    delete config.daemon.controlRegistration;
    delete config.daemon.runnerToken;
    const waitForRelay = vi.fn();
    const serveDaemon = vi.fn();

    await expect(startFromConfig({
      config,
      configPath: "/tmp/opentag/config.json",
      listenForProcessSignals: false,
      dependencies: { waitForRelay, serveDaemon },
    })).rejects.toThrow("not paired with Hosted Control V1");
    expect(waitForRelay).not.toHaveBeenCalled();
    expect(serveDaemon).not.toHaveBeenCalled();
  });

  it("rejects a relay/trusted-origin mismatch before network access", async () => {
    const config = pairedConfig();
    config.daemon.relayUrl = "https://other.example";
    const waitForRelay = vi.fn();

    await expect(startFromConfig({
      config,
      configPath: "/tmp/opentag/config.json",
      listenForProcessSignals: false,
      dependencies: { waitForRelay },
    })).rejects.toThrow("relay origin does not match the explicitly trusted relay origin");
    expect(waitForRelay).not.toHaveBeenCalled();
  });

  it("propagates an unexpected Runner-loop failure", async () => {
    const config = pairedConfig();
    const failure = new Error("runner loop failed");

    await expect(startFromConfig({
      config,
      configPath: "/tmp/opentag/config.json",
      listenForProcessSignals: false,
      dependencies: {
        createDaemonRuntimeInput: (() => controlV1RuntimeInput()) as never,
        async waitForRelay() {},
        async serveDaemon() {
          throw failure;
        },
        logger: { log() {} },
      },
    })).rejects.toThrow("runner loop failed");
  });

  it("waits for relay health and reports the relay endpoint on timeout", async () => {
    const fetchImpl = vi.fn(async () => Response.json(
      { status: "not_ready" },
      { status: 503 },
    ));
    await expect(waitForRelay({
      relayUrl: "https://relay.example",
      fetchImpl,
      attempts: 2,
      delayMs: 0,
    })).rejects.toThrow(
      "Relay did not become healthy at https://relay.example/healthz.",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("accepts relay health as soon as the endpoint responds successfully", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: "ok" }));
    await expect(waitForRelay({
      relayUrl: "https://relay.example",
      fetchImpl,
      attempts: 1,
    })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://relay.example/healthz",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps user shutdown separate from an unexpected failure", () => {
    expect(shouldRethrowAbortReason({
      shutdownRequested: true,
      reason: new Error("shutdown"),
    })).toBe(false);
    expect(shouldRethrowAbortReason({
      shutdownRequested: false,
      reason: new Error("runner failed"),
    })).toBe(true);
    expect(shouldRethrowAbortReason({
      shutdownRequested: false,
      reason: "stopped",
    })).toBe(false);
  });
});
