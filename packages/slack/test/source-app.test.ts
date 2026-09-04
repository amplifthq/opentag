import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { computeSlackSignature } from "../src/signature.js";
import { createSlackSourceApp } from "../src/source-app.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function app() {
  return createSlackSourceApp({
    installation: {
      organizationId: "org_test",
      appInstanceId: "A1", bindingDigest: digest("binding"),
      credentialGeneration: 2, credentialGenerationDigest: digest("generation")
    },
    signingSecret: "test-signing-secret",
    botUserId: "U_APP",
    clock: () => 1_700_000_000_000,
    resolveCredential: async () => "test-bot-token",
    fetchImpl: vi.fn(async () => new Response(JSON.stringify({ ok: true, ts: "1700000000.000200" }), {
      status: 200, headers: { "content-type": "application/json" }
    })) as typeof fetch
  });
}

const mention = (input: { ts?: string; threadTs?: string; eventId?: string } = {}) => ({
  type: "event_callback", team_id: "T1", api_app_id: "A1", event_id: input.eventId ?? "Ev1",
  event_time: 1_700_000_000, authorizations: [{ user_id: "U_APP" }],
  event: { type: "app_mention", user: "U1", text: "<@U_APP> fix this",
    ts: input.ts ?? "1700000000.000100", ...(input.threadTs ? { thread_ts: input.threadTs } : {}), channel: "C1" }
});

describe("Slack typed Source App", () => {
  it("normalizes only an explicit app mention", () => {
    const normalized = app().ingress.normalize(mention());
    expect(normalized?.trigger).toBe("mention");
    expect(normalized?.source.thread?.id).toBe("C1:1700000000.000100");
    expect(normalized?.source.messageId).toBe("1700000000.000100");
  });

  it("keeps thread root separate from the exact triggering message identity", () => {
    const normalized = app().ingress.normalize(mention({ ts: "1700000001.000200",
      threadTs: "1700000000.000100", eventId: "EvThreaded" }));
    expect(normalized).toMatchObject({ source: {
      thread: { id: "C1:1700000000.000100", parentMessageId: "1700000000.000100" },
      messageId: "1700000001.000200"
    } });
  });

  it("does not turn an ordinary channel message into ambient work", () => {
    expect(app().ingress.normalize({ ...mention(), event: {
      ...mention().event, type: "message", text: "please fix this"
    } })).toBeNull();
  });

  it("maps an authenticated message deletion to source withdrawal", async () => {
    const payload = {
      ...mention(), event_id: "EvDelete1", event_time: 1_699_999_999, event: {
        type: "message", subtype: "message_deleted", user: "USLACKBOT",
        channel: "C1", ts: "1700000001.000100",
        deleted_ts: "1700000000.000100"
      } };
    const rawBody = JSON.stringify(payload); const timestamp = "1700000000";
    const sourceApp = app();
    const trusted = await sourceApp.ingress.verify({ rawBody: new TextEncoder().encode(rawBody),
      headers: new Headers({ "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({ signingSecret: "test-signing-secret", timestamp, rawBody }) }),
      receivedAt: "2023-11-14T22:13:20.000Z" });
    const normalized = sourceApp.ingress.normalize(trusted);
    expect(normalized).toMatchObject({
      trigger: "source_content_deleted",
      occurredAt: "2023-11-14T22:13:19.000Z",
      verification: { verifiedAt: "2023-11-14T22:13:20.000Z" },
      source: { sourceVersionRef: "slack:T1:C1:1700000000.000100" }
    });
  });

  it("keeps deleted reply identity exact while retaining its original thread root", async () => {
    const payload = { ...mention(), event_id: "EvDeleteReply", event: { type: "message",
      subtype: "message_deleted", user: "USLACKBOT", channel: "C1", ts: "1700000002.1",
      deleted_ts: "1700000001.000200", previous_message: {
        ts: "1700000001.000200", thread_ts: "1700000000.000100" } } };
    const rawBody = JSON.stringify(payload); const timestamp = "1700000000";
    const sourceApp = app(); const trusted = await sourceApp.ingress.verify({
      rawBody: new TextEncoder().encode(rawBody), headers: new Headers({
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({ signingSecret: "test-signing-secret", timestamp, rawBody }) }),
      receivedAt: "2023-11-14T22:13:20.000Z" });
    expect(sourceApp.ingress.normalize(trusted)).toMatchObject({ source: {
      thread: { id: "C1:1700000000.000100", parentMessageId: "1700000000.000100" },
      messageId: "1700000001.000200",
      sourceVersionRef: "slack:T1:C1:1700000001.000200"
    } });
  });

  it("distinguishes malformed known events from genuinely unsupported events", () => {
    const sourceApp = app();
    expect(sourceApp.ingress.normalizeResult?.({ ...mention(), event: {
      type: "app_mention", user: "U1", text: "<@U_APP> fix", channel: "C1"
    } })).toEqual({ kind: "malformed", code: "slack_app_mention_malformed" });
    expect(sourceApp.ingress.normalizeResult?.({ ...mention(), event: {
      type: "message", subtype: "message_deleted", channel: "C1"
    } })).toEqual({ kind: "malformed", code: "slack_deletion_malformed" });
    expect(sourceApp.ingress.normalizeResult?.({ ...mention(), event: {
      type: "reaction_added", user: "U1", reaction: "eyes"
    } })).toEqual({ kind: "unsupported" });
  });

  it("rejects deletion normalization without HTTP signature verification", () => {
    expect(app().ingress.normalize({ ...mention(), event: { type: "message",
      subtype: "message_deleted", channel: "C1", deleted_ts: "1700000000.000100" } }))
      .toBeNull();
  });

  it("fails closed for stale or invalid Slack signatures", async () => {
    const rawBody = JSON.stringify(mention());
    await expect(app().ingress.verify({ rawBody: new TextEncoder().encode(rawBody),
      headers: new Headers({ "x-slack-request-timestamp": "1700000000",
        "x-slack-signature": "v0=invalid" }),
      receivedAt: "2023-11-14T22:13:20.000Z" })).rejects.toThrow("invalid_signature");
    await expect(app().ingress.verify({ rawBody: new TextEncoder().encode(rawBody),
      headers: new Headers({ "x-slack-request-timestamp": "1600000000",
        "x-slack-signature": computeSlackSignature({ signingSecret: "test-signing-secret",
          timestamp: "1600000000", rawBody }) }),
      receivedAt: "2023-11-14T22:13:20.000Z" })).rejects.toThrow("stale_signature_timestamp");
  });

  it("returns null for unsupported events", () => {
    expect(app().ingress.normalize({ ...mention(), event: {
      type: "reaction_added", user: "U1", reaction: "eyes", item: { type: "message" }
    } })).toBeNull();
  });
});
