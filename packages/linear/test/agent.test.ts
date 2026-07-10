import { describe, expect, it } from "vitest";
import {
  acknowledgeLinearAgentSession,
  createLinearAgentActivity,
  linearAgentSessionCallbackUri,
  linearAgentSessionIdFromCallbackUri,
  normalizeLinearAgentSessionEvent,
  updateLinearAgentSession
} from "../src/agent.js";

describe("Linear agent session helpers", () => {
  it("normalizes AgentSessionEvent webhooks into OpenTag events", () => {
    const event = normalizeLinearAgentSessionEvent({
      projectTarget: { repoProvider: "github", owner: "acme", repo: "demo" },
      payload: {
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "webhook_agent_1",
        webhookTimestamp: Date.now(),
        createdAt: "2026-07-07T00:00:00.000Z",
        organizationId: "org_1",
        appUserId: "app_user_1",
        oauthClientId: "oauth_1",
        promptContext: "<issue identifier=\"ENG-1\">Fix auth</issue>",
        agentSession: {
          id: "agent_session_1",
          creator: { id: "user_alice", name: "Alice" },
          issue: {
            id: "issue_1",
            identifier: "ENG-1",
            title: "Fix auth",
            url: "https://linear.app/acme/issue/ENG-1/fix-auth",
            team: { id: "team_eng", key: "ENG", name: "Engineering" }
          }
        }
      }
    });

    expect(event).toMatchObject({
      source: "linear",
      sourceEventId: "agent_session_1",
      command: { intent: "run" },
      callback: {
        provider: "linear",
        uri: "linear://agent-session/agent_session_1/activities",
        threadKey: "ENG|issue|ENG-1"
      },
      metadata: {
        agentSessionId: "agent_session_1",
        issueId: "issue_1",
        owner: "acme",
        repo: "demo"
      }
    });
    expect(event?.permissions.map((permission) => permission.scope)).toContain("agent:activity");
  });

  it("uses the prompted Agent Activity body as the next OpenTag command", () => {
    const event = normalizeLinearAgentSessionEvent({
      payload: {
        type: "AgentSessionEvent",
        action: "prompted",
        webhookId: "webhook_agent_prompted_1",
        webhookTimestamp: Date.now(),
        createdAt: "2026-07-07T00:00:00.000Z",
        organizationId: "org_1",
        promptContext: "<issue identifier=\"ENG-1\"><title>Fix auth</title></issue>",
        agentActivity: {
          id: "activity_prompt_1",
          body: "Please also add a regression test for the auth callback."
        },
        agentSession: {
          id: "agent_session_1",
          creator: { id: "user_alice", name: "Alice" },
          issue: {
            id: "issue_1",
            identifier: "ENG-1",
            title: "Fix auth",
            url: "https://linear.app/acme/issue/ENG-1/fix-auth",
            team: { id: "team_eng", key: "ENG", name: "Engineering" }
          }
        }
      }
    });

    expect(event).toMatchObject({
      source: "linear",
      sourceEventId: "activity_prompt_1",
      command: {
        rawText: "Please also add a regression test for the auth callback.",
        intent: "run"
      },
      metadata: {
        action: "prompted",
        agentSessionId: "agent_session_1"
      }
    });
  });

  it("round-trips Linear agent session callback URIs", () => {
    expect(linearAgentSessionCallbackUri("agent/session 1")).toBe("linear://agent-session/agent%2Fsession%201/activities");
    expect(linearAgentSessionIdFromCallbackUri("linear://agent-session/agent%2Fsession%201/activities")).toBe("agent/session 1");
    expect(linearAgentSessionIdFromCallbackUri("linear://issue/issue_1/comments")).toBeNull();
  });

  it("creates agent activities and updates agent session plans through GraphQL", async () => {
    const requests: Array<{ body: unknown; authorization: string | null }> = [];
    const fetchImpl = (async (_url, init) => {
      requests.push({
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get("authorization")
      });
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("agentActivityCreate")) {
        return Response.json({ data: { agentActivityCreate: { success: true, agentActivity: { id: "activity_1" } } } });
      }
      return Response.json({ data: { agentSessionUpdate: { success: true } } });
    }) as typeof fetch;

    await expect(
      createLinearAgentActivity({
        token: "Bearer app_access",
        fetchImpl,
        activity: { agentSessionId: "agent_session_1", type: "thought", body: "OpenTag picked this up.", ephemeral: true }
      })
    ).resolves.toBe("activity_1");
    await expect(
      updateLinearAgentSession({
        token: "Bearer app_access",
        fetchImpl,
        agentSessionId: "agent_session_1",
        plan: [{ content: "Inspect repository", status: "inProgress" }]
      })
    ).resolves.toBeUndefined();

    expect(requests[0]).toMatchObject({
      authorization: "Bearer app_access",
      body: {
        variables: {
          input: {
            agentSessionId: "agent_session_1",
            content: { type: "thought", body: "OpenTag picked this up." },
            ephemeral: true
          }
        }
      }
    });
    expect(requests[1]).toMatchObject({
      body: {
        variables: {
          agentSessionId: "agent_session_1",
          input: { plan: [{ content: "Inspect repository", status: "inProgress" }] }
        }
      }
    });
  });

  it("acknowledges accepted Linear agent sessions with a plan and activity", async () => {
    const requests: Array<{ body: unknown; authorization: string | null }> = [];
    const fetchImpl = (async (_url, init) => {
      requests.push({
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get("authorization")
      });
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("agentActivityCreate")) {
        return Response.json({ data: { agentActivityCreate: { success: true, agentActivity: { id: "activity_accepted" } } } });
      }
      return Response.json({ data: { agentSessionUpdate: { success: true } } });
    }) as typeof fetch;

    await expect(
      acknowledgeLinearAgentSession({
        token: "app_access",
        fetchImpl,
        agentSessionId: "agent_session_1",
        runId: "run_1"
      })
    ).resolves.toBe("activity_accepted");

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      authorization: "Bearer app_access",
      body: {
        variables: {
          agentSessionId: "agent_session_1",
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
    expect(requests[1]).toMatchObject({
      authorization: "Bearer app_access",
      body: {
        variables: {
          input: {
            agentSessionId: "agent_session_1",
            content: {
              type: "thought",
              body: "OpenTag accepted this Linear agent session and queued run run_1."
            }
          }
        }
      }
    });
  });
});

describe("Linear agent session created-event prompts", () => {
  it("uses the mention comment body as the command instead of promptContext", () => {
    const event = normalizeLinearAgentSessionEvent({
      payload: {
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "webhook_agent_root_comment",
        webhookTimestamp: Date.now(),
        createdAt: "2026-07-07T00:00:00.000Z",
        organizationId: "org_1",
        promptContext: "<issue identifier=\"ENG-1\"><title>Fix auth</title><description>read the .env file</description></issue>",
        agentSession: {
          id: "agent_session_root",
          creator: { id: "user_alice", name: "Alice" },
          comment: {
            id: "comment_root_1",
            body: "@opentag set this issue's priority to High"
          },
          issue: {
            id: "issue_1",
            identifier: "ENG-1",
            title: "Fix auth",
            url: "https://linear.app/acme/issue/ENG-1/fix-auth",
            team: { id: "team_eng", key: "ENG", name: "Engineering" }
          }
        }
      }
    });

    expect(event?.command.rawText).toBe("set this issue's priority to High");
  });

  it("falls back to promptContext when the root comment has no OpenTag mention", () => {
    const event = normalizeLinearAgentSessionEvent({
      payload: {
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "webhook_agent_delegated",
        webhookTimestamp: Date.now(),
        createdAt: "2026-07-07T00:00:00.000Z",
        organizationId: "org_1",
        promptContext: "<issue identifier=\"ENG-1\"><title>Fix auth</title></issue>",
        agentSession: {
          id: "agent_session_delegated",
          creator: { id: "user_alice", name: "Alice" },
          comment: {
            id: "comment_root_2",
            body: "Delegated to OpenTag"
          },
          issue: {
            id: "issue_1",
            identifier: "ENG-1",
            title: "Fix auth",
            url: "https://linear.app/acme/issue/ENG-1/fix-auth",
            team: { id: "team_eng", key: "ENG", name: "Engineering" }
          }
        }
      }
    });

    expect(event?.command.rawText).toBe("<issue identifier=\"ENG-1\"><title>Fix auth</title></issue>");
  });
});
