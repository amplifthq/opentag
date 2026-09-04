import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { computeGitHubProjectTargetBindingDigestV1 } from "@opentag/control-protocol";
import { readCliConfig } from "../src/config.js";
import {
  runSetupCommand,
  type SetupCommandDependencies,
} from "../src/commands/setup.js";
import type { PromptAdapter, PromptOption } from "../src/ui/prompts.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-setup-"));
}

function prompts(input: { confirm?: boolean } = {}): PromptAdapter {
  return {
    intro() {},
    outro() {},
    note() {},
    async select<Value extends string>(request: {
      options: Array<PromptOption<Value>>;
      initialValue?: Value;
    }) {
      return request.initialValue ?? request.options[0]!.value;
    },
    async text(request) { return request.initialValue ?? ""; },
    async password() { return "prompt-secret"; },
    async confirm() { return input.confirm ?? true; },
  };
}

function setupOptions(overrides: Record<string, unknown> = {}) {
  return {
    config: join(tempDir(), "config.json"),
    project: tempDir(),
    language: "en",
    executor: "echo",
    githubRepository: "acme/demo",
    projectTargetId: "target_1",
    relay: "https://relay.example",
    start: false,
    yes: true,
    ...overrides,
  };
}

async function returnWrittenConfig(options: { config?: string }) {
  return readCliConfig(options.config!);
}

function dependencies(
  overrides: Partial<SetupCommandDependencies> = {},
): SetupCommandDependencies {
  return {
    prompts: prompts(),
    env: {
      OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
    },
    pairOpenTag: returnWrittenConfig,
    ...overrides,
  };
}

describe("OpenTag CLI paired setup core", () => {
  it("writes a private paired Runner configuration", async () => {
    const options = setupOptions();
    await runSetupCommand(options, dependencies());
    expect(existsSync(options.config)).toBe(true);
    expect(statSync(options.config).mode & 0o777).toBe(0o600);
    const config = readCliConfig(options.config);
    expect(config.daemon.relayUrl).toBe("https://relay.example");
    expect(config).not.toHaveProperty("runtime");
    expect(config.daemon.repositories[0]).toMatchObject({
      projectTargetId: "target_1",
      provider: "github",
      owner: "acme",
      repo: "demo",
      defaultExecutor: "echo",
    });
  });

  it("registers the setup Project Target before finalizing the Runner pair", async () => {
    const options = setupOptions();
    const upsertRunnerProjectTargetControlV1 = vi.fn(async (input: any) => ({
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      contextKind: "runner_control" as const,
      organizationId: "org_1",
      runnerId: input.runnerId,
      credentialId: "credential_1",
      registrationGeneration: 1,
      credentialGeneration: 1,
      capabilities: ["relay.repository-binding.v1"] as const,
      targets: [{
        ...input.request.target,
        bindingDigest: await computeGitHubProjectTargetBindingDigestV1(
          input.request.target,
        ),
      }],
      observedAt: "2026-08-15T06:00:00.000Z",
    }));
    const client = {
      getRelayCapabilitiesControlV1: vi.fn(async () => ({
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        registryVersion: "opentag.control.capabilities/v1" as const,
        capabilities: ["relay.registration.v1", "relay.repository-binding.v1"] as const,
        minimumClient: { schemaVersion: 1 as const, protocolVersion: "1.0" as const },
        deployment: { environment: "test", releaseSha: "a".repeat(40) },
      })),
      registerRunnerControlV1: vi.fn(async (request: any) => ({
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        operationId: request.operationId,
        organizationId: "org_1",
        runnerId: "runner_local",
        registrationGeneration: 1,
        credentialGeneration: 1,
        credentialId: "credential_1",
        credentialPurpose: "runtime" as const,
        runnerToken: "runner_runtime_token",
        createdAt: "2026-08-15T06:00:00.000Z",
        replayed: false as const,
      })),
      reprovisionRunnerControlV1: vi.fn(),
      getRunnerControlContextV1: vi.fn(),
      upsertRunnerProjectTargetControlV1,
    };
    await runSetupCommand(options, dependencies({
      pairOpenTag: undefined,
      pairDependencies: {
        createControlClient: () => client as never,
        now: () => new Date("2026-08-15T06:00:00.000Z"),
        randomUUID: () => "operation_setup_pair",
      },
    }));
    expect(upsertRunnerProjectTargetControlV1).toHaveBeenCalledWith(
      expect.objectContaining({
        projectTargetId: "target_1",
        request: expect.objectContaining({
          target: expect.objectContaining({ owner: "acme", repo: "demo" }),
        }),
      }),
    );
    expect(readCliConfig(options.config).daemon.controlRegistration)
      .toMatchObject({ state: "paired" });
  });

  it("omits the optional GitHub publication credential in non-interactive setup", async () => {
    const options = setupOptions();
    await runSetupCommand(options, dependencies());
    expect(readCliConfig(options.config).daemon.githubToken).toBeUndefined();
  });

  it("requires an explicit relay", async () => {
    const options = setupOptions({ relay: undefined });
    await expect(runSetupCommand(options, dependencies())).rejects.toThrow(
      "opentag setup requires --relay <url>",
    );
    expect(existsSync(options.config)).toBe(false);
  });

  it("requires --project-target-id before non-interactive setup writes config", async () => {
    const options = setupOptions({ projectTargetId: undefined });
    await expect(runSetupCommand(options, dependencies())).rejects.toThrow(
      "--project-target-id is required for non-interactive setup",
    );
    expect(existsSync(options.config)).toBe(false);
  });

  it("fails before writing when the Project Target checkout is missing", async () => {
    const missing = join(tempDir(), "missing");
    const options = setupOptions({ project: missing });
    await expect(runSetupCommand(options, dependencies())).rejects.toThrow(
      "Project path does not exist:",
    );
    expect(existsSync(options.config)).toBe(false);
  });

  it("never overwrites an existing config", async () => {
    const options = setupOptions();
    await runSetupCommand(options, dependencies());
    await expect(runSetupCommand(
      { ...options, executor: "codex" },
      dependencies(),
    )).rejects.toThrow("Setup never overwrites pairing authority");
    expect(
      readCliConfig(options.config).daemon.repositories[0]?.defaultExecutor,
    ).toBe("echo");
  });

  it("starts the paired Runner in the terminal only when requested", async () => {
    const startOpenTag = vi.fn(async () => {});
    const options = setupOptions({ start: true });
    await runSetupCommand(options, dependencies({ startOpenTag }));
    expect(startOpenTag).toHaveBeenCalledWith({ config: options.config });
  });

  it("installs the paired Runner service only when requested", async () => {
    const startOpenTagService = vi.fn(async () => {});
    const options = setupOptions({ service: true, start: undefined });
    await runSetupCommand(options, dependencies({
      platform: "darwin",
      startOpenTagService,
    }));
    expect(startOpenTagService).toHaveBeenCalledWith({ config: options.config });
  });

  it("rejects conflicting terminal and service launch choices", async () => {
    const options = setupOptions({ service: true, start: true });
    await expect(runSetupCommand(options, dependencies({
      platform: "darwin",
    }))).rejects.toThrow(
      "--service cannot be combined with --start or --no-start.",
    );
  });

  it("fails closed when a selected Hermes ACP profile is not ready", async () => {
    const options = setupOptions({ executor: "hermes", hermesProfile: "team" });
    await expect(runSetupCommand(options, dependencies({
      probeHermesProfile: vi.fn(async () => ({
        ready: false,
        reason: "Hermes profile is unavailable.",
      })),
    }))).rejects.toThrow("Hermes profile is unavailable.");
    expect(existsSync(options.config)).toBe(false);
  });

  it("retains the generated unpaired config when pairing fails", async () => {
    const options = setupOptions();
    await expect(runSetupCommand(options, dependencies({
      pairOpenTag: vi.fn(async () => {
        throw new Error("relay registration failed");
      }),
    }))).rejects.toThrow("relay registration failed");
    const pending = readCliConfig(options.config);
    expect(pending.daemon.relayUrl).toBe("https://relay.example");
    expect(pending).not.toHaveProperty("runtime");
    expect(pending.daemon.controlRegistration).toBeUndefined();
  });
});
