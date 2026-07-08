import { describe, expect, it, vi } from "vitest";
import { createTeamsConnector } from "../src/connector.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("teams connector", () => {
  it("POSTs a new activity and returns its id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "reply-1" }, 201));
    const connector = createTeamsConnector({ getToken: async () => "tok", fetchImpl });
    const result = await connector.postMessage({
      serviceUrl: "https://smba/",
      conversationId: "19:conv",
      text: "hello"
    });
    expect(result).toEqual({ activityId: "reply-1" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://smba/v3/conversations/19%3Aconv/activities");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect((init as any).headers.authorization).toBe("Bearer tok");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ type: "message", text: "hello" });
  });

  it("PUTs an update to an existing activity", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 200));
    const connector = createTeamsConnector({ getToken: async () => "tok", fetchImpl });
    await connector.updateMessage({ serviceUrl: "https://smba/", conversationId: "19:conv", activityId: "reply-1", text: "edited" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://smba/v3/conversations/19%3Aconv/activities/reply-1");
    expect((init as RequestInit).method).toBe("PUT");
  });

  it("throws on a non-2xx response (never a silent success)", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const connector = createTeamsConnector({ getToken: async () => "tok", fetchImpl });
    await expect(
      connector.postMessage({ serviceUrl: "https://smba/", conversationId: "19:conv", text: "x" })
    ).rejects.toThrow(/403/);
  });

  it("joins serviceUrl and path without a double slash", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "r" }, 200));
    const connector = createTeamsConnector({ getToken: async () => "tok", fetchImpl });
    await connector.postMessage({ serviceUrl: "https://smba/amer/", conversationId: "19:c", text: "x" });
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://smba/amer/v3/conversations/19%3Ac/activities");
  });

  it("handles serviceUrl without a trailing slash", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "reply-1" }, 200));
    const connector = createTeamsConnector({ getToken: async () => "tok", fetchImpl });
    await connector.postMessage({ serviceUrl: "https://smba", conversationId: "19:conv", text: "hello" });
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://smba/v3/conversations/19%3Aconv/activities");
  });

  it("throws when POST response is 2xx but has no activity id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 200));
    const connector = createTeamsConnector({ getToken: async () => "tok", fetchImpl });
    await expect(
      connector.postMessage({ serviceUrl: "https://smba/", conversationId: "19:conv", text: "hello" })
    ).rejects.toThrow(/missing a string activity id/);
  });
});
