import { describe, expect, it, vi } from "vitest";
import { createTeamsCallbackSink } from "../src/callbacks.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const threadKey = "https://smba.example.com|19:conv@thread.tacv2|act-1";
const uri = "https://smba.example.com";

describe("createTeamsCallbackSink", () => {
  it("posts the first message then edits the same activity for later updates", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return jsonResponse({ access_token: "tok", expires_in: 3600 });
      if (init?.method === "POST") return jsonResponse({ id: "reply-1" }, 201);
      if (init?.method === "PUT") return jsonResponse({}, 200);
      return jsonResponse({}, 200);
    });
    const sink = createTeamsCallbackSink({ appId: "app", appPassword: "s", fetchImpl: fetchImpl as unknown as typeof fetch });

    await sink.deliver({
      runId: "run_1",
      kind: "acknowledgement",
      provider: "teams",
      uri,
      threadKey,
      body: "Received. OpenTag is working.\nRun: run_1"
    });
    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "teams",
      uri,
      threadKey,
      body: "Finished with success.\n\ndone"
    });

    const connectorCalls = fetchImpl.mock.calls.filter(([callUrl]) => String(callUrl).includes("/v3/conversations/"));
    expect(connectorCalls).toHaveLength(2);
    expect(connectorCalls[0]?.[1]?.method).toBe("POST");
    expect(connectorCalls[1]?.[1]?.method).toBe("PUT");
    expect(String(connectorCalls[1]?.[0])).toContain("/activities/reply-1");
  });

  it("surfaces a non-2xx connector response as an error", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/oauth2/")) return jsonResponse({ access_token: "tok", expires_in: 3600 });
      return new Response("forbidden", { status: 403 });
    });
    const sink = createTeamsCallbackSink({ appId: "app", appPassword: "s", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      sink.deliver({ runId: "run_x", kind: "acknowledgement", provider: "teams", uri, threadKey, body: "ack" })
    ).rejects.toThrow(/403/);
  });

  it("keeps delivering later updates after an earlier one fails in the chain", async () => {
    let connectorCalls = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return jsonResponse({ access_token: "tok", expires_in: 3600 });
      connectorCalls += 1;
      if (connectorCalls === 1) return new Response("boom", { status: 500 });
      return jsonResponse({ id: "reply-2" }, 201);
    });
    const sink = createTeamsCallbackSink({ appId: "app", appPassword: "s", fetchImpl: fetchImpl as unknown as typeof fetch });

    // Start the second delivery before the first settles so it chains onto the failing one.
    const first = sink.deliver({ runId: "run_2", kind: "progress", provider: "teams", uri, threadKey, body: "first" });
    const second = sink.deliver({ runId: "run_2", kind: "final", provider: "teams", uri, threadKey, body: "second" });
    await Promise.allSettled([first, second]);

    expect(connectorCalls).toBe(2);
  });

  it("ignores non-Teams callback messages", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not call fetch");
    });
    const sink = createTeamsCallbackSink({ appId: "app", appPassword: "s", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      sink.deliver({ runId: "run_3", kind: "final", provider: "discord", uri, body: "done" })
    ).resolves.toBeUndefined();
  });

  it("does nothing when credentials are not configured", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not call fetch");
    });
    const sink = createTeamsCallbackSink({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      sink.deliver({ runId: "run_4", kind: "acknowledgement", provider: "teams", uri, threadKey, body: "ack" })
    ).resolves.toBeUndefined();
  });
});
