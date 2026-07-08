import { describe, expect, it, vi } from "vitest";
import { createTeamsWebhookApp } from "../src/webhook-app.js";

function baseInput(overrides: Partial<Parameters<typeof createTeamsWebhookApp>[0]> = {}) {
  return {
    authenticator: { verify: vi.fn(async () => ({ ok: true as const })) },
    resolveChannelBinding: vi.fn(async () => ({
      tenantId: "t1", teamId: "19:team", channelId: "19:chan",
      conversationId: "19:conv@thread.tacv2", owner: "acme", repo: "demo"
    })),
    createRun: vi.fn(async () => ({ runId: "run-1" })),
    submitThreadAction: vi.fn(async () => ({})),
    notifyConversation: vi.fn(async () => {}),
    now: () => "2026-07-07T00:00:00.000Z",
    ...overrides
  };
}

function channelActivity(text: string) {
  return {
    type: "message", id: "act-1", text, serviceUrl: "https://smba/",
    from: { id: "29:user", name: "Alice", aadObjectId: "aad-1" },
    recipient: { id: "28:bot", name: "OpenTag" },
    conversation: { id: "19:conv@thread.tacv2", conversationType: "channel", tenantId: "t1" },
    channelData: { tenant: { id: "t1" }, team: { id: "19:team" }, channel: { id: "19:chan" } },
    entities: [{ type: "mention", mentioned: { id: "28:bot" }, text: "<at>OpenTag</at>" }]
  };
}

async function post(app: ReturnType<typeof createTeamsWebhookApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/teams/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer x", ...headers },
    body: JSON.stringify(body)
  });
}

describe("teams webhook app", () => {
  it("returns 401 when authentication fails", async () => {
    const input = baseInput({ authenticator: { verify: vi.fn(async () => ({ ok: false as const, reason: "audience_mismatch" })) } });
    const res = await post(createTeamsWebhookApp(input), channelActivity("<at>OpenTag</at> investigate"));
    expect(res.status).toBe(401);
    expect(input.createRun).not.toHaveBeenCalled();
  });

  it("acknowledges a mention with 200 and creates a run", async () => {
    const input = baseInput();
    const res = await post(createTeamsWebhookApp(input), channelActivity("<at>OpenTag</at> investigate this"));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(input.createRun).toHaveBeenCalledTimes(1));
    const event = input.createRun.mock.calls[0][0];
    expect(event.source).toBe("teams");
    expect(event.id).toBe("evt_teams_act-1");
  });

  it("routes `apply N` to submitThreadAction using the root Teams thread activity id", async () => {
    const input = baseInput();
    const activity = channelActivity("<at>OpenTag</at> apply 1");
    activity.id = "reply-activity";
    activity.conversation.id = "19:conv@thread.tacv2;messageid=root-activity";
    const res = await post(createTeamsWebhookApp(input), activity);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(input.submitThreadAction).toHaveBeenCalledTimes(1));
    expect(input.submitThreadAction.mock.calls[0][0].callback.threadKey).toBe(
      "https://smba/|19:conv@thread.tacv2;messageid=root-activity|root-activity"
    );
    expect(input.createRun).not.toHaveBeenCalled();
  });

  it("ignores a non-mention message with 200 and no run", async () => {
    const input = baseInput();
    const activity = channelActivity("just chatting");
    (activity as any).entities = [];
    const res = await post(createTeamsWebhookApp(input), activity);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(input.createRun).not.toHaveBeenCalled();
  });

  it("notifies the conversation when it is unbound", async () => {
    const input = baseInput({ resolveChannelBinding: vi.fn(async () => null) });
    await post(createTeamsWebhookApp(input), channelActivity("<at>OpenTag</at> investigate"));
    await vi.waitFor(() => expect(input.notifyConversation).toHaveBeenCalledTimes(1));
    expect(input.createRun).not.toHaveBeenCalled();
  });

  it("returns 413 for an over-limit body", async () => {
    const input = baseInput();
    const big = { ...channelActivity("<at>OpenTag</at> x"), padding: "z".repeat(1_100_000) };
    const res = await post(createTeamsWebhookApp(input), big);
    expect(res.status).toBe(413);
  });
});
