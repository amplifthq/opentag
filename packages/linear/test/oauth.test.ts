import { describe, expect, it } from "vitest";
import {
  buildLinearOAuthAuthorizationUrl,
  createLinearClientCredentialsToken,
  exchangeLinearOAuthCode,
  fetchLinearViewerIdentity,
  fetchLinearWorkspaceIdentity,
  refreshLinearOAuthToken
} from "../src/oauth.js";

describe("Linear OAuth helpers", () => {
  it("builds an app-actor OAuth authorization URL with agent scopes", () => {
    const url = new URL(
      buildLinearOAuthAuthorizationUrl({
        clientId: "client_1",
        redirectUri: "https://relay.example/linear/oauth/callback",
        state: "state_1"
      })
    );

    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client_1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://relay.example/linear/oauth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("scope")).toContain("app:mentionable");
    expect(url.searchParams.get("scope")).toContain("app:assignable");
  });

  it("exchanges and refreshes OAuth tokens with form-encoded requests", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url, init) => {
      requests.push({ url: String(url), body: String(init?.body) });
      return Response.json({
        access_token: "access_1",
        refresh_token: "refresh_1",
        token_type: "Bearer",
        expires_in: 86399,
        scope: "read write"
      });
    }) as typeof fetch;

    await expect(
      exchangeLinearOAuthCode({
        clientId: "client_1",
        clientSecret: "secret_1",
        code: "code_1",
        redirectUri: "https://relay.example/callback",
        fetchImpl
      })
    ).resolves.toMatchObject({ accessToken: "access_1", refreshToken: "refresh_1", scope: ["read", "write"] });

    await refreshLinearOAuthToken({
      clientId: "client_1",
      clientSecret: "secret_1",
      refreshToken: "refresh_1",
      fetchImpl
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toContain("grant_type=authorization_code");
    expect(requests[1]?.body).toContain("grant_type=refresh_token");
  });

  it("creates client credentials app tokens and fetches the app viewer id", async () => {
    const requests: Array<{ url: string; body?: string; authorization?: string | null }> = [];
    const fetchImpl = (async (url, init) => {
      requests.push({
        url: String(url),
        ...(init?.body ? { body: String(init.body) } : {}),
        authorization: new Headers(init?.headers).get("authorization")
      });
      if (String(url).includes("/oauth/token")) {
        return Response.json({ access_token: "app_access", token_type: "Bearer", expires_in: 2591999, scope: "read write app:mentionable" });
      }
      return Response.json({ data: { viewer: { id: "app_user_1", name: "OpenTag", app: true } } });
    }) as typeof fetch;

    await expect(createLinearClientCredentialsToken({ clientId: "client_1", clientSecret: "secret_1", fetchImpl })).resolves.toMatchObject({
      accessToken: "app_access"
    });
    await expect(fetchLinearViewerIdentity({ token: "Bearer app_access", fetchImpl })).resolves.toMatchObject({ id: "app_user_1", app: true });

    expect(requests[0]?.body).toContain("grant_type=client_credentials");
    expect(requests[1]).toMatchObject({ url: "https://api.linear.app/graphql", authorization: "Bearer app_access" });
  });

  it("fetches workspace identity for hosted OAuth installation routing", async () => {
    const fetchImpl = (async () =>
      Response.json({
        data: {
          viewer: { id: "app_user_1", name: "OpenTag", app: true },
          organization: { id: "org_linear_1", name: "Acme", urlKey: "acme" }
        }
      })) as typeof fetch;

    await expect(fetchLinearWorkspaceIdentity({ token: "app_access", fetchImpl })).resolves.toEqual({
      viewer: { id: "app_user_1", name: "OpenTag", app: true },
      organization: { id: "org_linear_1", name: "Acme", urlKey: "acme" }
    });
  });
});
