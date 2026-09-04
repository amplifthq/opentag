import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readCliConfig } from "../src/config.js";
import { runSetupCommand } from "../src/setup.js";
import type { PromptAdapter, PromptOption } from "../src/ui/prompts.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-setup-surface-"));
}

function prompts(notes: string[] = []): PromptAdapter {
  return {
    intro() {},
    outro() {},
    note(message) { notes.push(message); },
    async select<Value extends string>(input: {
      options: Array<PromptOption<Value>>;
      initialValue?: Value;
    }) {
      return input.initialValue ?? input.options[0]!.value;
    },
    async text(input) { return input.initialValue ?? ""; },
    async password() { return "prompt-secret"; },
    async confirm() { return true; },
  };
}

const baseOptions = () => ({
  config: join(tempDir(), "config.json"),
  project: tempDir(),
  language: "en",
  executor: "codex",
  githubRepository: "Acme/Demo",
  projectTargetId: "target_1",
  relay: "https://relay.example",
  start: false,
  yes: true,
} as const);

const setupEnv = {
  OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "bootstrap_secret",
};

async function returnWrittenConfig(options: { config?: string }) {
  return readCliConfig(options.config!);
}

describe("OpenTag paired Runner setup surface", () => {
  it("writes only paired relay, Runner, and authoritative GitHub target state", async () => {
    const options = baseOptions();
    await runSetupCommand(options, {
      prompts: prompts(),
      env: setupEnv,
      pairOpenTag: returnWrittenConfig,
    });

    const config = readCliConfig(options.config);
    expect(config).not.toHaveProperty("runtime");
    expect(config.daemon.relayUrl).toBe("https://relay.example");
    expect(config.daemon.repositories).toEqual([
      expect.objectContaining({
        projectTargetId: "target_1",
        provider: "github",
        owner: "acme",
        repo: "demo",
        defaultExecutor: "codex",
      }),
    ]);
    expect(config.daemon.githubToken).toBeUndefined();
    expect(config).not.toHaveProperty("platforms");
    expect(config.daemon).not.toHaveProperty("channelBindings");
  });

  it("does not persist Slack or GitHub ingress credentials", async () => {
    const options = baseOptions();
    await runSetupCommand(options, {
      prompts: prompts(),
      env: setupEnv,
      pairOpenTag: returnWrittenConfig,
    });
    const serialized = readFileSync(options.config, "utf8");
    expect(serialized).not.toContain("appToken");
    expect(serialized).not.toContain("signingSecret");
    expect(serialized).not.toContain("botToken");
    expect(serialized).not.toContain("webhookSecret");
    expect(serialized).not.toContain("webhookPath");
    expect(serialized).not.toContain("socket_mode");
    expect(serialized).not.toContain("bootstrap_secret");
  });

  it("collects an optional publication token through the interactive secret prompt", async () => {
    const options = { ...baseOptions(), yes: false };
    await runSetupCommand(options, {
      prompts: prompts(),
      pairOpenTag: returnWrittenConfig,
    });
    expect(readCliConfig(options.config).daemon.githubToken).toBe("prompt-secret");
  });

  it("collects the Compose-declared Project Target ID interactively without a duplicate env setting", async () => {
    const options = { ...baseOptions(), yes: false, projectTargetId: undefined };
    const adapter = prompts();
    adapter.text = async (input) => input.message.includes("Project Target ID")
      ? "target_interactive"
      : input.initialValue ?? "";
    await runSetupCommand(options, {
      prompts: adapter,
      pairOpenTag: returnWrittenConfig,
    });
    expect(readCliConfig(options.config).daemon.repositories[0]?.projectTargetId)
      .toBe("target_interactive");
  });

  it("explains that Slack installation custody belongs to the Control Plane", async () => {
    const notes: string[] = [];
    await runSetupCommand(baseOptions(), {
      prompts: prompts(notes),
      env: setupEnv,
      pairOpenTag: returnWrittenConfig,
    });
    expect(notes.join("\n")).toContain(
      "Slack installation, binding, and credentials stay in the Control Plane",
    );
    expect(notes.join("\n")).toContain(
      "GitHub is the Project Target and approved publication/evidence provider, not Source ingress.",
    );
  });

  it("requires a relay before collecting or writing setup", async () => {
    const options = { ...baseOptions(), relay: undefined };
    const pairOpenTag = vi.fn(returnWrittenConfig);
    await expect(runSetupCommand(options, {
      prompts: prompts(),
      env: setupEnv,
      pairOpenTag,
    })).rejects.toThrow("opentag setup requires --relay <url>");
    expect(pairOpenTag).not.toHaveBeenCalled();
  });

  it("passes an explicit same-origin trust authorization into pairing", async () => {
    const options = baseOptions();
    const pairOpenTag = vi.fn(returnWrittenConfig);
    await runSetupCommand(options, {
      prompts: prompts(),
      env: setupEnv,
      pairOpenTag,
    });
    expect(pairOpenTag).toHaveBeenCalledWith(
      {
        config: options.config,
        relay: "https://relay.example",
        trustRelayOrigin: "https://relay.example",
      },
      expect.objectContaining({
        logger: expect.any(Object),
        readBootstrapSecret: expect.any(Function),
      }),
    );
    const pairDependencies = pairOpenTag.mock.calls[0]![1]!;
    expect(await pairDependencies.readBootstrapSecret!()).toBe("bootstrap_secret");
  });
});
