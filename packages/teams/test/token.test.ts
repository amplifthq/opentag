import { describe, expect, it, vi } from "vitest";
import { createTeamsTokenProvider } from "../src/token.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("teams outbound token provider", () => {
  it("requests a client-credentials token with the Bot Connector scope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "tok-1", expires_in: 3600 }));
    const provider = createTeamsTokenProvider({ appId: "app", appPassword: "secret", fetchImpl });
    const token = await provider.getToken();
    expect(token).toBe("tok-1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token");
    const body = new URLSearchParams((init as RequestInit).body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("app");
    expect(body.get("client_secret")).toBe("secret");
    expect(body.get("scope")).toBe("https://api.botframework.com/.default");
  });

  it("uses the tenant authority when a tenantId is configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "tok", expires_in: 3600 }));
    const provider = createTeamsTokenProvider({ appId: "app", appPassword: "secret", tenantId: "t1", fetchImpl });
    await provider.getToken();
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://login.microsoftonline.com/t1/oauth2/v2.0/token");
  });

  it("caches the token until near expiry", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "tok", expires_in: 3600 }));
    const provider = createTeamsTokenProvider({ appId: "a", appPassword: "s", fetchImpl, now: () => now });
    await provider.getToken();
    now = 1000 * 1000; // still within validity
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 3600 * 1000; // past refresh window
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-2xx token response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const provider = createTeamsTokenProvider({ appId: "a", appPassword: "s", fetchImpl });
    await expect(provider.getToken()).rejects.toThrow(/token request failed/i);
  });
});
