import { describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { createTeamsAuthenticator } from "../src/auth.js";

const ISSUER = "https://api.botframework.com";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  const jwksClient: JWTVerifyGetKey = async () => publicKey;
  async function mint(claims: Record<string, unknown>, issuer: string = ISSUER) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setExpirationTime("5m")
      .sign(privateKey);
  }
  return { jwksClient, mint };
}

describe("teams inbound JWT authentication", () => {
  it("accepts a token whose audience is our appId and serviceUrl matches", async () => {
    const { jwksClient, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", jwksClient });
    const token = await mint({ aud: "app-123", serviceUrl: "https://smba/" });
    const result = await auth.verify({ authorizationHeader: `Bearer ${token}`, bodyServiceUrl: "https://smba/" });
    expect(result.ok).toBe(true);
  });

  it("rejects a token whose audience is a different app", async () => {
    const { jwksClient, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", jwksClient });
    const token = await mint({ aud: "someone-else", serviceUrl: "https://smba/" });
    const result = await auth.verify({ authorizationHeader: `Bearer ${token}`, bodyServiceUrl: "https://smba/" });
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/audience/i) });
  });

  it("rejects when the token serviceUrl claim does not match the body serviceUrl", async () => {
    const { jwksClient, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", jwksClient });
    const token = await mint({ aud: "app-123", serviceUrl: "https://evil/" });
    const result = await auth.verify({ authorizationHeader: `Bearer ${token}`, bodyServiceUrl: "https://smba/" });
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/serviceUrl/i) });
  });

  it("accepts a valid Bot Framework token that omits the optional serviceUrl claim", async () => {
    const { jwksClient, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", jwksClient });
    const token = await mint({ aud: "app-123" });
    const result = await auth.verify({ authorizationHeader: `Bearer ${token}`, bodyServiceUrl: "https://smba/" });
    expect(result.ok).toBe(true);
  });

  it("rejects a token minted with a different issuer", async () => {
    const { jwksClient, mint } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", jwksClient });
    const token = await mint({ aud: "app-123", serviceUrl: "https://smba/" }, "https://evil.example");
    const result = await auth.verify({ authorizationHeader: `Bearer ${token}`, bodyServiceUrl: "https://smba/" });
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/issuer/i) });
  });

  it("rejects a missing Authorization header", async () => {
    const { jwksClient } = await setup();
    const auth = createTeamsAuthenticator({ appId: "app-123", jwksClient });
    const result = await auth.verify({ authorizationHeader: undefined, bodyServiceUrl: "https://smba/" });
    expect(result.ok).toBe(false);
  });
});
