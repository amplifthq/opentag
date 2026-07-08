import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Bot Framework OpenID metadata; the signing keys live behind this document. */
const DEFAULT_OPENID_METADATA_URL = "https://login.botframework.com/v1/.well-known/keys";
const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";

export type TeamsAuthResult = { ok: true } | { ok: false; reason: string };

export type TeamsAuthConfig = {
  /** Our Microsoft App ID; inbound token `aud` must equal this. */
  appId: string;
  /** Override the JWKS document URL (defaults to the Bot Framework keys endpoint). */
  openIdMetadataUrl?: string;
  /** Injectable key resolver (tests provide a local key; production builds one from the URL). */
  jwksClient?: JWTVerifyGetKey;
};

export function createTeamsAuthenticator(config: TeamsAuthConfig) {
  const jwks =
    config.jwksClient ??
    createRemoteJWKSet(new URL(config.openIdMetadataUrl ?? DEFAULT_OPENID_METADATA_URL));

  return {
    async verify(input: { authorizationHeader: string | undefined; bodyServiceUrl: string }): Promise<TeamsAuthResult> {
      const header = input.authorizationHeader ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      const token = match?.[1];
      if (!token) return { ok: false, reason: "missing_bearer_token" };

      let payload: Record<string, unknown>;
      try {
        const verified = await jwtVerify(token, jwks, {
          issuer: BOT_FRAMEWORK_ISSUER,
          audience: config.appId
        });
        payload = verified.payload as Record<string, unknown>;
      } catch (error) {
        // jose's claim-validation errors carry a structured `claim` field (e.g. "aud", "iss");
        // the error message itself only says `unexpected "aud" claim value`, so match on the
        // claim name rather than scanning message text for the words "audience"/"issuer".
        if (error instanceof joseErrors.JWTClaimValidationFailed) {
          if (error.claim === "aud") return { ok: false, reason: "audience_mismatch" };
          if (error.claim === "iss") return { ok: false, reason: "issuer_mismatch" };
        }
        return { ok: false, reason: "invalid_token" };
      }

      // Real Bot Framework/Teams channel tokens may omit the serviceUrl claim.
      // When the claim is present, keep the anti-redirection check strict; when it is absent,
      // rely on Bot Framework signature + issuer + audience validation and use the Activity
      // serviceUrl for replies (the same trust model used by Bot Framework SDKs).
      if (
        payload.serviceUrl !== undefined &&
        (typeof payload.serviceUrl !== "string" ||
          normalizeUrl(payload.serviceUrl) !== normalizeUrl(input.bodyServiceUrl))
      ) {
        return { ok: false, reason: "serviceUrl_mismatch" };
      }
      return { ok: true };
    }
  };
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}
