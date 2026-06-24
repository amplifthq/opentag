import { describe, expect, it } from "vitest";
import { createCompositeCallbackSink, createGitHubCallbackSink, createSlackCallbackSink } from "../src/callbacks.js";

describe("createGitHubCallbackSink", () => {
  it("posts GitHub callback messages to the callback URI", async () => {
    const requests: { url: string; body: unknown; authorization: string | null }[] = [];
    const sink = createGitHubCallbackSink({
      token: "ghs_test",
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          authorization: new Headers(init?.headers).get("authorization")
        });
        return Response.json({ id: 1 });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
      body: "done"
    });

    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/1/comments",
        authorization: "Bearer ghs_test",
        body: { body: "done" }
      }
    ]);
  });

  it("ignores non-GitHub callback messages", async () => {
    const sink = createGitHubCallbackSink({
      token: "ghs_test",
      fetchImpl: (async () => {
        throw new Error("should not call fetch");
      }) as typeof fetch
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        kind: "final",
        provider: "webhook",
        uri: "https://example.com/callback",
        body: "done"
      })
    ).resolves.toBeUndefined();
  });

  it("posts Slack callback messages to chat.postMessage", async () => {
    const requests: { url: string; body: unknown; authorization: string | null }[] = [];
    const sink = createSlackCallbackSink({
      botToken: "xoxb-test",
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          authorization: new Headers(init?.headers).get("authorization")
        });
        return Response.json({ ok: true });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "slack",
      uri: "https://slack.com/api/chat.postMessage",
      threadKey: "T123|C123|1710000000.000100",
      body: "done"
    });

    expect(requests).toEqual([
      {
        url: "https://slack.com/api/chat.postMessage",
        authorization: "Bearer xoxb-test",
        body: {
          channel: "C123",
          text: "done",
          thread_ts: "1710000000.000100"
        }
      }
    ]);
  });

  it("selects Slack bot tokens by agent id when provided", async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const sink = createSlackCallbackSink({
      botTokensByAgentId: {
        gemini: "xoxb-gemini",
        deepseek: "xoxb-deepseek"
      },
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization")
        });
        return Response.json({ ok: true, ts: "1720000000.000100" });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "slack",
      uri: "https://slack.com/api/chat.postMessage",
      threadKey: "T123|C123|1710000000.000100",
      agentId: "deepseek",
      body: "done"
    });

    expect(requests).toEqual([
      {
        url: "https://slack.com/api/chat.postMessage",
        authorization: "Bearer xoxb-deepseek"
      }
    ]);
  });

  it("edits an existing Slack status message when statusMessageKey repeats", async () => {
    const requests: { url: string; body: unknown; authorization: string | null }[] = [];
    const sink = createSlackCallbackSink({
      botToken: "xoxb-test",
      fetchImpl: (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push({
          url: String(url),
          body,
          authorization: new Headers(init?.headers).get("authorization")
        });
        if (String(url).endsWith("/chat.postMessage")) {
          return Response.json({ ok: true, ts: "1720000000.000100" });
        }
        return Response.json({ ok: true, ts: body.ts });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "slack",
      uri: "https://slack-proxy.example.com/api/chat.postMessage",
      threadKey: "T123|C123|1710000000.000100",
      body: "Starting",
      statusMessageKey: "run_1:status"
    });
    await sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "slack",
      uri: "https://slack-proxy.example.com/api/chat.postMessage",
      threadKey: "T123|C123|1710000000.000100",
      body: "Still working",
      statusMessageKey: "run_1:status"
    });

    expect(requests).toEqual([
      {
        url: "https://slack-proxy.example.com/api/chat.postMessage",
        authorization: "Bearer xoxb-test",
        body: {
          channel: "C123",
          text: "Starting",
          thread_ts: "1710000000.000100"
        }
      },
      {
        url: "https://slack-proxy.example.com/api/chat.update",
        authorization: "Bearer xoxb-test",
        body: {
          channel: "C123",
          text: "Still working",
          ts: "1720000000.000100"
        }
      }
    ]);
  });

  it("cleans up Slack status message keys when a run finishes", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const sink = createSlackCallbackSink({
      botToken: "xoxb-test",
      fetchImpl: (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push({ url: String(url), body });
        if (String(url).endsWith("/chat.postMessage")) {
          return Response.json({ ok: true, ts: `posted-${requests.length}` });
        }
        return Response.json({ ok: true, ts: body.ts });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "slack",
      uri: "https://slack.com/api/chat.postMessage",
      threadKey: "T123|C123|1710000000.000100",
      body: "Starting",
      statusMessageKey: "run_1:status"
    });
    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "slack",
      uri: "https://slack.com/api/chat.postMessage",
      threadKey: "T123|C123|1710000000.000100",
      body: "Done"
    });
    await sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "slack",
      uri: "https://slack.com/api/chat.postMessage",
      threadKey: "T123|C123|1710000000.000100",
      body: "Starting again",
      statusMessageKey: "run_1:status"
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://slack.com/api/chat.postMessage",
      "https://slack.com/api/chat.postMessage",
      "https://slack.com/api/chat.postMessage"
    ]);
  });

  it("includes Slack blocks when present", async () => {
    const requests: { url: string; body: unknown; authorization: string | null }[] = [];
    const sink = createSlackCallbackSink({
      botToken: "xoxb-test",
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          authorization: new Headers(init?.headers).get("authorization")
        });
        return Response.json({ ok: true, ts: "1720000000.000100" });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "slack",
      uri: "https://slack.com/api/chat.postMessage",
      threadKey: "T123|C123|1710000000.000100",
      body: "**done**",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*done*"
          }
        }
      ]
    });

    expect(requests).toEqual([
      {
        url: "https://slack.com/api/chat.postMessage",
        authorization: "Bearer xoxb-test",
        body: {
          channel: "C123",
          text: "*done*",
          thread_ts: "1710000000.000100",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*done*"
              }
            }
          ]
        }
      }
    ]);
  });

  it("fans out across composed sinks", async () => {
    const messages: string[] = [];
    const sink = createCompositeCallbackSink([
      {
        async deliver(message) {
          messages.push(`a:${message.provider}`);
        }
      },
      {
        async deliver(message) {
          messages.push(`b:${message.provider}`);
        }
      }
    ]);

    await sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "slack",
      uri: "https://slack.com/api/chat.postMessage",
      body: "progress"
    });

    expect(messages).toEqual(["a:slack", "b:slack"]);
  });
});
