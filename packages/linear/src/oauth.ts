import { DEFAULT_LINEAR_REQUEST_TIMEOUT_MS, linearGraphql, type FetchLike } from "./graphql.js";

export const LINEAR_AUTHORIZATION_URL = "https://linear.app/oauth/authorize";
export const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_OAUTH_REVOKE_URL = "https://api.linear.app/oauth/revoke";

export type LinearOAuthActor = "user" | "app";

export const DEFAULT_LINEAR_AGENT_OAUTH_SCOPES = ["read", "write", "comments:create", "app:assignable", "app:mentionable"] as const;

export type LinearOAuthTokenResponse = {
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string;
  expiresIn?: number;
  scope?: string[];
};

export type LinearViewerIdentity = {
  id: string;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
  app?: boolean;
};

export type LinearOrganizationIdentity = {
  id: string;
  name?: string | null;
  urlKey?: string | null;
};

export type LinearWorkspaceIdentity = {
  viewer: LinearViewerIdentity;
  organization?: LinearOrganizationIdentity;
};

function parseScope(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (typeof value === "string") return value.split(/[,\s]+/).filter(Boolean);
  return undefined;
}

async function parseTokenResponse(response: Response): Promise<LinearOAuthTokenResponse> {
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    refresh_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    error?: unknown;
    error_description?: unknown;
  };
  if (!response.ok || payload.error) {
    const detail = typeof payload.error_description === "string" ? payload.error_description : typeof payload.error === "string" ? payload.error : "unknown_error";
    throw new Error(`Linear OAuth failed: ${response.status} ${detail}`);
  }
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("Linear OAuth response did not include an access token.");
  }
  const scope = parseScope(payload.scope);
  return {
    accessToken: payload.access_token,
    ...(typeof payload.refresh_token === "string" || payload.refresh_token === null ? { refreshToken: payload.refresh_token } : {}),
    ...(typeof payload.token_type === "string" ? { tokenType: payload.token_type } : {}),
    ...(typeof payload.expires_in === "number" ? { expiresIn: payload.expires_in } : {}),
    ...(scope ? { scope } : {})
  };
}

export function buildLinearOAuthAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
  actor?: LinearOAuthActor;
  prompt?: "consent";
  codeChallenge?: string;
  codeChallengeMethod?: "plain" | "S256";
  authorizationUrl?: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: (input.scopes ?? DEFAULT_LINEAR_AGENT_OAUTH_SCOPES).join(","),
    state: input.state,
    actor: input.actor ?? "app"
  });
  if (input.prompt) params.set("prompt", input.prompt);
  if (input.codeChallenge) {
    params.set("code_challenge", input.codeChallenge);
    params.set("code_challenge_method", input.codeChallengeMethod ?? "S256");
  }
  return `${input.authorizationUrl ?? LINEAR_AUTHORIZATION_URL}?${params.toString()}`;
}

export async function exchangeLinearOAuthCode(input: {
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  tokenUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<LinearOAuthTokenResponse> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code"
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  if (input.codeVerifier) body.set("code_verifier", input.codeVerifier);
  const response = await (input.fetchImpl ?? fetch)(input.tokenUrl ?? LINEAR_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_LINEAR_REQUEST_TIMEOUT_MS)
  });
  return parseTokenResponse(response);
}

export async function refreshLinearOAuthToken(input: {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  tokenUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<LinearOAuthTokenResponse> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    refresh_token: input.refreshToken,
    grant_type: "refresh_token"
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  const response = await (input.fetchImpl ?? fetch)(input.tokenUrl ?? LINEAR_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_LINEAR_REQUEST_TIMEOUT_MS)
  });
  return parseTokenResponse(response);
}

export async function createLinearClientCredentialsToken(input: {
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
  tokenUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<LinearOAuthTokenResponse> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "client_credentials",
    scope: (input.scopes ?? DEFAULT_LINEAR_AGENT_OAUTH_SCOPES).join(",")
  });
  const response = await (input.fetchImpl ?? fetch)(input.tokenUrl ?? LINEAR_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_LINEAR_REQUEST_TIMEOUT_MS)
  });
  return parseTokenResponse(response);
}

export async function revokeLinearOAuthToken(input: {
  clientId: string;
  clientSecret: string;
  token: string;
  tokenTypeHint?: "access_token" | "refresh_token";
  revokeUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<void> {
  const body = new URLSearchParams({ token: input.token });
  if (input.tokenTypeHint) body.set("token_type_hint", input.tokenTypeHint);
  const response = await (input.fetchImpl ?? fetch)(input.revokeUrl ?? LINEAR_OAUTH_REVOKE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`
    },
    body,
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_LINEAR_REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Linear OAuth revoke failed: ${response.status}`);
  }
}

export async function fetchLinearViewerIdentity(input: {
  token: string;
  graphqlUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<LinearViewerIdentity> {
  const data = await linearGraphql<{
    viewer?: {
      id?: string;
      name?: string | null;
      displayName?: string | null;
      email?: string | null;
      app?: boolean;
    };
  }>({
    token: input.token,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
    fetchImpl: input.fetchImpl ?? fetch,
    query: `query OpenTagLinearViewer {
  viewer { id name displayName email app }
}`,
    variables: {}
  });
  if (!data.viewer?.id) {
    throw new Error("Linear viewer query returned no viewer id.");
  }
  return {
    id: data.viewer.id,
    ...(data.viewer.name !== undefined ? { name: data.viewer.name } : {}),
    ...(data.viewer.displayName !== undefined ? { displayName: data.viewer.displayName } : {}),
    ...(data.viewer.email !== undefined ? { email: data.viewer.email } : {}),
    ...(data.viewer.app !== undefined ? { app: data.viewer.app } : {})
  };
}

export async function fetchLinearWorkspaceIdentity(input: {
  token: string;
  graphqlUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<LinearWorkspaceIdentity> {
  const data = await linearGraphql<{
    viewer?: {
      id?: string;
      name?: string | null;
      displayName?: string | null;
      email?: string | null;
      app?: boolean;
    };
    organization?: {
      id?: string;
      name?: string | null;
      urlKey?: string | null;
    } | null;
  }>({
    token: input.token,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
    fetchImpl: input.fetchImpl ?? fetch,
    query: `query OpenTagLinearWorkspaceIdentity {
  viewer { id name displayName email app }
  organization { id name urlKey }
}`,
    variables: {}
  });
  if (!data.viewer?.id) {
    throw new Error("Linear workspace identity query returned no viewer id.");
  }
  return {
    viewer: {
      id: data.viewer.id,
      ...(data.viewer.name !== undefined ? { name: data.viewer.name } : {}),
      ...(data.viewer.displayName !== undefined ? { displayName: data.viewer.displayName } : {}),
      ...(data.viewer.email !== undefined ? { email: data.viewer.email } : {}),
      ...(data.viewer.app !== undefined ? { app: data.viewer.app } : {})
    },
    ...(data.organization?.id
      ? {
          organization: {
            id: data.organization.id,
            ...(data.organization.name !== undefined ? { name: data.organization.name } : {}),
            ...(data.organization.urlKey !== undefined ? { urlKey: data.organization.urlKey } : {})
          }
        }
      : {})
  };
}
