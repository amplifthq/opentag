import { describe, expect, it } from "vitest";
import { parseAcpRegistry, resolveAcpRegistryAgent } from "../src/acp-registry.js";

function registry(...agents: unknown[]) {
  return parseAcpRegistry({ version: "1.0.0", agents, extensions: [] });
}

describe("ACP Registry launch resolution", () => {
  it("maps npx and uvx distributions generically without per-agent branches", () => {
    const index = registry(
      {
        id: "gemini",
        name: "Gemini CLI",
        version: "0.50.0",
        description: "Gemini over ACP",
        distribution: {
          npx: { package: "@google/gemini-cli@0.50.0", args: ["--acp"] }
        }
      },
      {
        id: "fast-agent",
        name: "fast-agent",
        version: "0.9.9",
        description: "fast-agent over ACP",
        distribution: {
          uvx: { package: "fast-agent-acp==0.9.9", args: ["-x"] }
        }
      }
    );

    expect(resolveAcpRegistryAgent(index, "gemini")).toMatchObject({
      status: "launchable",
      registryId: "gemini",
      version: "0.50.0",
      distribution: "npx",
      agent: {
        id: "gemini",
        label: "Gemini CLI",
        launch: {
          command: "npx",
          args: ["--yes", "@google/gemini-cli@0.50.0", "--acp"]
        }
      }
    });
    expect(resolveAcpRegistryAgent(index, "fast-agent")).toMatchObject({
      status: "launchable",
      distribution: "uvx",
      agent: {
        launch: {
          command: "uvx",
          args: ["fast-agent-acp==0.9.9", "-x"]
        }
      }
    });
  });

  it("does not silently launch registry environment overlays", () => {
    const index = registry({
      id: "flagged-agent",
      name: "Flagged Agent",
      version: "1.0.0",
      description: "Requires an environment overlay",
      distribution: {
        npx: {
          package: "flagged-agent@1.0.0",
          env: { NODE_OPTIONS: "--require ./inject.js" }
        }
      }
    });

    expect(resolveAcpRegistryAgent(index, "flagged-agent")).toMatchObject({
      status: "needs_setup",
      registryId: "flagged-agent",
      reason: expect.stringMatching(/environment/iu)
    });
  });

  it("falls through to another safe package distribution", () => {
    const index = registry({
      id: "portable-agent",
      name: "Portable Agent",
      version: "1.2.3",
      description: "Offers multiple package launchers",
      distribution: {
        npx: {
          package: "portable-agent@1.2.3",
          env: { NODE_OPTIONS: "--require ./inject.js" }
        },
        uvx: { package: "portable-agent==1.2.3", args: ["acp"] }
      }
    });

    expect(resolveAcpRegistryAgent(index, "portable-agent")).toMatchObject({
      status: "launchable",
      distribution: "uvx",
      agent: { launch: { command: "uvx", args: ["portable-agent==1.2.3", "acp"] } }
    });
  });

  it.each(["floating-agent@latest", "floating-agent@^1.2.3", "floating-agent@1.x"])(
    "keeps non-exact package specifiers in needs setup: %s",
    (packageSpec) => {
      const index = registry({
        id: "floating-agent",
        name: "Floating Agent",
        version: "1.2.3",
        description: "Uses a floating npm version",
        distribution: { npx: { package: packageSpec } }
      });

      expect(resolveAcpRegistryAgent(index, "floating-agent")).toMatchObject({
        status: "needs_setup",
        distribution: "npx",
        reason: expect.stringMatching(/not pinned/iu)
      });
    }
  );

  it("selects the current binary target but keeps installation fail-closed", () => {
    const index = registry({
      id: "binary-agent",
      name: "Binary Agent",
      version: "2.0.0",
      description: "Binary ACP agent",
      distribution: {
        binary: {
          "darwin-aarch64": {
            archive: "https://example.test/binary-agent.tar.gz",
            sha256: "a".repeat(64),
            cmd: "./binary-agent",
            args: ["acp"]
          }
        }
      }
    });

    expect(resolveAcpRegistryAgent(index, "binary-agent", { platform: "darwin", arch: "arm64" })).toEqual({
      status: "needs_setup",
      registryId: "binary-agent",
      label: "Binary Agent",
      version: "2.0.0",
      distribution: "binary",
      reason: "Binary ACP distributions must be materialized and checksum-verified before launch.",
      binary: {
        platform: "darwin-aarch64",
        archive: "https://example.test/binary-agent.tar.gz",
        sha256: "a".repeat(64),
        cmd: "./binary-agent",
        args: ["acp"]
      }
    });
  });

  it("rejects duplicate ids and unsupported registry major versions", () => {
    const agent = {
      id: "duplicate",
      name: "Duplicate",
      version: "1.0.0",
      description: "Duplicate entry",
      distribution: { npx: { package: "duplicate@1.0.0" } }
    };

    expect(() => parseAcpRegistry({ version: "1.0.0", agents: [agent, agent] })).toThrow(/duplicate/iu);
    expect(() => parseAcpRegistry({ version: "2.0.0", agents: [agent] })).toThrow(/major version/iu);
  });

  it("allows stable executor aliases without changing registry metadata", () => {
    const index = registry({
      id: "codex-acp",
      name: "Codex",
      version: "1.1.2",
      description: "Codex ACP adapter",
      distribution: { npx: { package: "@agentclientprotocol/codex-acp@1.1.2" } }
    });

    expect(resolveAcpRegistryAgent(index, "codex-acp", { executorId: "codex" })).toMatchObject({
      registryId: "codex-acp",
      agent: { id: "codex" }
    });
  });
});
