import { describe, expect, it } from "vitest";
import {
  createCompositeCallbackSink,
  createCompositeSourceReceiptSink,
  createGitHubCallbackSink,
  createLarkCallbackSink,
  createLarkSourceReceiptSink,
  createSlackCallbackSink,
  createSlackSourceReceiptSink,
  createTelegramCallbackSink
} from "../src/callbacks.js";

describe("createGitHubCallbackSink", () => {
  it("posts GitHub callback messages to the callback URI", async () => {
    const requests: { url: string; method: string; body: unknown; authorization: string | null }[] = [];
    const sink = createGitHubCallbackSink({
      token: "ghs_test",
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: JSON.parse(String(init?.body)),
          authorization: new Headers(init?.headers).get("authorization")
        });
        return Response.json({ id: 1, url: "https://api.github.com/repos/acme/demo/issues/comments/1" });
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
        method: "POST",
        authorization: "Bearer ghs_test",
        body: { body: "done" }
      }
    ]);
  });

  it("updates the same GitHub callback comment for a run", async () => {
    const requests: { url: string; method: string; body: unknown; authorization: string | null }[] = [];
    const sink = createGitHubCallbackSink({
      token: "ghs_test",
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: JSON.parse(String(init?.body)),
          authorization: new Headers(init?.headers).get("authorization")
        });
        return Response.json({ id: 123, url: "https://api.github.com/repos/acme/demo/issues/comments/123" });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "acknowledgement",
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
      body: "OpenTag picked this up."
    });
    await sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
      body: "Still working"
    });
    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
      body: "Done"
    });
    await sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
      body: "Starting again"
    });

    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/1/comments",
        method: "POST",
        authorization: "Bearer ghs_test",
        body: { body: "OpenTag picked this up." }
      },
      {
        url: "https://api.github.com/repos/acme/demo/issues/comments/123",
        method: "PATCH",
        authorization: "Bearer ghs_test",
        body: { body: "Still working" }
      },
      {
        url: "https://api.github.com/repos/acme/demo/issues/comments/123",
        method: "PATCH",
        authorization: "Bearer ghs_test",
        body: { body: "Done" }
      },
      {
        url: "https://api.github.com/repos/acme/demo/issues/1/comments",
        method: "POST",
        authorization: "Bearer ghs_test",
        body: { body: "Starting again" }
      }
    ]);
  });

  it("serializes concurrent GitHub callback deliveries for the same run", async () => {
    const requests: { url: string; method: string; body: unknown }[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const sink = createGitHubCallbackSink({
      token: "ghs_test",
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: JSON.parse(String(init?.body))
        });
        if (requests.length === 1) {
          await firstRequest;
          return Response.json({ id: 123, url: "https://api.github.com/repos/acme/demo/issues/comments/123" });
        }
        return Response.json({ id: 123, url: "https://api.github.com/repos/acme/demo/issues/comments/123" });
      }) as typeof fetch
    });

    const first = sink.deliver({
      runId: "run_1",
      kind: "acknowledgement",
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
      body: "Starting"
    });
    const second = sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
      body: "Still working"
    });
    resolveFirst?.();
    await Promise.all([first, second]);

    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/1/comments",
        method: "POST",
        body: { body: "Starting" }
      },
      {
        url: "https://api.github.com/repos/acme/demo/issues/comments/123",
        method: "PATCH",
        body: { body: "Still working" }
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

  it("posts Telegram callback messages to sendMessage", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const sink = createTelegramCallbackSink({
      botToken: "telegram-token",
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body))
        });
        return Response.json({ ok: true, result: { message_id: 999 } });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "telegram",
      uri: "https://api.telegram.org/sendMessage",
      threadKey: "bot_123|-1001|789|42",
      body: "done"
    });

    expect(requests).toEqual([
      {
        url: "https://api.telegram.org/bottelegram-token/sendMessage",
        body: {
          chat_id: "-1001",
          text: "done",
          reply_to_message_id: 789,
          message_thread_id: 42,
          allow_sending_without_reply: true
        }
      }
    ]);
  });

  it("streams Telegram progress messages through sendMessageDraft with a stable draft id", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const sink = createTelegramCallbackSink({
      botToken: "telegram-token",
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body))
        });
        return Response.json({ ok: true });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "telegram",
      uri: "https://api.telegram.org/sendMessage",
      threadKey: "bot_123|-1001|789|42",
      statusMessageKey: "run_1:status",
      body: "step 1"
    });
    await sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "telegram",
      uri: "https://api.telegram.org/sendMessage",
      threadKey: "bot_123|-1001|789|42",
      statusMessageKey: "run_1:status",
      body: "step 2"
    });

    expect(requests).toEqual([
      {
        url: "https://api.telegram.org/bottelegram-token/sendMessageDraft",
        body: {
          chat_id: "-1001",
          text: "step 1",
          draft_id: 1,
          message_thread_id: 42
        }
      },
      {
        url: "https://api.telegram.org/bottelegram-token/sendMessageDraft",
        body: {
          chat_id: "-1001",
          text: "step 2",
          draft_id: 1,
          message_thread_id: 42
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

  it("sends Lark rich callbacks as interactive cards", async () => {
    const replies: unknown[] = [];
    const sink = createLarkCallbackSink({
      client: {
        im: {
          message: {
            async reply(payload) {
              replies.push(payload);
            }
          }
        }
      }
    });

    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "lark",
      uri: "lark://im/v1/messages",
      threadKey: "tenant_1|oc_chat|om_msg",
      body: "Finished with success.",
      rich: {
        provider: "lark",
        payload: {
          config: { wide_screen_mode: true },
          header: {
            template: "green",
            title: { tag: "plain_text", content: "Finished: success" }
          },
          elements: [{ tag: "div", text: { tag: "lark_md", content: "Done." } }]
        }
      }
    });

    expect(replies).toEqual([
      {
        path: { message_id: "om_msg" },
        data: {
          msg_type: "interactive",
          reply_in_thread: true,
          content: JSON.stringify({
            config: { wide_screen_mode: true },
            header: {
              template: "green",
              title: { tag: "plain_text", content: "Finished: success" }
            },
            elements: [{ tag: "div", text: { tag: "lark_md", content: "Done." } }]
          })
        }
      }
    ]);
  });

  it("patches an existing Lark status card when an external message id is provided", async () => {
    const replies: unknown[] = [];
    const patches: unknown[] = [];
    const sink = createLarkCallbackSink({
      client: {
        im: {
          message: {
            async reply(payload) {
              replies.push(payload);
              return { data: { message_id: "om_status" } };
            },
            async patch(payload) {
              patches.push(payload);
            }
          }
        }
      }
    });

    const first = await sink.deliver({
      runId: "run_1",
      kind: "acknowledgement",
      provider: "lark",
      uri: "lark://im/v1/messages",
      threadKey: "tenant_1|oc_chat|om_source",
      statusMessageKey: "run_1:status",
      body: "Received.",
      rich: {
        provider: "lark",
        payload: {
          config: { wide_screen_mode: true, update_multi: true },
          header: {
            template: "blue",
            title: { tag: "plain_text", content: "OpenTag" }
          },
          elements: [{ tag: "div", text: { tag: "lark_md", content: "Working." } }]
        }
      }
    });

    const second = await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "lark",
      uri: "lark://im/v1/messages",
      threadKey: "tenant_1|oc_chat|om_source",
      statusMessageKey: "run_1:status",
      externalMessageId: first?.externalMessageId,
      body: "Finished.",
      rich: {
        provider: "lark",
        payload: {
          config: { wide_screen_mode: true, update_multi: true },
          header: {
            template: "green",
            title: { tag: "plain_text", content: "Finished" }
          },
          elements: [{ tag: "div", text: { tag: "lark_md", content: "Done." } }]
        }
      }
    });

    expect(first).toEqual({ externalMessageId: "om_status" });
    expect(second).toEqual({ externalMessageId: "om_status" });
    expect(replies).toHaveLength(1);
    expect(patches).toEqual([
      {
        path: { message_id: "om_status" },
        data: {
          content: JSON.stringify({
            config: { wide_screen_mode: true, update_multi: true },
            header: {
              template: "green",
              title: { tag: "plain_text", content: "Finished" }
            },
            elements: [{ tag: "div", text: { tag: "lark_md", content: "Done." } }]
          })
        }
      }
    ]);
  });

  it("adds a Lark source receipt reaction to the source message", async () => {
    const requests: unknown[] = [];
    const sink = createLarkSourceReceiptSink({
      client: {
        async request(payload) {
          requests.push(payload);
          return { data: { reaction_id: "reaction_1" } };
        },
        im: {}
      }
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        provider: "lark",
        state: "received",
        event: {
          id: "evt_1",
          source: "lark",
          sourceEventId: "Ev123",
          receivedAt: "2026-06-24T00:00:00.000Z",
          actor: { provider: "lark", providerUserId: "ou_123", handle: "ming", organizationId: "tenant_1" },
          target: { mention: "@opentag", agentId: "opentag" },
          command: { rawText: "fix this", intent: "fix", args: {} },
          context: [{ provider: "lark", kind: "message", uri: "lark://tenant/tenant_1/chat/oc_chat/message/om_msg" }],
          permissions: [
            { scope: "chat:postMessage", reason: "reply to source thread" },
            { scope: "im:message.reactions:write_only", reason: "mark the source Lark message as received" }
          ],
          callback: {
            provider: "lark",
            uri: "lark://im/v1/messages",
            threadKey: "tenant_1|oc_chat|om_msg"
          },
          metadata: { tenantKey: "tenant_1", chatId: "oc_chat", messageId: "om_msg" }
        }
      })
    ).resolves.toEqual({ delivered: true });

    expect(requests).toEqual([
      {
        method: "POST",
        url: "/open-apis/im/v1/messages/om_msg/reactions",
        data: {
          reaction_type: {
            emoji_type: "Typing"
          }
        }
      }
    ]);
  });

  it("allows overriding the Lark source receipt reaction", async () => {
    const requests: unknown[] = [];
    const sink = createLarkSourceReceiptSink({
      receivedEmojiType: "OnIt",
      client: {
        async request(payload) {
          requests.push(payload);
          return { data: { reaction_id: "reaction_1" } };
        },
        im: {}
      }
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        provider: "lark",
        state: "received",
        event: {
          id: "evt_1",
          source: "lark",
          sourceEventId: "Ev123",
          receivedAt: "2026-06-24T00:00:00.000Z",
          actor: { provider: "lark", providerUserId: "ou_123", handle: "ming", organizationId: "tenant_1" },
          target: { mention: "@opentag", agentId: "opentag" },
          command: { rawText: "fix this", intent: "fix", args: {} },
          context: [{ provider: "lark", kind: "message", uri: "lark://tenant/tenant_1/chat/oc_chat/message/om_msg" }],
          permissions: [
            { scope: "chat:postMessage", reason: "reply to source thread" },
            { scope: "im:message.reactions:write_only", reason: "mark the source Lark message as received" }
          ],
          callback: {
            provider: "lark",
            uri: "lark://im/v1/messages",
            threadKey: "tenant_1|oc_chat|om_msg"
          },
          metadata: { tenantKey: "tenant_1", chatId: "oc_chat", messageId: "om_msg" }
        }
      })
    ).resolves.toEqual({ delivered: true });

    expect(requests).toEqual([
      {
        method: "POST",
        url: "/open-apis/im/v1/messages/om_msg/reactions",
        data: {
          reaction_type: {
            emoji_type: "OnIt"
          }
        }
      }
    ]);
  });

  it("does not add a Lark source receipt reaction for running receipts", async () => {
    const requests: unknown[] = [];
    const sink = createLarkSourceReceiptSink({
      client: {
        async request(payload) {
          requests.push(payload);
          return {};
        },
        im: {}
      }
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        provider: "lark",
        state: "running",
        event: {
          id: "evt_1",
          source: "lark",
          sourceEventId: "Ev123",
          receivedAt: "2026-06-24T00:00:00.000Z",
          actor: { provider: "lark", providerUserId: "ou_123", handle: "ming", organizationId: "tenant_1" },
          target: { mention: "@opentag", agentId: "opentag" },
          command: { rawText: "fix this", intent: "fix", args: {} },
          context: [{ provider: "lark", kind: "message", uri: "lark://tenant/tenant_1/chat/oc_chat/message/om_msg" }],
          callback: {
            provider: "lark",
            uri: "lark://im/v1/messages",
            threadKey: "tenant_1|oc_chat|om_msg"
          },
          metadata: { tenantKey: "tenant_1", chatId: "oc_chat", messageId: "om_msg" }
        }
      })
    ).resolves.toEqual({ delivered: false });
    expect(requests).toEqual([]);
  });

  it("adds Slack source receipt reactions to the source message", async () => {
    const requests: { url: string; authorization: string | null; body: unknown }[] = [];
    const sink = createSlackSourceReceiptSink({
      botTokensByAgentId: {
        opentag: "xoxb-opentag"
      },
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body))
        });
        return Response.json({ ok: true });
      }) as typeof fetch
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        provider: "slack",
        state: "received",
        agentId: "opentag",
        event: {
          id: "evt_1",
          source: "slack",
          sourceEventId: "Ev123",
          receivedAt: "2026-06-24T00:00:00.000Z",
          actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
          target: { mention: "@opentag", agentId: "opentag" },
          command: { rawText: "fix this", intent: "fix", args: {} },
          context: [{ provider: "slack", kind: "message", uri: "slack://team/T123/channel/C123/message/1710000000.000100" }],
          permissions: [
            { scope: "chat:postMessage", reason: "reply to source thread" },
            { scope: "reactions:write", reason: "mark the source Slack message as received" }
          ],
          callback: {
            provider: "slack",
            uri: "https://slack.com/api/chat.postMessage",
            threadKey: "T123|C123|1710000000.000100"
          },
          metadata: { teamId: "T123", channelId: "C123", messageTs: "1710000000.000100" }
        }
      })
    ).resolves.toEqual({ delivered: true });

    expect(requests).toEqual([
      {
        url: "https://slack.com/api/reactions.add",
        authorization: "Bearer xoxb-opentag",
        body: {
          channel: "C123",
          timestamp: "1710000000.000100",
          name: "eyes"
        }
      }
    ]);
  });

  it("does not crash when Slack source receipt responses have a null JSON body", async () => {
    const sink = createSlackSourceReceiptSink({
      botToken: "xoxb-test",
      fetchImpl: (async () => Response.json(null)) as typeof fetch
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        provider: "slack",
        state: "received",
        event: {
          id: "evt_1",
          source: "slack",
          sourceEventId: "Ev123",
          receivedAt: "2026-06-24T00:00:00.000Z",
          actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
          target: { mention: "@opentag", agentId: "opentag" },
          command: { rawText: "fix this", intent: "fix", args: {} },
          context: [{ provider: "slack", kind: "message", uri: "slack://team/T123/channel/C123/message/1710000000.000100" }],
          callback: {
            provider: "slack",
            uri: "https://slack.com/api/chat.postMessage",
            threadKey: "T123|C123|1710000000.000100"
          },
          metadata: { teamId: "T123", channelId: "C123", messageTs: "1710000000.000100" }
        }
      })
    ).resolves.toEqual({ delivered: true });
  });

  it("bounds Slack source receipt reaction delivery with a timeout", async () => {
    let aborted = false;
    const sink = createSlackSourceReceiptSink({
      botToken: "xoxb-test",
      timeoutMs: 1,
      fetchImpl: (async (_url, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("expected abort signal");
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            aborted = true;
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
        });
      }) as typeof fetch
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        provider: "slack",
        state: "received",
        event: {
          id: "evt_1",
          source: "slack",
          sourceEventId: "Ev123",
          receivedAt: "2026-06-24T00:00:00.000Z",
          actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
          target: { mention: "@opentag", agentId: "opentag" },
          command: { rawText: "fix this", intent: "fix", args: {} },
          context: [{ provider: "slack", kind: "message", uri: "slack://team/T123/channel/C123/message/1710000000.000100" }],
          callback: {
            provider: "slack",
            uri: "https://slack.com/api/chat.postMessage",
            threadKey: "T123|C123|1710000000.000100"
          },
          metadata: { teamId: "T123", channelId: "C123", messageTs: "1710000000.000100" }
        }
      })
    ).resolves.toEqual({ delivered: false });
    expect(aborted).toBe(true);
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

  it("keeps a successful composite delivery when a later sink fails", async () => {
    const messages: string[] = [];
    const sink = createCompositeCallbackSink([
      {
        async deliver(message) {
          messages.push(`a:${message.provider}`);
          return { externalMessageId: "msg_1" };
        }
      },
      {
        async deliver(message) {
          messages.push(`b:${message.provider}`);
          throw new Error("secondary sink failed");
        }
      }
    ]);

    await expect(
      sink.deliver({
        runId: "run_1",
        kind: "final",
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        body: "final"
      })
    ).resolves.toEqual({ externalMessageId: "msg_1" });

    expect(messages).toEqual(["a:slack", "b:slack"]);
  });

  it("composes source receipt sinks and reports delivered when any sink succeeds", async () => {
    const seen: string[] = [];
    const sink = createCompositeSourceReceiptSink([
      {
        async deliver(receipt) {
          seen.push(`a:${receipt.provider}`);
          return { delivered: false };
        }
      },
      {
        async deliver(receipt) {
          seen.push(`b:${receipt.provider}`);
          return { delivered: true };
        }
      }
    ]);

    await expect(
      sink.deliver({
        runId: "run_1",
        provider: "lark",
        state: "received",
        event: {
          id: "evt_1",
          source: "lark",
          sourceEventId: "Ev123",
          receivedAt: "2026-06-24T00:00:00.000Z",
          actor: { provider: "lark", providerUserId: "ou_123", handle: "ming", organizationId: "tenant_1" },
          target: { mention: "@opentag", agentId: "opentag" },
          command: { rawText: "fix this", intent: "fix", args: {} },
          context: [{ provider: "lark", kind: "message", uri: "lark://tenant/tenant_1/chat/oc_chat/message/om_msg" }],
          callback: {
            provider: "lark",
            uri: "lark://im/v1/messages",
            threadKey: "tenant_1|oc_chat|om_msg"
          },
          metadata: { tenantKey: "tenant_1", chatId: "oc_chat", messageId: "om_msg" }
        }
      })
    ).resolves.toEqual({ delivered: true });
    expect(seen).toEqual(["a:lark", "b:lark"]);
  });
});
