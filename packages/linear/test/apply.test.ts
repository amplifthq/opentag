import { describe, expect, it } from "vitest";
import { applyLinearMutationIntent, compileLinearMutationIntent, createLinearIssueComment, updateLinearComment } from "../src/apply.js";

describe("Linear apply helpers", () => {
  it("compiles Linear issue update intents", () => {
    expect(
      compileLinearMutationIntent({
        intentId: "intent_status",
        domain: "status",
        action: "transition_status",
        summary: "Move to In Progress.",
        params: { stateId: "state_progress" }
      })
    ).toEqual({
      ok: true,
      intentId: "intent_status",
      operation: {
        kind: "update_issue",
        intentId: "intent_status",
        input: { stateId: "state_progress" }
      }
    });

    expect(
      compileLinearMutationIntent({
        intentId: "intent_priority",
        domain: "priority",
        action: "set_priority",
        summary: "Set P1.",
        params: { priority: "1" }
      })
    ).toEqual({
      ok: true,
      intentId: "intent_priority",
      operation: {
        kind: "update_issue",
        intentId: "intent_priority",
        input: { priority: 1 }
      }
    });
  });

  it("maps semantic Linear status values through adapter mappings", () => {
    expect(
      compileLinearMutationIntent(
        {
          intentId: "intent_status",
          domain: "status",
          action: "transition_status",
          summary: "Move to Blocked.",
          params: { status: "blocked" }
        },
        {
          mappings: [
            {
              id: "linear_status",
              adapter: "linear",
              domain: "status",
              strategy: "state_id",
              values: { blocked: "state_blocked" }
            }
          ]
        }
      )
    ).toEqual({
      ok: true,
      intentId: "intent_status",
      operation: {
        kind: "update_issue",
        intentId: "intent_status",
        input: { stateId: "state_blocked" }
      }
    });
  });

  it("maps semantic Linear assignee and label values through adapter mappings", () => {
    expect(
      compileLinearMutationIntent(
        {
          intentId: "intent_assignee",
          domain: "assignee",
          action: "set_assignee",
          summary: "Assign to Ada.",
          params: { assignee: "ada" }
        },
        {
          mappings: [
            {
              id: "linear_assignee",
              adapter: "linear",
              domain: "assignee",
              strategy: "user_id",
              values: { ada: "user_ada" }
            }
          ]
        }
      )
    ).toMatchObject({
      ok: true,
      operation: {
        kind: "update_issue",
        input: { assigneeId: "user_ada" }
      }
    });

    expect(
      compileLinearMutationIntent(
        {
          intentId: "intent_labels",
          domain: "label",
          action: "set_labels",
          summary: "Add bug and urgent labels.",
          params: { labels: ["bug", "urgent"] }
        },
        {
          mappings: [
            {
              id: "linear_labels",
              adapter: "linear",
              domain: "label",
              strategy: "label_id",
              values: { bug: "label_bug", urgent: "label_urgent" }
            }
          ]
        }
      )
    ).toMatchObject({
      ok: true,
      operation: {
        kind: "update_issue",
        input: { labelIds: ["label_bug", "label_urgent"] }
      }
    });
  });

  it("compiles Linear issue create intents", () => {
    expect(
      compileLinearMutationIntent({
        intentId: "intent_create_issue",
        domain: "issue",
        action: "create_issue",
        summary: "Create a Linear issue.",
        params: {
          title: "Fix OAuth callback error",
          description: "Created from a Slack thread.",
          teamId: "team_eng",
          projectId: "project_auth",
          priority: "2",
          labelIds: ["label_bug"],
          assigneeId: "user_ada"
        }
      })
    ).toEqual({
      ok: true,
      intentId: "intent_create_issue",
      operation: {
        kind: "create_issue",
        intentId: "intent_create_issue",
        input: {
          title: "Fix OAuth callback error",
          description: "Created from a Slack thread.",
          teamId: "team_eng",
          projectId: "project_auth",
          priority: 2,
          labelIds: ["label_bug"],
          assigneeId: "user_ada"
        }
      }
    });
  });

  it("requires a title for Linear issue create intents", () => {
    expect(
      compileLinearMutationIntent({
        intentId: "intent_create_issue",
        domain: "issue",
        action: "create_issue",
        summary: "Create a Linear issue.",
        params: { teamId: "team_eng" }
      })
    ).toEqual({
      ok: false,
      outcome: {
        intentId: "intent_create_issue",
        outcome: "failed",
        message: "create_issue requires params.title."
      }
    });
  });

  it("requires a resolvable team for Linear issue create intents", () => {
    expect(
      compileLinearMutationIntent({
        intentId: "intent_create_issue",
        domain: "issue",
        action: "create_issue",
        summary: "Create a Linear issue.",
        params: { title: "Fix OAuth callback error" }
      })
    ).toEqual({
      ok: false,
      outcome: {
        intentId: "intent_create_issue",
        outcome: "unsupported",
        message: "Linear issue creation requires params.teamId, a mapped params.team/teamKey, or a single discovered Linear team mapping."
      }
    });
  });

  it("maps Linear issue create semantic fields through adapter mappings", () => {
    expect(
      compileLinearMutationIntent(
        {
          intentId: "intent_create_issue",
          domain: "issue",
          action: "create_issue",
          summary: "Create a Linear issue.",
          params: {
            title: "Fix OAuth callback error",
            body: "Created from a Slack thread.",
            teamKey: "ENG",
            priority: "high",
            labels: ["bug"],
            assignee: "ada"
          }
        },
        {
          mappings: [
            {
              id: "linear_team",
              adapter: "linear",
              domain: "team",
              strategy: "team_id",
              values: { eng: "team_eng" }
            },
            {
              id: "linear_priority",
              adapter: "linear",
              domain: "priority",
              strategy: "priority",
              values: { high: "2" }
            },
            {
              id: "linear_label",
              adapter: "linear",
              domain: "label",
              strategy: "label_id",
              values: { bug: "label_bug" }
            },
            {
              id: "linear_assignee",
              adapter: "linear",
              domain: "assignee",
              strategy: "user_id",
              values: { ada: "user_ada" }
            }
          ]
        }
      )
    ).toMatchObject({
      ok: true,
      operation: {
        kind: "create_issue",
        input: {
          title: "Fix OAuth callback error",
          description: "Created from a Slack thread.",
          teamId: "team_eng",
          priority: 2,
          labelIds: ["label_bug"],
          assigneeId: "user_ada"
        }
      }
    });
  });

  it("posts Linear comments through GraphQL", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const fetchImpl = (async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body))
      });
      return Response.json({
        data: {
          commentCreate: {
            success: true,
            comment: { id: "comment_1", url: "https://linear.app/acme/issue/ENG-123#comment-comment_1" }
          }
        }
      });
    }) as typeof fetch;

    await expect(
      createLinearIssueComment({
        token: "lin_api_test",
        issueId: "issue_123",
        body: "OpenTag picked this up.",
        fetchImpl
      })
    ).resolves.toBe("https://linear.app/acme/issue/ENG-123#comment-comment_1");

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://api.linear.app/graphql",
      authorization: "lin_api_test",
      body: {
        variables: {
          input: {
            issueId: "issue_123",
            body: "OpenTag picked this up."
          }
        }
      }
    });
  });

  it("passes OAuth bearer tokens through for Linear GraphQL", async () => {
    const requests: Array<{ authorization: string | null }> = [];
    const fetchImpl = (async (_url, init) => {
      requests.push({ authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({
        data: {
          commentCreate: {
            success: true,
            comment: { id: "comment_1", url: "https://linear.app/acme/issue/ENG-123#comment-comment_1" }
          }
        }
      });
    }) as typeof fetch;

    await createLinearIssueComment({
      token: "Bearer oauth_access_token",
      issueId: "issue_123",
      body: "OpenTag picked this up.",
      fetchImpl
    });

    expect(requests).toEqual([{ authorization: "Bearer oauth_access_token" }]);
  });

  it("normalizes raw OAuth access tokens for Linear GraphQL", async () => {
    const requests: Array<{ authorization: string | null }> = [];
    const fetchImpl = (async (_url, init) => {
      requests.push({ authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({
        data: {
          commentCreate: {
            success: true,
            comment: { id: "comment_1", url: "https://linear.app/acme/issue/ENG-123#comment-comment_1" }
          }
        }
      });
    }) as typeof fetch;

    await createLinearIssueComment({
      token: "oauth_access_token",
      issueId: "issue_123",
      body: "OpenTag picked this up.",
      fetchImpl
    });

    expect(requests).toEqual([{ authorization: "Bearer oauth_access_token" }]);
  });

  it("applies Linear issue updates through GraphQL", async () => {
    const requests: Array<{ body: unknown }> = [];
    const fetchImpl = (async (_url, init) => {
      requests.push({ body: JSON.parse(String(init?.body)) });
      return Response.json({ data: { issueUpdate: { success: true, issue: { url: "https://linear.app/acme/issue/ENG-123" } } } });
    }) as typeof fetch;

    await expect(
      applyLinearMutationIntent({
        target: { token: "lin_api_test", issueId: "issue_123" },
        fetchImpl,
        intent: {
          intentId: "intent_status",
          domain: "status",
          action: "transition_status",
          summary: "Move to In Progress.",
          params: { stateId: "state_progress" }
        }
      })
    ).resolves.toMatchObject({ intentId: "intent_status", outcome: "applied", externalUri: "https://linear.app/acme/issue/ENG-123" });

    expect(requests[0]).toMatchObject({
      body: {
        variables: {
          id: "issue_123",
          input: { stateId: "state_progress" }
        }
      }
    });
  });

  it("applies Linear issue creates through GraphQL", async () => {
    const requests: Array<{ body: unknown }> = [];
    const fetchImpl = (async (_url, init) => {
      requests.push({ body: JSON.parse(String(init?.body)) });
      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: { id: "issue_created", url: "https://linear.app/acme/issue/ENG-456/fix-oauth-callback-error" }
          }
        }
      });
    }) as typeof fetch;

    await expect(
      applyLinearMutationIntent({
        target: { token: "lin_api_test" },
        fetchImpl,
        mappings: [
          {
            id: "linear_team",
            adapter: "linear",
            domain: "team",
            strategy: "team_id",
            values: { eng: "team_eng" }
          }
        ],
        intent: {
          intentId: "intent_create_issue",
          domain: "issue",
          action: "create_issue",
          summary: "Create a Linear issue.",
          params: {
            title: "Fix OAuth callback error",
            body: "Created from a Slack thread.",
            teamKey: "ENG"
          }
        }
      })
    ).resolves.toMatchObject({
      intentId: "intent_create_issue",
      outcome: "applied",
      externalId: "issue_created",
      externalUri: "https://linear.app/acme/issue/ENG-456/fix-oauth-callback-error"
    });

    expect(requests[0]).toMatchObject({
      body: {
        variables: {
          input: {
            title: "Fix OAuth callback error",
            description: "Created from a Slack thread.",
            teamId: "team_eng"
          }
        }
      }
    });
    expect(String((requests[0]!.body as { query: string }).query)).toContain("issueCreate");
  });

  it("updates existing Linear comments through GraphQL", async () => {
    const requests: Array<{ body: unknown }> = [];
    const fetchImpl = (async (_url, init) => {
      requests.push({ body: JSON.parse(String(init?.body)) });
      return Response.json({ data: { commentUpdate: { success: true, comment: { id: "comment_1", url: "https://linear.app/acme/issue/ENG-123#comment_1" } } } });
    }) as typeof fetch;

    await expect(
      updateLinearComment({
        token: "lin_api_test",
        commentId: "comment_1",
        body: "Updated OpenTag status.",
        fetchImpl
      })
    ).resolves.toBe("https://linear.app/acme/issue/ENG-123#comment_1");

    expect(requests[0]).toMatchObject({
      body: {
        variables: {
          id: "comment_1",
          input: { body: "Updated OpenTag status." }
        }
      }
    });
  });
});
