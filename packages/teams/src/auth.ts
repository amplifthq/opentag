import {
  AuthenticationConfiguration,
  AuthenticationConstants,
  BotFrameworkAuthenticationFactory,
  PasswordServiceClientCredentialFactory,
  type BotFrameworkAuthentication
} from "botframework-connector";

/** Bot Framework OpenID metadata document; it points at the signing JWKS. */
const DEFAULT_OPENID_METADATA_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const TEAMS_CHANNEL_ID = "msteams";
const JWKS_CACHE_MS = 5 * 60_000;
const METADATA_REQUEST_TIMEOUT_MS = 15_000;

export type TeamsAuthResult = { ok: true } | { ok: false; reason: string };

export type TeamsAuthConfig = {
  /** Our Microsoft App ID; inbound token `aud` must equal this. */
  appId: string;
  /** Override the Bot Framework OpenID metadata document URL. */
  openIdMetadataUrl?: string;
  /** Injectable official authenticator for focused tests. Production builds one from Bot Framework SDK. */
  botFrameworkAuthentication?: Pick<BotFrameworkAuthentication, "authenticateRequest">;
  /** Fetch implementation used by the Teams endorsement precheck. */
  fetchImpl?: typeof fetch;
};

type JwkWithEndorsements = {
  kid?: string;
  endorsements?: unknown;
};

type CachedJwks = {
  expiresAt: number;
  keys: JwkWithEndorsements[];
};

function createOfficialBotFrameworkAuthentication(input: { appId: string; openIdMetadataUrl: string }): BotFrameworkAuthentication {
  return BotFrameworkAuthenticationFactory.create(
    "",
    true,
    AuthenticationConstants.ToChannelFromBotLoginUrl,
    AuthenticationConstants.ToChannelFromBotOAuthScope,
    AuthenticationConstants.ToBotFromChannelTokenIssuer,
    AuthenticationConstants.OAuthUrl,
    input.openIdMetadataUrl,
    AuthenticationConstants.ToBotFromEmulatorOpenIdMetadataUrl,
    "urn:botframework:azure",
    // Inbound validation only needs appId matching; password is used when the
    // official auth object later creates outbound credentials, which this
    // OpenTag wrapper does not use.
    new PasswordServiceClientCredentialFactory(input.appId, ""),
    new AuthenticationConfiguration([TEAMS_CHANNEL_ID])
  );
}

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

function createTeamsEndorsementValidator(input: { metadataUrl: string; fetchImpl: typeof fetch; now?: () => number }) {
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

  return async (token: string): Promise<TeamsAuthResult> => {
    const kid = tokenKid(token);
    if (!kid) return { ok: false, reason: "invalid_token" };
    const keys = await loadKeys();
    const key = keys.find((candidate) => candidate.kid === kid);
    if (!key) return { ok: false, reason: "invalid_token" };
    const endorsements = Array.isArray(key.endorsements)
      ? key.endorsements.filter((value): value is string => typeof value === "string")
      : [];
    return endorsements.includes(TEAMS_CHANNEL_ID) ? { ok: true } : { ok: false, reason: "endorsement_missing" };
  };
}

export function createTeamsAuthenticator(config: TeamsAuthConfig) {
  const openIdMetadataUrl = config.openIdMetadataUrl ?? DEFAULT_OPENID_METADATA_URL;
  const officialAuth =
    config.botFrameworkAuthentication ??
    createOfficialBotFrameworkAuthentication({ appId: config.appId, openIdMetadataUrl });
  const validateTeamsEndorsement = createTeamsEndorsementValidator({
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
        const endorsement = await validateTeamsEndorsement(token);
        if (!endorsement.ok) return endorsement;

        await officialAuth.authenticateRequest(input.activity as never, input.authorizationHeader ?? "");
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
