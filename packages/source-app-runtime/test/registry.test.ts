import type { OpenTagChannelPresentationCommand } from "@opentag/core";
import type { DeliveryIntentV2 } from "@opentag/delivery-contract";
import { describe, expect, it } from "vitest";
import { SourceAppRegistry, type SourceAppDefinition } from "../src/index.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function fakeSourceApp(input: {
  appId?: string;
  bindingDigest?: string;
  credentialGeneration?: number;
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
      appInstanceId: "chat_installation_1",
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
        return { outcome: "accepted", evidenceDigest: digest("c"), externalResourceId: "message_1" };
      },
      async reconcile() {
        return { outcome: "accepted", evidenceDigest: digest("c"), externalResourceId: "message_1" };
      }
    }
  };
}

describe("SourceAppRegistry", () => {
  it("registers one exact Source App and rejects a duplicate id", () => {
    const registry = new SourceAppRegistry();
    registry.register(fakeSourceApp({ appId: "slack" }));
    expect(() => registry.register(fakeSourceApp({ appId: "slack" })))
      .toThrow("Source App already registered: slack");
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
      maxDecodedBytes: 65536
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
      .toEqual({ outcome: "accepted", evidenceDigest: digest("c"), externalResourceId: "message_1" });
  });

  it("rejects delivery resolution when installation authority drifts", () => {
    const registry = new SourceAppRegistry();
    registry.register(fakeSourceApp({ appId: "chat" }));

    expect(registry.resolveDelivery({
      appId: "chat",
      appInstanceId: "chat_installation_1",
      bindingDigest: digest("d"),
      credentialGeneration: 3,
      credentialGenerationDigest: digest("b")
    })).toBeUndefined();
    expect(registry.resolveDelivery({
      appId: "chat",
      appInstanceId: "chat_installation_1",
      bindingDigest: digest("a"),
      credentialGeneration: 4,
      credentialGenerationDigest: digest("b")
    })).toBeUndefined();
  });
});
