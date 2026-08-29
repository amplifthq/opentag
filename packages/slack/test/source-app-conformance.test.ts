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

  it("does not emit client-authoritative JSON action values on the certified adapter", () => {
    const sourceApp = createSlackSourceApp({ installation: { appInstanceId: "A1",
      bindingDigest: digest("binding"), credentialGeneration: 1,
      credentialGenerationDigest: digest("generation") }, signingSecret: "secret",
      botUserId: "U_APP", resolveCredential: async () => "token",
      fetchImpl: vi.fn() as typeof fetch });
    const rendered = sourceApp.presentation.render({ protocol: "opentag.channel.v1",
      commandId: "presentation_1", replyTarget: { channel: { provider: "slack", id: "C1" },
        thread: { provider: "slack", id: "C1:1700000000.1" } }, operation: "reply",
      presentation: { kind: "approval_prompt", runId: "run_1", approvalId: "approval_1",
        proposalId: "proposal_1", intentId: "intent_1", actionId: "action_1",
        proposalHash: digest("proposal"), approvalEpoch: "epoch_1", title: "Approve?",
        summary: "Apply the exact frozen action", target: { provider: "github",
          operation: "create", resource: "pull_request" }, runScope: { runId: "run_1" },
        decisions: ["allow_once", "allow_run", "deny"] } } as any);
    expect(rendered.kind).toBe("message");
    expect(rendered.kind === "message" ? rendered.blocks?.some((block) => block.type === "actions") : true)
      .toBe(false);
  });

  it("paginates through the trigger, excludes later replies, and returns nearest twenty prior plus trigger", async () => {
    const history = Array.from({ length: 31 }, (_, index) => ({
      ts: `1700000000.${String(index).padStart(6, "0")}`, thread_ts: "1700000000.000100",
      text: `message-${index}`,
      files: [{ id: `F${index}`, name: "brief.txt", mimetype: "text/plain", url_private: "https://secret.invalid" }]
    }));
    const fetchImpl = vi.fn(async (urlInput: string | URL | Request) => {
      const url = new URL(String(urlInput)); const cursor = url.searchParams.get("cursor");
      const messages = cursor ? history.slice(15) : history.slice(0, 15);
      return new Response(JSON.stringify({ ok: true, messages,
        response_metadata: { next_cursor: cursor ? "" : "page-2" } }));
    }) as typeof fetch;
    const sourceApp = createSlackSourceApp({
      installation: { appInstanceId: "A1", bindingDigest: digest("binding"),
        credentialGeneration: 1, credentialGenerationDigest: digest("generation") },
      signingSecret: "secret", botUserId: "U_APP", resolveCredential: async () => "token",
      fetchImpl
    });
    const context = await sourceApp.context.readThread({
      replyTarget: { channel: { provider: "slack", workspace: "T1", id: "C1" },
        thread: { provider: "slack", id: "C1:1700000000.000100" } },
      sourceMessageId: "1700000000.000025", maxMessages: 20, maxDecodedBytes: 65536
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(context.messages).toHaveLength(21);
    expect(context.messages.map((message: any) => message.ts)).toEqual(
      history.slice(5, 26).map((message) => message.ts));
    expect(JSON.stringify(context.messages)).not.toContain("message-26");
    expect(context.decodedBytes).toBeLessThanOrEqual(65536);
    expect(JSON.stringify(context.messages)).not.toContain("url_private");
  });

  it("preserves the trigger under byte truncation and drops older context first", async () => {
    const messages = [{ ts: "1700000000.000100", text: "x".repeat(65_500) },
      { ts: "1700000000.000200", thread_ts: "1700000000.000100", text: "trigger" }];
    const sourceApp = createSlackSourceApp({ installation: { appInstanceId: "A1",
      bindingDigest: digest("binding"), credentialGeneration: 1,
      credentialGenerationDigest: digest("generation") }, signingSecret: "secret",
      botUserId: "U_APP", resolveCredential: async () => "token",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ ok: true, messages,
        response_metadata: { next_cursor: "" } }))) as typeof fetch });
    const context = await sourceApp.context.readThread({ replyTarget: {
      channel: { provider: "slack", id: "C1" },
      thread: { provider: "slack", id: "C1:1700000000.000100" } },
      sourceMessageId: "1700000000.000200", maxMessages: 20, maxDecodedBytes: 65536 });
    expect(context.messages).toEqual([{ ts: "1700000000.000200", text: "trigger" }]);
    expect(context.truncated).toBe(true);
  });
});
