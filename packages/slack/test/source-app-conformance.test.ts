import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SourceAppRegistry } from "@opentag/source-app-runtime";
import { createSlackSourceApp } from "../src/source-app.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe("Slack Source App conformance", () => {
  it("uses one composite registry identity for ingress and delivery", () => {
    const sourceApp = createSlackSourceApp({
      installation: { appInstanceId: "A1", bindingDigest: digest("binding"),
        credentialGeneration: 4, credentialGenerationDigest: digest("generation") },
      signingSecret: "secret", botUserId: "U_APP",
      resolveCredential: async () => "token",
      fetchImpl: vi.fn() as typeof fetch
    });
    const registry = new SourceAppRegistry().register(sourceApp);
    expect(registry.resolveDelivery({ appId: "slack", ...sourceApp.installation })).toBeDefined();
    expect(registry.resolveDelivery({ appId: "slack", ...sourceApp.installation,
      credentialGeneration: 5 })).toBeUndefined();
  });

  it("bounds context to twenty prior same-thread messages and 64 KiB", async () => {
    const history = Array.from({ length: 25 }, (_, index) => ({
      ts: `1700000000.${String(index).padStart(6, "0")}`, thread_ts: "1700000000.000100",
      text: index === 0 ? "x".repeat(70_000) : `message-${index}`,
      files: [{ id: `F${index}`, name: "brief.txt", mimetype: "text/plain", url_private: "https://secret.invalid" }]
    }));
    const sourceApp = createSlackSourceApp({
      installation: { appInstanceId: "A1", bindingDigest: digest("binding"),
        credentialGeneration: 1, credentialGenerationDigest: digest("generation") },
      signingSecret: "secret", botUserId: "U_APP", resolveCredential: async () => "token",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ ok: true, messages: history }))) as typeof fetch
    });
    const context = await sourceApp.context.readThread({
      replyTarget: { channel: { provider: "slack", workspace: "T1", id: "C1" },
        thread: { provider: "slack", id: "C1:1700000000.000100" } },
      maxMessages: 20, maxDecodedBytes: 65536
    });
    expect(context.messages.length).toBeLessThanOrEqual(20);
    expect(context.decodedBytes).toBeLessThanOrEqual(65536);
    expect(JSON.stringify(context.messages)).not.toContain("url_private");
  });
});
