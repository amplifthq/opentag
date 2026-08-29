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
        requestId: "approval_1",
        decision: "allow_once"
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
        requestId: "approval_2",
        decision: "allow_run"
      }
    })).resolves.toEqual({ outcome: "completed", value: "approval_2" });
  });

  it("preserves allow-once and allow-for-run as distinct approval decisions", async () => {
    const decisions: string[] = [];
    const authority: SourceThreadCommandAuthorityPorts = {
      async status() { return { outcome: "completed" }; }, async cancel() { return { outcome: "completed" }; },
      async approve(command) { decisions.push(command.decision); return { outcome: "completed" }; },
      async reject() { return { outcome: "completed" }; }, async bind() { return { outcome: "completed" }; },
      async unbind() { return { outcome: "completed" }; }
    };
    for (const decision of ["allow_once", "allow_run"] as const) {
      await executeSourceThreadCommand({ adapter: fakeSourceApp(), authority,
        command: { type: "approve", commandId: `cmd_${decision}`,
          actor: { provider: "slack", id: "U_APPROVER" }, requestId: "approval_1", decision } });
    }
    expect(decisions).toEqual(["allow_once", "allow_run"]);
  });

  it("preserves the exact server authority envelope and rejects undeclared widening", async () => {
    let observed: unknown;
    const authority: SourceThreadCommandAuthorityPorts = {
      async status() { return { outcome: "completed" }; }, async cancel() { return { outcome: "completed" }; },
      async approve(command) { observed = command.authority; return { outcome: "completed" }; },
      async reject() { return { outcome: "completed" }; }, async bind() { return { outcome: "completed" }; },
      async unbind() { return { outcome: "completed" }; }
    };
    const envelope = { organizationId: "org_1", installationId: "install_1", bindingId: "binding_1",
      sourceThreadId: "C1:1700000000.1", runId: "run_1", pendingRequestId: "permission_1",
      approvalEpoch: "epoch_1", actionDescriptorDigest: `sha256:${"a".repeat(64)}`,
      runnerId: "runner_1", attemptId: "attempt_1", attemptNumber: 1, attemptEpoch: 1,
      fencingTokenDigest: `sha256:${"e".repeat(64)}`,
      permissionRequestDigest: `sha256:${"f".repeat(64)}`, actionId: "pending_action_1",
      frozenCeilingDigest: `sha256:${"b".repeat(64)}`, policyDigest: `sha256:${"c".repeat(64)}`,
      actionTokenIdentity: `sha256:${"d".repeat(64)}`,
      selectedDecision: "allow_once" as const, allowedDecisions: ["allow_once" as const] };
    await executeSourceThreadCommand({ adapter: fakeSourceApp(), authority,
      command: { type: "approve", commandId: "cmd_envelope", actor: { provider: "slack", id: "U1" },
        requestId: "permission_1", decision: "allow_once", authority: envelope } });
    expect(observed).toEqual(envelope);
    await expect(executeSourceThreadCommand({ adapter: fakeSourceApp(), authority,
      command: { type: "approve", commandId: "cmd_widen", actor: { provider: "slack", id: "U1" },
        requestId: "permission_1", decision: "allow_once",
        authority: { ...envelope, publicationMode: "direct" } as any } }))
      .rejects.toThrow("Source Thread authority envelope");
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
