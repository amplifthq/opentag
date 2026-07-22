import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { createTeamsAuthenticator } from "../src/auth.js";

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
      res.end(
        JSON.stringify({
          issuer: ISSUER,
          jwks_uri: `${baseUrl}/keys`,
          id_token_signing_alg_values_supported: ["RS256"]
        })
      );
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

async function setup(endorsements: string[] | null = ["msteams"]) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  if (endorsements !== null) {
    (jwk as JWK & { endorsements?: string[] }).endorsements = endorsements;
  }
  const openIdMetadataUrl = await startOpenIdServer(jwk);
  async function mint(
    claims: Record<string, unknown>,
    issuer: string = ISSUER,
    expirationTime: string | number = "5m"
  ) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setExpirationTime(expirationTime)
      .sign(privateKey);
  }
  return { openIdMetadataUrl, mint };
}

function verifyInput(token: string, overrides: { serviceUrl?: string; channelId?: string } = {}) {
  return {
    authorizationHeader: `Bearer ${token}`,
    activity: {
      type: "message",
      channelId: overrides.channelId ?? "msteams",
      serviceUrl: overrides.serviceUrl ?? SERVICE_URL
    }
  };
}

describe("teams inbound JWT authentication", () => {
  it("accepts a token whose audience is our appId, serviceUrl matches, and key endorses Teams", async () => {
    const { openIdMetadataUrl, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl });
    const token = await mint({ aud: "app-123", serviceurl: SERVICE_URL });
    const result = await auth.verify(verifyInput(token));
    expect(result.ok).toBe(true);
  });

  it("rejects a token whose audience is a different app", async () => {
    const { openIdMetadataUrl, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl });
    const token = await mint({ aud: "someone-else", serviceurl: SERVICE_URL });
    const result = await auth.verify(verifyInput(token));
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/audience|invalid_token/i) });
  });

  it("rejects when the token serviceUrl claim does not match the body serviceUrl", async () => {
    const { openIdMetadataUrl, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl });
    const token = await mint({ aud: "app-123", serviceurl: "https://evil/" });
    const result = await auth.verify(verifyInput(token));
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/serviceUrl/i) });
  });

  it("rejects a valid Bot Framework token that omits the serviceUrl claim", async () => {
    const { openIdMetadataUrl, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl });
    const token = await mint({ aud: "app-123" });
    const result = await auth.verify(verifyInput(token));
    expect(result).toEqual({ ok: false, reason: "serviceUrl_mismatch" });
  });

  it("rejects a token whose signing key is not endorsed for Teams", async () => {
    const { openIdMetadataUrl, mint } = await setup(["webchat"]);
    const auth = createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl });
    const token = await mint({ aud: "app-123", serviceurl: SERVICE_URL });
    const result = await auth.verify(verifyInput(token));
    expect(result).toEqual({ ok: false, reason: "endorsement_missing" });
  });

  it("rejects a token whose signing key has no endorsement metadata", async () => {
    const { openIdMetadataUrl, mint } = await setup(null);
    const auth = createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl });
    const token = await mint({ aud: "app-123", serviceurl: SERVICE_URL });
    const result = await auth.verify(verifyInput(token));
    expect(result).toEqual({ ok: false, reason: "endorsement_missing" });
  });

  it("rejects a request whose Activity channelId is not Teams", async () => {
    const { openIdMetadataUrl, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl });
    const token = await mint({ aud: "app-123", serviceurl: SERVICE_URL });
    const result = await auth.verify(verifyInput(token, { channelId: "webchat" }));
    expect(result).toEqual({ ok: false, reason: "channel_unsupported" });
  });

  it("rejects a token signed with an unexpected algorithm", async () => {
    const { openIdMetadataUrl } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl });
    const token = await new SignJWT({ aud: "app-123", serviceurl: SERVICE_URL })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("shared-secret"));
    const result = await auth.verify(verifyInput(token));
    expect(result.ok).toBe(false);
  });

  it("rejects a token minted with a different issuer", async () => {
    const { openIdMetadataUrl, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl });
    const token = await mint({ aud: "app-123", serviceurl: SERVICE_URL }, "https://evil.example");
    const result = await auth.verify(verifyInput(token));
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/issuer|invalid_token/i) });
  });

  it("rejects a token whose signature does not match the advertised key", async () => {
    const { openIdMetadataUrl } = await setup();
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ aud: "app-123", serviceurl: SERVICE_URL })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setExpirationTime("5m")
      .sign(privateKey);
    const result = await createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl }).verify(verifyInput(token));
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("does not let an injected authenticator bypass the built-in signature verification", async () => {
    const { openIdMetadataUrl } = await setup();
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ aud: "app-123", serviceurl: SERVICE_URL })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setExpirationTime("5m")
      .sign(privateKey);
    const result = await createTeamsAuthenticator({
      appId: "app-123",
      openIdMetadataUrl,
      botFrameworkAuthentication: { authenticateRequest: async () => ({}) }
    }).verify(verifyInput(token));
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects expired tokens beyond the five-minute clock tolerance", async () => {
    const { openIdMetadataUrl, mint } = await setup();
    const token = await mint({ aud: "app-123", serviceurl: SERVICE_URL }, ISSUER, "-10m");
    const result = await createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl }).verify(verifyInput(token));
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects tokens without an expiration claim", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "missing-exp-key";
    jwk.alg = "RS256";
    (jwk as JWK & { endorsements?: string[] }).endorsements = ["msteams"];
    const metadataUrl = await startOpenIdServer(jwk);
    const token = await new SignJWT({ aud: "app-123", serviceurl: SERVICE_URL })
      .setProtectedHeader({ alg: "RS256", kid: "missing-exp-key" })
      .setIssuer(ISSUER)
      .sign(privateKey);
    const result = await createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl: metadataUrl }).verify(
      verifyInput(token)
    );
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects tokens that are not valid for more than the five-minute clock tolerance", async () => {
    const { openIdMetadataUrl, mint } = await setup();
    const token = await mint({
      aud: "app-123",
      serviceurl: SERVICE_URL,
      nbf: Math.floor(Date.now() / 1000) + 10 * 60
    });
    const result = await createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl }).verify(verifyInput(token));
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects a missing Authorization header", async () => {
    const { openIdMetadataUrl } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", openIdMetadataUrl });
    const result = await auth.verify({ authorizationHeader: undefined, activity: { channelId: "msteams", serviceUrl: SERVICE_URL } });
    expect(result.ok).toBe(false);
  });
});
