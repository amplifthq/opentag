import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { createTeamsAuthenticator } from "../src/auth.js";
import { createTeamsWebhookApp } from "../src/webhook-app.js";

const ISSUER = "https://api.botframework.com";
const SERVICE_URL = "https://smba/";

const openServers: HttpServer[] = [];

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer));
});

async function startOpenIdServer(jwk: JWK): Promise<string> {
  let baseUrl = "";
  const server = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/openid") {
      res.end(JSON.stringify({ issuer: ISSUER, jwks_uri: `${baseUrl}/keys`, id_token_signing_alg_values_supported: ["RS256"] }));
      return;
    }
    if (req.url === "/keys") {
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  openServers.push(server);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  return `${baseUrl}/openid`;
}

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
    type: "message", id: "act-1", channelId: "msteams", text, serviceUrl: SERVICE_URL,
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

async function realAuth(overrides: { endorsements?: string[] | null; claims?: Record<string, unknown> } = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  if (overrides.endorsements !== null) {
    (jwk as JWK & { endorsements?: string[] }).endorsements = overrides.endorsements ?? ["msteams"];
  }
  const openIdMetadataUrl = await startOpenIdServer(jwk);
  const token = await new SignJWT({ aud: "app-123", serviceurl: SERVICE_URL, ...(overrides.claims ?? {}) })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setExpirationTime("5m")
    .sign(privateKey);
  return { authenticator: createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl }), token };
}

describe("teams webhook app", () => {
  it("returns 401 when authentication fails without side effects", async () => {
    const input = baseInput({ authenticator: { verify: vi.fn(async () => ({ ok: false as const, reason: "audience_mismatch" })) } });
    const res = await post(createTeamsWebhookApp(input), channelActivity("<at>OpenTag</at> apply 1"));
    expect(res.status).toBe(401);
    expect(input.resolveChannelBinding).not.toHaveBeenCalled();
    expect(input.createRun).not.toHaveBeenCalled();
    expect(input.submitThreadAction).not.toHaveBeenCalled();
    expect(input.notifyConversation).not.toHaveBeenCalled();
  });

  it("rejects missing serviceUrl claims before any outbound notice or run/action side effect", async () => {
    const { authenticator, token } = await realAuth({ claims: { serviceurl: undefined } });
    const input = baseInput({ authenticator });

    const res = await post(createTeamsWebhookApp(input), channelActivity("<at>OpenTag</at> investigate"), {
      authorization: `Bearer ${token}`
    });

    expect(res.status).toBe(401);
    expect(input.resolveChannelBinding).not.toHaveBeenCalled();
    expect(input.createRun).not.toHaveBeenCalled();
    expect(input.submitThreadAction).not.toHaveBeenCalled();
    expect(input.notifyConversation).not.toHaveBeenCalled();
  });

  it("rejects non-Teams-endorsed keys before any outbound notice or run/action side effect", async () => {
    const { authenticator, token } = await realAuth({ endorsements: ["webchat"] });
    const input = baseInput({ authenticator });

    const res = await post(createTeamsWebhookApp(input), channelActivity("<at>OpenTag</at> apply 1"), {
      authorization: `Bearer ${token}`
    });

    expect(res.status).toBe(401);
    expect(input.resolveChannelBinding).not.toHaveBeenCalled();
    expect(input.createRun).not.toHaveBeenCalled();
    expect(input.submitThreadAction).not.toHaveBeenCalled();
    expect(input.notifyConversation).not.toHaveBeenCalled();
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
