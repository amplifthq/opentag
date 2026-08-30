import type { OpenTagChannelPresentationCommand } from "@opentag/core";
import type { DeliveryIntentV2 } from "@opentag/delivery-contract";
import { describe, expect, it } from "vitest";
import {
  executeSourceThreadCommand,
  SourceAppRegistry,
  type SourceAppDefinition
} from "../src/index.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function fakeSourceApp(input: {
  appId?: string;
  bindingDigest?: string;
  credentialGeneration?: number;
  appInstanceId?: string;
  organizationId?: string;
  responseId?: string;
} = {}): SourceAppDefinition<unknown, { text: string }, { text: string }> {
  return {
    appId: input.appId ?? "chat",
    protocol: "opentag.channel.v1",
    capabilities: {
      threads: true,
      messageUpdate: true,
      reactions: false,
      interactiveActions: true,
      attachments: "metadata",
      authenticatedDeletion: false,
      stableSourceVersions: true
    },
    installation: {
      organizationId: input.organizationId ?? "org_1",
      appInstanceId: input.appInstanceId ?? "chat_installation_1",
      bindingDigest: input.bindingDigest ?? digest("a"),
      credentialGeneration: input.credentialGeneration ?? 3,
      credentialGenerationDigest: digest("b")
    },
    ingress: {
      async verify() {
        return { kind: "mention" };
      },
      normalize() {
        return {
          protocol: "opentag.channel.v1",
          eventId: "event_1",
          occurredAt: "2026-08-28T00:00:00.000Z",
          trigger: "mention",
          source: {
            kind: "channel_message",
            channel: { provider: "chat", id: "C1" },
            thread: { provider: "chat", id: "T1" },
            actor: { provider: "chat", id: "U1" }
          },
          attachments: [],
          replyTarget: {
            channel: { provider: "chat", id: "C1" },
            thread: { provider: "chat", id: "T1" }
          }
        };
      }
    },
    context: {
      async readThread({ maxMessages, maxDecodedBytes }) {
        return { messages: [maxMessages, maxDecodedBytes], truncated: false, decodedBytes: 8 };
      }
    },
    presentation: {
      render(command) {
        return { text: command.presentation.kind };
      }
    },
    delivery: {
      prepare(command) {
        return { text: command.presentation.kind };
      },
      async deliver() {
        return { outcome: "accepted", evidenceDigest: digest("c"),
          externalResourceId: input.responseId ?? "message_1",
          externalResourceDigest: digest("e") };
      },
      async reconcile() {
        return { outcome: "accepted", evidenceDigest: digest("c"),
          externalResourceId: input.responseId ?? "message_1",
          externalResourceDigest: digest("e") };
      }
    }
  };
}

function presentationCommand(): OpenTagChannelPresentationCommand {
  return {
    protocol: "opentag.channel.v1",
    commandId: "presentation_1",
    replyTarget: {
      channel: { provider: "chat", id: "C1" },
      thread: { provider: "chat", id: "T1" }
    },
    operation: "reply",
    presentation: { kind: "final_summary", outcome: "success", summary: "Finished." }
  } as OpenTagChannelPresentationCommand;
}

describe("SourceAppRegistry", () => {
  it("registers multiple installations for one app and replays an exact duplicate", () => {
    const registry = new SourceAppRegistry();
    registry.register(fakeSourceApp({ appId: "slack" }));
    registry.register(fakeSourceApp({ appId: "slack", appInstanceId: "chat_installation_2" }));
    expect(() => registry.register(fakeSourceApp({ appId: "slack" }))).not.toThrow();
    expect(registry.resolve("slack")).toBeUndefined();
    expect(registry.resolveDelivery({ organizationId: "org_1", appId: "slack",
      appInstanceId: "chat_installation_2",
      bindingDigest: digest("a"), credentialGeneration: 3,
      credentialGenerationDigest: digest("b") })).toBeDefined();
  });

  it("isolates identical app installations and closures by organization", async () => {
    const registry = new SourceAppRegistry()
      .register(fakeSourceApp({ appId: "slack", organizationId: "org_a", responseId: "message_a" }))
      .register(fakeSourceApp({ appId: "slack", organizationId: "org_b", responseId: "message_b" }));
    for (const [organizationId, externalResourceId] of [["org_a", "message_a"], ["org_b", "message_b"]]) {
      const app = registry.resolveDelivery({ organizationId, appId: "slack",
        appInstanceId: "chat_installation_1", bindingDigest: digest("a"),
        credentialGeneration: 3, credentialGenerationDigest: digest("b") });
      await expect(app!.delivery.deliver({ request: { text: "hello" }, intent: {} as DeliveryIntentV2 }))
        .resolves.toMatchObject({ externalResourceId });
    }
  });

  it("atomically replaces only a monotonic installation generation", () => {
    const registry = new SourceAppRegistry().register(fakeSourceApp({ appId: "slack",
      organizationId: "org_a", credentialGeneration: 3, responseId: "message_v3" }));
    expect(() => registry.register(fakeSourceApp({ appId: "slack", organizationId: "org_a",
      credentialGeneration: 2 }))).toThrow(/generation downgrade/u);
    expect(() => registry.register(fakeSourceApp({ appId: "slack", organizationId: "org_a",
      credentialGeneration: 3, bindingDigest: digest("d") }))).toThrow(/equal generation mismatch/u);
    registry.register(fakeSourceApp({ appId: "slack", organizationId: "org_a",
      credentialGeneration: 4, bindingDigest: digest("d"), responseId: "message_v4" }));
    expect(registry.resolveDelivery({ organizationId: "org_a", appId: "slack",
      appInstanceId: "chat_installation_1", bindingDigest: digest("d"), credentialGeneration: 4,
      credentialGenerationDigest: digest("b") })).toBeDefined();
    expect(registry.resolveDelivery({ organizationId: "org_a", appId: "slack",
      appInstanceId: "chat_installation_1", bindingDigest: digest("a"), credentialGeneration: 3,
      credentialGenerationDigest: digest("b") })).toBeUndefined();
  });

  it("atomically replaces a complete app snapshot and evicts absent identities", () => {
    const registry = new SourceAppRegistry()
      .register(fakeSourceApp({ appId: "slack", organizationId: "org_a", responseId: "a-v3" }))
      .register(fakeSourceApp({ appId: "slack", organizationId: "org_b", responseId: "b-v3" }));
    expect(() => registry.replaceAppSnapshot("slack", [fakeSourceApp({ appId: "slack",
      organizationId: "org_a", credentialGeneration: 2 })])).toThrow(/generation downgrade/u);
    expect(registry.resolveDelivery({ organizationId: "org_b", appId: "slack",
      appInstanceId: "chat_installation_1", bindingDigest: digest("a"), credentialGeneration: 3,
      credentialGenerationDigest: digest("b") })).toBeDefined();
    registry.replaceAppSnapshot("slack", [fakeSourceApp({ appId: "slack",
      organizationId: "org_a", credentialGeneration: 4, bindingDigest: digest("d") })]);
    expect(registry.resolveDelivery({ organizationId: "org_b", appId: "slack",
      appInstanceId: "chat_installation_1", bindingDigest: digest("a"), credentialGeneration: 3,
      credentialGenerationDigest: digest("b") })).toBeUndefined();
  });

  it("retains non-secret generation high-water after snapshot eviction", () => {
    const registry = new SourceAppRegistry().register(fakeSourceApp({ appId: "slack",
      organizationId: "org_a", credentialGeneration: 3, responseId: "v3" }));
    registry.replaceAppSnapshot("slack", []);

    expect(() => registry.replaceAppSnapshot("slack", [fakeSourceApp({ appId: "slack",
      organizationId: "org_a", credentialGeneration: 2 })])).toThrow(/generation downgrade/u);
    expect(() => registry.replaceAppSnapshot("slack", [fakeSourceApp({ appId: "slack",
      organizationId: "org_a", credentialGeneration: 3, bindingDigest: digest("d") })]))
      .toThrow(/equal generation mismatch/u);
    expect(() => registry.replaceAppSnapshot("slack", [fakeSourceApp({ appId: "slack",
      organizationId: "org_a", credentialGeneration: 3 })])).not.toThrow();
    registry.replaceAppSnapshot("slack", []);
    expect(() => registry.replaceAppSnapshot("slack", [fakeSourceApp({ appId: "slack",
      organizationId: "org_a", credentialGeneration: 4, bindingDigest: digest("d") })]))
      .not.toThrow();
  });

  it("uses one registry entry for inbound context, presentation, and delivery", async () => {
    const registry = new SourceAppRegistry();
    registry.register(fakeSourceApp({ appId: "second-app" }));

    const app = registry.resolve("second-app");
    expect(app).toBeDefined();
    const verified = await app!.ingress.verify({
      rawBody: new Uint8Array([1, 2, 3]),
      headers: new Headers(),
      receivedAt: "2026-08-28T00:00:00.000Z"
    });
    const normalized = app!.ingress.normalize(verified);
    expect(normalized?.trigger).toBe("mention");
    expect(await app!.context.readThread({
      replyTarget: normalized!.replyTarget,
      maxMessages: 20,
      maxDecodedBytes: 65536,
      sourceMessageId: "message_1"
    })).toEqual({ messages: [20, 65536], truncated: false, decodedBytes: 8 });

    const command = {
      protocol: "opentag.channel.v1",
      commandId: "presentation_1",
      replyTarget: normalized!.replyTarget,
      operation: "reply",
      presentation: { kind: "final_summary", outcome: "success", summary: "Finished." }
    } as OpenTagChannelPresentationCommand;
    expect(app!.presentation.render(command)).toEqual({ text: "final_summary" });
    const request = app!.delivery.prepare(command);
    expect(request).toEqual({ text: "final_summary" });
    expect(await app!.delivery.deliver({ request, intent: {} as DeliveryIntentV2 }))
      .toEqual({ outcome: "accepted", evidenceDigest: digest("c"), externalResourceId: "message_1",
        externalResourceDigest: digest("e") });
  });

  it("rejects delivery resolution when installation authority drifts", () => {
    const registry = new SourceAppRegistry();
    registry.register(fakeSourceApp({ appId: "chat" }));

    expect(registry.resolveDelivery({
      organizationId: "org_1",
      appId: "chat",
      appInstanceId: "chat_installation_1",
      bindingDigest: digest("d"),
      credentialGeneration: 3,
      credentialGenerationDigest: digest("b")
    })).toBeUndefined();
    expect(registry.resolveDelivery({
      organizationId: "org_1",
      appId: "chat",
      appInstanceId: "chat_installation_1",
      bindingDigest: digest("a"),
      credentialGeneration: 4,
      credentialGenerationDigest: digest("b")
    })).toBeUndefined();
  });

  it("snapshots authority, capabilities, and ports away from caller-owned mutation", async () => {
    const registry = new SourceAppRegistry();
    const callerOwned = fakeSourceApp({ appId: "chat" });
    registry.register(callerOwned);

    callerOwned.installation.bindingDigest = digest("d");
    callerOwned.installation.credentialGeneration = 99;
    callerOwned.capabilities.interactiveActions = false;
    callerOwned.ingress.verify = async () => ({ kind: "mutated" });
    callerOwned.ingress.normalize = () => null;
    callerOwned.context.readThread = async () => ({ messages: ["mutated"], truncated: true, decodedBytes: 999 });
    callerOwned.presentation.render = () => ({ text: "mutated" });
    callerOwned.delivery.prepare = () => ({ text: "mutated" });
    callerOwned.delivery.deliver = async () => ({ outcome: "rejected", evidenceDigest: digest("d") });
    callerOwned.delivery.reconcile = async () => ({ outcome: "rejected", evidenceDigest: digest("d") });

    const registered = registry.resolveDelivery({
      organizationId: "org_1",
      appId: "chat",
      appInstanceId: "chat_installation_1",
      bindingDigest: digest("a"),
      credentialGeneration: 3,
      credentialGenerationDigest: digest("b")
    });
    expect(registered).toBeDefined();
    expect(registered!.capabilities.interactiveActions).toBe(true);
    await expect(executeSourceThreadCommand({
      adapter: registered!,
      authority: {
        async status() { return { outcome: "completed" }; },
        async cancel() { return { outcome: "completed" }; },
        async approve(command) { return { outcome: "completed", value: command.requestId }; },
        async reject() { return { outcome: "completed" }; },
        async bind() { return { outcome: "completed" }; },
        async unbind() { return { outcome: "completed" }; }
      },
      command: {
        type: "approve",
        commandId: "command_1",
        actor: { provider: "chat", id: "U1" },
        requestId: "approval_1",
        decision: "allow_once"
      }
    })).resolves.toEqual({ outcome: "completed", value: "approval_1" });

    const verified = await registered!.ingress.verify({
      rawBody: new Uint8Array([1]),
      headers: new Headers(),
      receivedAt: "2026-08-28T00:00:00.000Z"
    });
    const normalized = registered!.ingress.normalize(verified);
    expect(normalized?.trigger).toBe("mention");
    expect(await registered!.context.readThread({
      replyTarget: normalized!.replyTarget,
      maxMessages: 20,
      maxDecodedBytes: 65536,
      sourceMessageId: "message_1"
    })).toEqual({ messages: [20, 65536], truncated: false, decodedBytes: 8 });
    const command = presentationCommand();
    expect(registered!.presentation.render(command)).toEqual({ text: "final_summary" });
    const request = registered!.delivery.prepare(command);
    expect(request).toEqual({ text: "final_summary" });
    await expect(registered!.delivery.deliver({ request, intent: {} as DeliveryIntentV2 }))
      .resolves.toEqual({ outcome: "accepted", evidenceDigest: digest("c"), externalResourceId: "message_1",
        externalResourceDigest: digest("e") });
    await expect(registered!.delivery.reconcile({ request, intent: {} as DeliveryIntentV2 }))
      .resolves.toEqual({ outcome: "accepted", evidenceDigest: digest("c"), externalResourceId: "message_1",
        externalResourceDigest: digest("e") });
  });

  it("does not expose mutable registry authority or port records", () => {
    const registry = new SourceAppRegistry();
    registry.register(fakeSourceApp({ appId: "chat" }));
    const registered = registry.resolve("chat")!;

    expect(() => { registered.installation.bindingDigest = digest("d"); }).toThrow(TypeError);
    expect(() => { registered.capabilities.interactiveActions = false; }).toThrow(TypeError);
    expect(() => { registered.delivery.deliver = async () => ({ outcome: "rejected", evidenceDigest: digest("d") }); })
      .toThrow(TypeError);
    expect(registry.resolveDelivery({
      organizationId: "org_1",
      appId: "chat",
      appInstanceId: "chat_installation_1",
      bindingDigest: digest("a"),
      credentialGeneration: 3,
      credentialGenerationDigest: digest("b")
    })).toBe(registered);
  });

  it.each([
    ["ingress.verify", "ingress", "verify"],
    ["ingress.normalize", "ingress", "normalize"],
    ["context.readThread", "context", "readThread"],
    ["presentation.render", "presentation", "render"],
    ["delivery.prepare", "delivery", "prepare"],
    ["delivery.deliver", "delivery", "deliver"],
    ["delivery.reconcile", "delivery", "reconcile"]
  ] as const)("rejects a missing %s port before reserving the App id", (label, group, member) => {
    const registry = new SourceAppRegistry();
    const malformed = fakeSourceApp({ appId: "malformed" }) as unknown as Record<string, unknown>;
    const malformedGroup = { ...(malformed[group] as Record<string, unknown>) };
    delete malformedGroup[member];
    malformed[group] = malformedGroup;

    expect(() => registry.register(malformed as unknown as SourceAppDefinition<unknown, unknown, unknown>))
      .toThrow(`Source App ${label} must be a function.`);
    expect(() => registry.register(fakeSourceApp({ appId: "malformed" }))).not.toThrow();
  });

  it.each([
    ["ingress.verify", "ingress", "verify"],
    ["ingress.normalize", "ingress", "normalize"],
    ["context.readThread", "context", "readThread"],
    ["presentation.render", "presentation", "render"],
    ["delivery.prepare", "delivery", "prepare"],
    ["delivery.deliver", "delivery", "deliver"],
    ["delivery.reconcile", "delivery", "reconcile"]
  ] as const)("rejects a non-function %s port before reserving the App id", (label, group, member) => {
    const registry = new SourceAppRegistry();
    const malformed = fakeSourceApp({ appId: "malformed" }) as unknown as Record<string, unknown>;
    malformed[group] = { ...(malformed[group] as Record<string, unknown>), [member]: "not callable" };

    expect(() => registry.register(malformed as unknown as SourceAppDefinition<unknown, unknown, unknown>))
      .toThrow(`Source App ${label} must be a function.`);
    expect(() => registry.register(fakeSourceApp({ appId: "malformed" }))).not.toThrow();
  });
});
