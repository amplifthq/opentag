import type { FetchLike } from "./token.js";

export type TeamsConnector = {
  postMessage(input: { serviceUrl: string; conversationId: string; text: string }): Promise<{ activityId: string }>;
  updateMessage(input: { serviceUrl: string; conversationId: string; activityId: string; text: string }): Promise<void>;
};

function activitiesUrl(serviceUrl: string, conversationId: string): string {
  const base = serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`;
  return `${base}v3/conversations/${conversationId}/activities`;
}

export function createTeamsConnector(input: { getToken: () => Promise<string>; fetchImpl?: FetchLike }): TeamsConnector {
  const fetchImpl = input.fetchImpl ?? fetch;

  async function send(url: string, method: "POST" | "PUT", text: string): Promise<Record<string, unknown>> {
    const token = await input.getToken();
    const response = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", text })
    });
    if (!response.ok) {
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
      const activityId = typeof json.id === "string" ? json.id : "";
      return { activityId };
    },
    async updateMessage({ serviceUrl, conversationId, activityId, text }) {
      await send(`${activitiesUrl(serviceUrl, conversationId)}/${activityId}`, "PUT", text);
    }
  };
}
