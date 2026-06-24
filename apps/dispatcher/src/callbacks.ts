import { parseSlackThreadKey } from "@opentag/slack";
import type { CallbackMessage, CallbackSink } from "./server.js";

export type FetchLike = typeof fetch;

export function createGitHubCallbackSink(input: { token?: string; fetchImpl?: FetchLike }): CallbackSink {
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async deliver(message: CallbackMessage): Promise<void> {
      if (message.provider !== "github") return;
      if (!input.token) return;

      const response = await fetchImpl(message.uri, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28"
        },
        body: JSON.stringify({ body: message.body })
      });

      if (!response.ok) {
        throw new Error(`deliver GitHub callback failed: ${response.status} ${await response.text()}`);
      }
    }
  };
}

export function createSlackCallbackSink(input: { botToken?: string; fetchImpl?: FetchLike }): CallbackSink {
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async deliver(message: CallbackMessage): Promise<void> {
      if (message.provider !== "slack") return;
      if (!input.botToken) return;

      const thread = parseSlackThreadKey(message.threadKey ?? "");
      const response = await fetchImpl(message.uri, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.botToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          channel: thread.channelId,
          text: message.body,
          thread_ts: thread.threadTs
        })
      });

      if (!response.ok) {
        throw new Error(`deliver Slack callback failed: ${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (body.ok === false) {
        throw new Error(`deliver Slack callback failed: ${body.error ?? "unknown_error"}`);
      }
    }
  };
}

export function createCompositeCallbackSink(sinks: CallbackSink[]): CallbackSink {
  return {
    async deliver(message: CallbackMessage): Promise<void> {
      for (const sink of sinks) {
        await sink.deliver(message);
      }
    }
  };
}
