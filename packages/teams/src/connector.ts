import type { FetchLike } from "./token.js";

export type TeamsConnector = {
  postMessage(input: { serviceUrl: string; conversationId: string; text: string }): Promise<{ activityId: string }>;
  updateMessage(input: { serviceUrl: string; conversationId: string; activityId: string; text: string }): Promise<void>;
};

const CONNECTOR_REQUEST_TIMEOUT_MS = 15_000;

function activitiesUrl(serviceUrl: string, conversationId: string): string {
  const base = serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`;
  return `${base}v3/conversations/${encodeURIComponent(conversationId)}/activities`;
}

export function createTeamsConnector(input: { getToken: () => Promise<string>; fetchImpl?: FetchLike }): TeamsConnector {
  const fetchImpl = input.fetchImpl ?? fetch;

  async function send(url: string, method: "POST" | "PUT", text: string): Promise<Record<string, unknown>> {
    const token = await input.getToken();
    const response = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", text }),
      signal: AbortSignal.timeout(CONNECTOR_REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      await response.text().catch(() => {});
      throw new Error(`Teams connector ${method} ${url} failed with status ${response.status}`);
    }
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  return {
    async postMessage({ serviceUrl, conversationId, text }) {
      const json = await send(activitiesUrl(serviceUrl, conversationId), "POST", text);
      if (typeof json.id !== "string" || json.id === "") {
        throw new Error("Teams connector POST succeeded but response is missing a string activity id");
      }
      return { activityId: json.id };
    },
    async updateMessage({ serviceUrl, conversationId, activityId, text }) {
      await send(`${activitiesUrl(serviceUrl, conversationId)}/${activityId}`, "PUT", text);
    }
  };
}
