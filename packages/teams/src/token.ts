export type FetchLike = typeof fetch;

const REFRESH_MARGIN_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export function createTeamsTokenProvider(input: {
  appId: string;
  appPassword: string;
  tenantId?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => Date.now());
  const authority = input.tenantId ?? "botframework.com";
  const url = `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`;

  let cached: { token: string; expiresAt: number } | null = null;
  let pendingToken: Promise<string> | null = null;

  return {
    async getToken(): Promise<string> {
      const currentTime = now();
      if (cached && currentTime < cached.expiresAt - REFRESH_MARGIN_MS) {
        return cached.token;
      }
      if (pendingToken) {
        return pendingToken;
      }

      pendingToken = (async () => {
        try {
          const body = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: input.appId,
            client_secret: input.appPassword,
            scope: "https://api.botframework.com/.default"
          });
          const response = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: body.toString(),
            signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)
          });
          if (!response.ok) {
            throw new Error(`Teams token request failed with status ${response.status}`);
          }
          const json = (await response.json()) as { access_token?: string; expires_in?: number };
          if (!json.access_token) {
            throw new Error("Teams token response missing access_token");
          }
          const expiresInMs = (json.expires_in ?? 3600) * 1000;
          cached = { token: json.access_token, expiresAt: now() + expiresInMs };
          return cached.token;
        } finally {
          pendingToken = null;
        }
      })();

      return pendingToken;
    }
  };
}
