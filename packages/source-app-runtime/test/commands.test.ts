import { describe, expect, it } from "vitest";
import {
  executeSourceThreadCommand,
  type SourceAppDefinition,
  type SourceThreadCommandAuthorityPorts
} from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}`;

function fakeSourceApp(capabilities: { interactiveActions?: boolean; threads?: boolean } = {}) {
  return {
    appId: "chat",
    protocol: "opentag.channel.v1",
    capabilities: {
      threads: capabilities.threads ?? true,
      messageUpdate: true,
      reactions: false,
      interactiveActions: capabilities.interactiveActions ?? true,
      attachments: "metadata",
      authenticatedDeletion: false,
      stableSourceVersions: true
    },
    installation: {
      appInstanceId: "chat_installation_1",
      bindingDigest: digest,
      credentialGeneration: 1,
      credentialGenerationDigest: digest
    },
    ingress: { async verify() { return null; }, normalize() { return null; } },
    context: { async readThread() { return { messages: [], truncated: false, decodedBytes: 0 }; } },
    presentation: { render() { return {}; } },
    delivery: {
      prepare() { return {}; },
      async deliver() { return { outcome: "accepted" as const, evidenceDigest: digest }; },
      async reconcile() { return { outcome: "accepted" as const, evidenceDigest: digest }; }
    }
  } satisfies SourceAppDefinition<unknown, object, object>;
}

describe("executeSourceThreadCommand", () => {
  it("returns typed unsupported instead of silently emulating an operation", async () => {
    const result = await executeSourceThreadCommand({
      adapter: fakeSourceApp({ interactiveActions: false }),
      command: {
        type: "approve",
        commandId: "cmd_1",
        actor: { provider: "chat", id: "U1" },
        requestId: "approval_1"
      }
    });
    expect(result).toEqual({ outcome: "unsupported_capability", capability: "interactiveActions" });
  });

  it("routes a supported command through the injected authority port", async () => {
    const authority: SourceThreadCommandAuthorityPorts = {
      async status() { return { outcome: "completed", value: { state: "running" } }; },
      async cancel() { return { outcome: "completed" }; },
      async approve(command) { return { outcome: "completed", value: command.requestId }; },
      async reject() { return { outcome: "completed" }; },
      async bind() { return { outcome: "completed" }; },
      async unbind() { return { outcome: "completed" }; }
    };

    await expect(executeSourceThreadCommand({
      adapter: fakeSourceApp(),
      authority,
      command: {
        type: "approve",
        commandId: "cmd_2",
        actor: { provider: "chat", id: "U1" },
        requestId: "approval_2"
      }
    })).resolves.toEqual({ outcome: "completed", value: "approval_2" });
  });

  it("requires thread support before executing thread status", async () => {
    await expect(executeSourceThreadCommand({
      adapter: fakeSourceApp({ threads: false }),
      command: {
        type: "status",
        commandId: "cmd_3",
        actor: { provider: "chat", id: "U1" }
      }
    })).resolves.toEqual({ outcome: "unsupported_capability", capability: "threads" });
  });
});
