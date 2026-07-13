import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenTagRepository, migrateSchema } from "@opentag/store";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  createCompositeCallbackSink,
  createCompositeSourceReceiptSink,
  createDiscordCallbackSink,
  createGitHubCallbackSink,
  createGitLabCallbackSink,
  createLinearCallbackSink,
  createLarkCallbackSink,
  createLarkSourceReceiptSink,
  createSlackCallbackSink,
  createSlackSourceReceiptSink,
  createTelegramCallbackSink
} from "../src/callbacks.js";
import { processPendingCallbacks } from "../src/server.js";

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

  it("posts GitLab callback messages to the Notes API callback URI", async () => {
    const requests: { url: string; method: string; body: unknown; token: string | null }[] = [];
    const sink = createGitLabCallbackSink({
      token: "glpat_test",
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: JSON.parse(String(init?.body)),
          token: new Headers(init?.headers).get("PRIVATE-TOKEN")
        });
        return Response.json({ id: 1, body: "done" });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "gitlab",
      uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
      body: "done"
    });

    expect(requests).toEqual([
      {
        url: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
        method: "POST",
        token: "glpat_test",
        body: { body: "done" }
      }
    ]);
  });

  it("posts Linear callback messages as new issue comments", async () => {
    const requests: { url: string; method: string; body: unknown; authorization: string | null }[] = [];
    const sink = createLinearCallbackSink({
      token: "lin_api_test",
      graphqlUrl: "https://linear.example/graphql",
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: JSON.parse(String(init?.body)),
          authorization: new Headers(init?.headers).get("authorization")
        });
        return Response.json({
          data: {
            commentCreate: {
              success: true,
              comment: { id: "comment_1", url: "https://linear.app/acme/issue/ENG-1#comment_1" }
            }
          }
        });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "linear",
      uri: "linear://issue/issue_123/comments",
      body: "done"
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://linear.example/graphql",
      method: "POST",
      authorization: "lin_api_test",
      body: {
        variables: {
          input: {
            issueId: "issue_123",
            body: "done"
          }
        }
      }
    });
    expect(String((requests[0]!.body as { query: string }).query)).toContain("commentCreate");
  });

  it("threads Linear callback comments under the mention's thread-root comment", async () => {
    const requests: { body: unknown }[] = [];
    const sink = createLinearCallbackSink({
      token: "lin_api_test",
      graphqlUrl: "https://linear.example/graphql",
      fetchImpl: (async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          data: {
            commentCreate: {
              success: true,
              comment: { id: "comment_2", url: "https://linear.app/acme/issue/ENG-1#comment_2" }
            }
          }
        });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "linear",
      uri: "linear://issue/issue_123/comments?parent=comment_root",
      body: "done"
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      body: {
        variables: {
          input: {
            issueId: "issue_123",
            body: "done",
            parentId: "comment_root"
          }
        }
      }
    });
  });

  it("uses the Linear token provider for callback delivery", async () => {
    const requests: { authorization: string | null }[] = [];
    const sink = createLinearCallbackSink({
      async getToken() {
        return "Bearer refreshed_app_token";
      },
      graphqlUrl: "https://linear.example/graphql",
      fetchImpl: (async (_url, init) => {
        requests.push({ authorization: new Headers(init?.headers).get("authorization") });
        return Response.json({
          data: {
            commentCreate: {
              success: true,
              comment: { id: "comment_1", url: "https://linear.app/acme/issue/ENG-1#comment_1" }
            }
          }
        });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "linear",
      uri: "linear://issue/issue_123/comments",
      body: "done"
    });

    expect(requests).toEqual([{ authorization: "Bearer refreshed_app_token" }]);
  });

  it("updates an existing Linear status comment when the status key repeats", async () => {
    const requests: { body: unknown }[] = [];
    const sink = createLinearCallbackSink({
      token: "lin_api_test",
      graphqlUrl: "https://linear.example/graphql",
      fetchImpl: (async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return Response.json({
          data: {
            commentUpdate: {
              success: true,
              comment: { id: "comment_1", url: "https://linear.app/acme/issue/ENG-1#comment_1" }
            }
          }
        });
      }) as typeof fetch
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        kind: "progress",
        provider: "linear",
        uri: "linear://issue/issue_123/comments",
        body: "still working",
        statusMessageKey: "run_1:status",
        externalMessageId: "comment_1"
      })
    ).resolves.toEqual({ externalMessageId: "comment_1" });

    expect(String((requests[0]!.body as { query: string }).query)).toContain("commentUpdate");
    expect(requests[0]).toMatchObject({
      body: {
        variables: {
          id: "comment_1",
          input: { body: "still working" }
        }
      }
    });
  });

  it("creates then reuses one Linear status comment for repeated status updates", async () => {
    const requests: Array<{ query: string; variables: unknown }> = [];
    const sink = createLinearCallbackSink({
      token: "lin_api_test",
      graphqlUrl: "https://linear.example/graphql",
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string; variables: unknown };
        requests.push(body);
        if (body.query.includes("commentCreate")) {
          return Response.json({
            data: {
              commentCreate: {
                success: true,
                comment: { id: "comment_1", url: "https://linear.app/acme/issue/ENG-1#comment_1" }
              }
            }
          });
        }
        return Response.json({
          data: {
            commentUpdate: {
              success: true,
              comment: { id: "comment_1", url: "https://linear.app/acme/issue/ENG-1#comment_1" }
            }
          }
        });
      }) as typeof fetch
    });

    const first = await sink.deliver({
      runId: "run_1",
      kind: "acknowledgement",
      provider: "linear",
      uri: "linear://issue/issue_123/comments",
      body: "OpenTag picked this up.",
      statusMessageKey: "run_1:status"
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        kind: "progress",
        provider: "linear",
        uri: "linear://issue/issue_123/comments",
        body: "OpenTag is still working.",
        statusMessageKey: "run_1:status",
        externalMessageId: first?.externalMessageId
      })
    ).resolves.toEqual({ externalMessageId: "comment_1" });

    expect(first).toEqual({ externalMessageId: "comment_1" });
    expect(requests.map((request) => request.query)).toEqual([expect.stringContaining("commentCreate"), expect.stringContaining("commentUpdate")]);
    expect(requests[0]?.variables).toMatchObject({
      input: {
        issueId: "issue_123",
        body: "OpenTag picked this up."
      }
    });
    expect(requests[1]?.variables).toMatchObject({
      id: "comment_1",
      input: {
        body: "OpenTag is still working."
      }
    });
  });

  it("updates Linear agent-session plans and posts callbacks as agent activities", async () => {
    const requests: { body: unknown }[] = [];
    const sink = createLinearCallbackSink({
      token: "Bearer app_access",
      graphqlUrl: "https://linear.example/graphql",
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        requests.push({ body });
        if (body.query.includes("agentSessionUpdate")) {
          return Response.json({
            data: {
              agentSessionUpdate: {
                success: true
              }
            }
          });
        }
        return Response.json({
          data: {
            agentActivityCreate: {
              success: true,
              agentActivity: { id: "activity_1" }
            }
          }
        });
      }) as typeof fetch
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        kind: "final",
        provider: "linear",
        uri: "linear://agent-session/agent_session_1/activities",
        body: "done"
      })
    ).resolves.toEqual({ externalMessageId: "activity_1" });

    expect(String((requests[0]!.body as { query: string }).query)).toContain("agentSessionUpdate");
    expect(requests[0]).toMatchObject({
      body: {
        variables: {
          agentSessionId: "agent_session_1",
          input: {
            plan: [
              { content: "Accept the Linear agent session", status: "completed" },
              { content: "Run OpenTag on the paired local checkout", status: "completed" },
              { content: "Report the result back to Linear", status: "completed" }
            ]
          }
        }
      }
    });
    expect(String((requests[1]!.body as { query: string }).query)).toContain("agentActivityCreate");
    expect(requests[1]).toMatchObject({
      body: {
        variables: {
          input: {
            agentSessionId: "agent_session_1",
            content: { type: "response", body: "done" }
          }
        }
      }
    });
  });

  it("marks Linear agent-session plans in progress before final completion", async () => {
    const requests: { body: unknown }[] = [];
    const sink = createLinearCallbackSink({
      token: "Bearer app_access",
      graphqlUrl: "https://linear.example/graphql",
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        requests.push({ body });
        if (body.query.includes("agentSessionUpdate")) {
          return Response.json({ data: { agentSessionUpdate: { success: true } } });
        }
        return Response.json({ data: { agentActivityCreate: { success: true, agentActivity: { id: "activity_ack" } } } });
      }) as typeof fetch
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        kind: "acknowledgement",
        provider: "linear",
        uri: "linear://agent-session/agent_session_1/activities",
        body: "OpenTag picked this up."
      })
    ).resolves.toEqual({ externalMessageId: "activity_ack" });

    expect(requests[0]).toMatchObject({
      body: {
        variables: {
          input: {
            plan: [
              { content: "Accept the Linear agent session", status: "completed" },
              { content: "Run OpenTag on the paired local checkout", status: "inProgress" },
              { content: "Report the result back to Linear", status: "pending" }
            ]
          }
        }
      }
    });
  });

  it("ignores non-GitLab callback messages in the GitLab sink", async () => {
    const sink = createGitLabCallbackSink({
      token: "glpat_test",
      fetchImpl: (async () => {
        throw new Error("should not call fetch");
      }) as typeof fetch
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        kind: "final",
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        body: "done"
      })
    ).resolves.toBeUndefined();
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

  it("updates the same GitLab callback note for a run", async () => {
    const requests: { url: string; method: string; body: unknown; token: string | null }[] = [];
    const sink = createGitLabCallbackSink({
      token: "glpat_test",
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: JSON.parse(String(init?.body)),
          token: new Headers(init?.headers).get("PRIVATE-TOKEN")
        });
        return Response.json({ id: 123, body: "ok" });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "acknowledgement",
      provider: "gitlab",
      uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
      body: "OpenTag picked this up."
    });
    await sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "gitlab",
      uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
      body: "Still working"
    });
    await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "gitlab",
      uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
      body: "Done"
    });
    await sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "gitlab",
      uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
      body: "Starting again"
    });

    expect(requests).toEqual([
      {
        url: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
        method: "POST",
        token: "glpat_test",
        body: { body: "OpenTag picked this up." }
      },
      {
        url: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes/123",
        method: "PUT",
        token: "glpat_test",
        body: { body: "Still working" }
      },
      {
        url: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes/123",
        method: "PUT",
        token: "glpat_test",
        body: { body: "Done" }
      },
      {
        url: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
        method: "POST",
        token: "glpat_test",
        body: { body: "Starting again" }
      }
    ]);
  });

  it("does not reuse a GitLab note URI when the create-note response body is null", async () => {
    const requests: { url: string; method: string; body: unknown; token: string | null }[] = [];
    const sink = createGitLabCallbackSink({
      token: "glpat_test",
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: JSON.parse(String(init?.body)),
          token: new Headers(init?.headers).get("PRIVATE-TOKEN")
        });
        return Response.json(null);
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_1",
      kind: "acknowledgement",
      provider: "gitlab",
      uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
      body: "OpenTag picked this up."
    });
    await sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "gitlab",
      uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
      body: "Still working"
    });

    expect(requests).toEqual([
      {
        url: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
        method: "POST",
        token: "glpat_test",
        body: { body: "OpenTag picked this up." }
      },
      {
        url: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
        method: "POST",
        token: "glpat_test",
        body: { body: "Still working" }
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

  it("sanitizes credential-like Slack text and blocks before provider rendering", async () => {
    const payloads: unknown[] = [];
    const raw = "xoxb\x2d1234567890-abcdefghijklmnopqrstuvwxyz";
    const sink = createSlackCallbackSink({
      botToken: "xoxb-test",
      fetchImpl: (async (_url, init) => {
        payloads.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, ts: "1710000000.000200" });
      }) as typeof fetch
    });

    await sink.deliver({
      runId: "run_safe_slack",
      kind: "final",
      provider: "slack",
      uri: "https://slack.com/api/chat.postMessage",
      threadKey: "T123|C123|1710000000.000100",
      body: `done ${raw}`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `Bearer ${raw}` } }]
    });

    expect(JSON.stringify(payloads)).not.toContain(raw);
    expect(JSON.stringify(payloads)).toContain("[redacted]");
  });

  it("posts Telegram callback messages to sendMessage without quoting non-ack messages", async () => {
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

    const result = await sink.deliver({
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
          message_thread_id: 42
        }
      }
    ]);
    expect(result).toEqual({ externalMessageId: "999" });
  });

  it("edits a Telegram status card with editMessageText after the acknowledgement", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const sink = createTelegramCallbackSink({
      botToken: "telegram-token",
      fetchImpl: (async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body))
        });
        return String(url).endsWith("/sendMessage")
          ? Response.json({ ok: true, result: { message_id: 100 } })
          : Response.json({ ok: true, result: true });
      }) as typeof fetch
    });

    const first = await sink.deliver({
      runId: "run_1",
      kind: "acknowledgement",
      provider: "telegram",
      uri: "https://api.telegram.org/sendMessage",
      threadKey: "bot_123|-1001|789|42",
      statusMessageKey: "run_1:status",
      body: "<b>OpenTag picked this up</b>",
      rich: {
        provider: "telegram",
        payload: {
          parseMode: "HTML",
          replyMarkup: {
            inline_keyboard: [[{ text: "Copy run id", copy_text: { text: "run_1" } }]]
          }
        }
      }
    });
    const second = await sink.deliver({
      runId: "run_1",
      kind: "progress",
      provider: "telegram",
      uri: "https://api.telegram.org/sendMessage",
      threadKey: "bot_123|-1001|789|42",
      statusMessageKey: "run_1:status",
      body: "<b>OpenTag is working</b>",
      rich: {
        provider: "telegram",
        payload: { parseMode: "HTML" }
      }
    });
    const final = await sink.deliver({
      runId: "run_1",
      kind: "final",
      provider: "telegram",
      uri: "https://api.telegram.org/sendMessage",
      threadKey: "bot_123|-1001|789|42",
      statusMessageKey: "run_1:status",
      body: "<b>OpenTag finished</b>",
      rich: {
        provider: "telegram",
        payload: { parseMode: "HTML" }
      }
    });

    expect(requests).toEqual([
      {
        url: "https://api.telegram.org/bottelegram-token/sendMessage",
        body: {
          chat_id: "-1001",
          text: "<b>OpenTag picked this up</b>",
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "Copy run id", copy_text: { text: "run_1" } }]]
          },
          message_thread_id: 42
        }
      },
      {
        url: "https://api.telegram.org/bottelegram-token/editMessageText",
        body: {
          chat_id: "-1001",
          message_id: 100,
          text: "<b>OpenTag is working</b>",
          parse_mode: "HTML"
        }
      },
      {
        url: "https://api.telegram.org/bottelegram-token/editMessageText",
        body: {
          chat_id: "-1001",
          message_id: 100,
          text: "<b>OpenTag finished</b>",
          parse_mode: "HTML"
        }
      }
    ]);
    expect(first).toEqual({ externalMessageId: "100" });
    expect(second).toEqual({ externalMessageId: "100" });
    expect(final).toEqual({ externalMessageId: "100" });
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

  it("updates a persisted Slack Run Card after the callback sink is recreated", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), body });
      return String(url).endsWith("/chat.postMessage")
        ? Response.json({ ok: true, ts: "1720000000.000100" })
        : Response.json({ ok: true, ts: body.ts });
    }) as typeof fetch;

    const firstSink = createSlackCallbackSink({ botToken: "xoxb-test", fetchImpl });
    const first = await firstSink.deliver({
      runId: "run_restart",
      kind: "progress",
      provider: "slack",
      uri: "https://slack-proxy.example.com/api/chat.postMessage",
      threadKey: "T123|C123|1710000000.000100",
      body: "Starting",
      statusMessageKey: "run_restart:status"
    });

    const restartedSink = createSlackCallbackSink({ botToken: "xoxb-test", fetchImpl });
    const final = await restartedSink.deliver({
      runId: "run_restart",
      kind: "final",
      provider: "slack",
      uri: "https://slack-proxy.example.com/api/chat.postMessage",
      threadKey: "T123|C123|1710000000.000100",
      body: "Finished",
      statusMessageKey: "run_restart:status",
      externalMessageId: first?.externalMessageId
    });

    expect(first).toEqual({ externalMessageId: "1720000000.000100" });
    expect(final).toEqual({ externalMessageId: "1720000000.000100" });
    expect(requests).toEqual([
      {
        url: "https://slack-proxy.example.com/api/chat.postMessage",
        body: { channel: "C123", text: "Starting", thread_ts: "1710000000.000100" }
      },
      {
        url: "https://slack-proxy.example.com/api/chat.update",
        body: { channel: "C123", text: "Finished", ts: "1720000000.000100" }
      }
    ]);
  });

  it("updates a persisted Slack Run Card through the delivery repository after process restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opentag-slack-restart-"));
    const databasePath = join(directory, "dispatcher.sqlite");
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), body });
      return String(url).endsWith("/chat.postMessage")
        ? Response.json({ ok: true, ts: "1720000000.000100" })
        : Response.json({ ok: true, ts: body.ts });
    }) as typeof fetch;

    try {
      const firstSqlite = new Database(databasePath);
      migrateSchema(firstSqlite);
      const firstRepo = createOpenTagRepository(drizzle(firstSqlite));
      await firstRepo.enqueueCallbackDelivery({
        runId: "run_repository_restart",
        kind: "progress",
        provider: "slack",
        uri: "https://slack-proxy.example.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100",
        body: "Starting",
        statusMessageKey: "run_repository_restart:status"
      });
      await expect(
        processPendingCallbacks({
          repo: firstRepo,
          sink: createSlackCallbackSink({ botToken: "xoxb-test", fetchImpl })
        })
      ).resolves.toEqual({ processed: 1, delivered: 1, failed: 0 });
      firstSqlite.close();

      const restartedSqlite = new Database(databasePath);
      migrateSchema(restartedSqlite);
      const restartedRepo = createOpenTagRepository(drizzle(restartedSqlite));
      await restartedRepo.enqueueCallbackDelivery({
        runId: "run_repository_restart",
        kind: "final",
        provider: "slack",
        uri: "https://slack-proxy.example.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100",
        body: "Finished",
        statusMessageKey: "run_repository_restart:status"
      });
      await expect(
        processPendingCallbacks({
          repo: restartedRepo,
          sink: createSlackCallbackSink({ botToken: "xoxb-test", fetchImpl })
        })
      ).resolves.toEqual({ processed: 1, delivered: 1, failed: 0 });
      restartedSqlite.close();

      expect(requests).toEqual([
        {
          url: "https://slack-proxy.example.com/api/chat.postMessage",
          body: { channel: "C123", text: "Starting", thread_ts: "1710000000.000100" }
        },
        {
          url: "https://slack-proxy.example.com/api/chat.update",
          body: { channel: "C123", text: "Finished", ts: "1720000000.000100" }
        }
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("surfaces Slack bot permission errors instead of silently dropping callbacks", async () => {
    const sink = createSlackCallbackSink({
      botToken: "xoxb-no-channel-access",
      fetchImpl: (async () => Response.json({ ok: false, error: "not_in_channel" })) as typeof fetch
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        kind: "final",
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100",
        body: "done"
      })
    ).rejects.toThrow("not_in_channel");
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

  it("sanitizes credential-like Lark text and cards before provider rendering", async () => {
    const replies: unknown[] = [];
    const raw = "xoxb\x2d1234567890-abcdefghijklmnopqrstuvwxyz";
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
      runId: "run_safe_lark",
      kind: "final",
      provider: "lark",
      uri: "lark://im/v1/messages",
      threadKey: "tenant_1|oc_chat|om_msg",
      body: `done ${raw}`,
      rich: {
        provider: "lark",
        payload: {
          header: { title: { tag: "plain_text", content: `done ${raw}` } },
          elements: [{ tag: "div", text: { tag: "lark_md", content: `Bearer ${raw}` } }]
        }
      }
    });

    expect(JSON.stringify(replies)).not.toContain(raw);
    expect(JSON.stringify(replies)).toContain("[redacted]");
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

  it("surfaces Lark bot permission errors instead of pretending the card was delivered", async () => {
    const sink = createLarkCallbackSink({
      client: {
        im: {
          message: {
            async reply() {
              throw new Error("Lark API permission denied: im:message");
            }
          }
        }
      }
    });

    await expect(
      sink.deliver({
        runId: "run_1",
        kind: "final",
        provider: "lark",
        uri: "lark://im/v1/messages",
        threadKey: "tenant_1|oc_chat|om_source",
        body: "Finished."
      })
    ).rejects.toThrow("Lark API permission denied");
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

describe("createDiscordCallbackSink", () => {
  const uri = "https://discord.com/api/v10/channels/c1/messages";

  it("truncates content over Discord's 2000-character limit", async () => {
    const bodies: string[] = [];
    const sink = createDiscordCallbackSink({
      token: "bot_test",
      fetchImpl: (async (_url, init) => {
        bodies.push((JSON.parse(String(init?.body)) as { content: string }).content);
        return Response.json({ id: "m1" });
      }) as typeof fetch
    });

    await sink.deliver({ runId: "run_1", kind: "final", provider: "discord", uri, body: "a".repeat(5000) });

    expect(bodies[0]!.length).toBe(2000);
    expect(bodies[0]!.endsWith("...")).toBe(true);
  });

  it("bounds the request with an abort signal", async () => {
    let signal: AbortSignal | null | undefined;
    const sink = createDiscordCallbackSink({
      token: "bot_test",
      fetchImpl: (async (_url, init) => {
        signal = init?.signal;
        return Response.json({ id: "m1" });
      }) as typeof fetch
    });

    await sink.deliver({ runId: "run_1", kind: "final", provider: "discord", uri, body: "hi" });

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps delivering later updates after an earlier one fails in the chain", async () => {
    let calls = 0;
    const sink = createDiscordCallbackSink({
      token: "bot_test",
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) return new Response("boom", { status: 500 });
        return Response.json({ id: "m2" });
      }) as typeof fetch
    });

    // Start the second delivery before the first settles so it chains onto the failing one.
    const first = sink.deliver({ runId: "run_1", kind: "progress", provider: "discord", uri, body: "first" });
    const second = sink.deliver({ runId: "run_1", kind: "final", provider: "discord", uri, body: "second" });
    await Promise.allSettled([first, second]);

    expect(calls).toBe(2);
  });

  it("suppresses mentions on both the initial post and the edit", async () => {
    const payloads: Array<{ allowed_mentions?: { parse: string[] } }> = [];
    const sink = createDiscordCallbackSink({
      token: "bot_test",
      fetchImpl: (async (_url, init) => {
        payloads.push(JSON.parse(String(init?.body)) as { allowed_mentions?: { parse: string[] } });
        return Response.json({ id: "m1" });
      }) as typeof fetch
    });

    await sink.deliver({ runId: "run_1", kind: "acknowledgement", provider: "discord", uri, body: "hi @everyone" });
    await sink.deliver({ runId: "run_1", kind: "progress", provider: "discord", uri, body: "working" });

    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(payload.allowed_mentions).toEqual({ parse: [] });
    }
  });
});
