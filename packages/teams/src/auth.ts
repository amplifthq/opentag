import { importJWK, jwtVerify, type JWK } from "jose";

/** Bot Framework OpenID metadata document; it points at the signing JWKS. */
const DEFAULT_OPENID_METADATA_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const BOT_FRAMEWORK_TOKEN_ISSUER = "https://api.botframework.com";
const TEAMS_CHANNEL_ID = "msteams";
const JWKS_CACHE_MS = 5 * 60_000;
const METADATA_REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_CLOCK_TOLERANCE_SECONDS = 5 * 60;

export type TeamsAuthResult = { ok: true } | { ok: false; reason: string };

export type TeamsAuthConfig = {
  /** Our Microsoft App ID; inbound token `aud` must equal this. */
  appId: string;
  /** Override the Bot Framework OpenID metadata document URL. */
  openIdMetadataUrl?: string;
  /** Optional additional authenticator; built-in JOSE validation always runs first. */
  botFrameworkAuthentication?: {
    authenticateRequest(activity: unknown, authorizationHeader: string): Promise<unknown>;
  };
  /** Fetch implementation used to load Bot Framework OpenID metadata and signing keys. */
  fetchImpl?: typeof fetch;
};

type JwkWithEndorsements = JWK & {
  kid?: string;
  endorsements?: unknown;
};

type CachedJwks = {
  expiresAt: number;
  keys: JwkWithEndorsements[];
};

function bearerToken(authorizationHeader: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((authorizationHeader ?? "").trim());
  return match?.[1] ?? null;
}

function decodeBase64UrlJson(input: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(input, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tokenKid(token: string): string | null {
  const [header] = token.split(".");
  if (!header) return null;
  const decoded = decodeBase64UrlJson(header);
  return typeof decoded?.kid === "string" && decoded.kid ? decoded.kid : null;
}

function tokenAlg(token: string): string | null {
  const [header] = token.split(".");
  if (!header) return null;
  const decoded = decodeBase64UrlJson(header);
  return typeof decoded?.alg === "string" && decoded.alg ? decoded.alg : null;
}

function createTeamsSigningKeyResolver(input: { metadataUrl: string; fetchImpl: typeof fetch; now?: () => number }) {
  const now = input.now ?? (() => Date.now());
  let cached: CachedJwks | null = null;

  async function fetchJson(url: string): Promise<Record<string, unknown>> {
    const response = await input.fetchImpl(url, { signal: AbortSignal.timeout(METADATA_REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Bot Framework metadata request failed with status ${response.status}`);
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Bot Framework metadata response is not an object");
    }
    return body as Record<string, unknown>;
  }

  async function loadKeys(): Promise<JwkWithEndorsements[]> {
    if (cached && now() < cached.expiresAt) return cached.keys;

    const metadata = await fetchJson(input.metadataUrl);
    let jwks: Record<string, unknown>;
    if (Array.isArray(metadata.keys)) {
      // Backward-compatible local test mode: allow the override URL to point
      // directly at a JWKS document even though production uses OpenID metadata.
      jwks = metadata;
    } else if (typeof metadata.jwks_uri === "string") {
      jwks = await fetchJson(metadata.jwks_uri);
    } else {
      throw new Error("Bot Framework OpenID metadata missing jwks_uri");
    }

    if (!Array.isArray(jwks.keys)) throw new Error("Bot Framework JWKS response missing keys array");
    const keys = jwks.keys.filter((key): key is JwkWithEndorsements => Boolean(key) && typeof key === "object");
    cached = { keys, expiresAt: now() + JWKS_CACHE_MS };
    return keys;
  }

  return async (token: string): Promise<
    { ok: true; key: JwkWithEndorsements } | { ok: false; reason: string }
  > => {
    const kid = tokenKid(token);
    if (!kid) return { ok: false, reason: "invalid_token" };
    const keys = await loadKeys();
    const key = keys.find((candidate) => candidate.kid === kid);
    if (!key) return { ok: false, reason: "invalid_token" };
    const endorsements = Array.isArray(key.endorsements)
      ? key.endorsements.filter((value): value is string => typeof value === "string")
      : [];
    return endorsements.includes(TEAMS_CHANNEL_ID)
      ? { ok: true, key }
      : { ok: false, reason: "endorsement_missing" };
  };
}

export function createTeamsAuthenticator(config: TeamsAuthConfig) {
  const openIdMetadataUrl = config.openIdMetadataUrl ?? DEFAULT_OPENID_METADATA_URL;
  const resolveTeamsSigningKey = createTeamsSigningKeyResolver({
    metadataUrl: openIdMetadataUrl,
    fetchImpl: config.fetchImpl ?? fetch
  });

  return {
    async verify(input: {
      authorizationHeader: string | undefined;
      activity: Record<string, unknown>;
    }): Promise<TeamsAuthResult> {
      const token = bearerToken(input.authorizationHeader);
      if (!token) return { ok: false, reason: "missing_bearer_token" };

      if (input.activity.channelId !== TEAMS_CHANNEL_ID) {
        return { ok: false, reason: "channel_unsupported" };
      }
      if (typeof input.activity.serviceUrl !== "string" || !input.activity.serviceUrl.trim()) {
        return { ok: false, reason: "serviceUrl_missing" };
      }
      // Bot Framework public cloud metadata currently advertises RS256. Keep
      // this adapter fail-closed even though the SDK's generic allowed list is broader.
      if (tokenAlg(token) !== "RS256") {
        return { ok: false, reason: "invalid_token" };
      }

      try {
        const signingKey = await resolveTeamsSigningKey(token);
        if (!signingKey.ok) return signingKey;

        const verificationKey = await importJWK(signingKey.key, "RS256");
        const verified = await jwtVerify(token, verificationKey, {
          algorithms: ["RS256"],
          issuer: BOT_FRAMEWORK_TOKEN_ISSUER,
          audience: config.appId,
          requiredClaims: ["exp"],
          clockTolerance: TOKEN_CLOCK_TOLERANCE_SECONDS
        });
        if (verified.payload.serviceurl !== input.activity.serviceUrl) {
          return { ok: false, reason: "serviceUrl_mismatch" };
        }
        if (config.botFrameworkAuthentication) {
          await config.botFrameworkAuthentication.authenticateRequest(input.activity, input.authorizationHeader ?? "");
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/ServiceUrl/i.test(message)) return { ok: false, reason: "serviceUrl_mismatch" };
        if (/Invalid AppId|audience|aud/i.test(message)) return { ok: false, reason: "audience_mismatch" };
        if (/issuer/i.test(message)) return { ok: false, reason: "issuer_mismatch" };
        if (/endorsement/i.test(message)) return { ok: false, reason: "endorsement_missing" };
        return { ok: false, reason: "invalid_token" };
      }
    }
  };
}
