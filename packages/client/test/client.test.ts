import type { OpenTagEvent } from "@opentag/core";
import { describe, expect, it } from "vitest";
import { createOpenTagClient } from "../src/index.js";

const event: OpenTagEvent = {
  id: "evt_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42", handle: "octocat" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix", args: {} },
  context: [],
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("@opentag/client", () => {
  it("creates dispatcher runs with validated event payloads and auth headers", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test/",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({
          run: {
            id: "run_1",
            eventId: "evt_1",
            status: "queued",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          }
        });
      }
    });

    const { run } = await client.createRun({ runId: "run_1", event });

    expect(run.id).toBe("run_1");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/runs");
    expect(requests[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer pair_1"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      runId: "run_1",
      event: { id: "evt_1", command: { rawText: "fix this" } }
    });
  });

  it("returns null when a runner claim has no available work", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () => new Response(null, { status: 204 })
    });

    await expect(client.claim({ runnerId: "runner_1" })).resolves.toBeNull();
  });

  it("parses claimed run responses", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () =>
        jsonResponse({
          run: {
            id: "run_1",
            eventId: "evt_1",
            status: "assigned",
            assignedRunnerId: "runner_1",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          },
          event
        })
    });

    const claimed = await client.claim({ runnerId: "runner_1" });

    expect(claimed?.run.status).toBe("assigned");
    expect(claimed?.event.id).toBe("evt_1");
  });

  it("includes dispatcher error bodies in thrown errors", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () => jsonResponse({ error: "repo_not_bound" }, 403)
    });

    await expect(client.createRun({ runId: "run_1", event })).rejects.toThrow(
      'createRun failed: 403 {"error":"repo_not_bound"}'
    );
  });

  it("calls proposal approval and apply-plan endpoints", async () => {
    const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          authorization: new Headers(init?.headers).get("authorization")
        });
        if (String(url).endsWith("/approvals")) {
          return jsonResponse({
            decision: {
              id: "approval_1",
              proposalId: "proposal_1",
              approvedIntentIds: ["intent_1"],
              approvedBy: { provider: "github", providerUserId: "42" },
              approvedAt: "2026-06-24T00:00:00.000Z",
              scope: "manual"
            }
          }, 201);
        }
        return jsonResponse({
          plan: {
            id: "apply_1",
            proposalId: "proposal_1",
            approvalDecisionId: "approval_1",
            selectedIntentIds: ["intent_1"],
            mode: "preflight_then_per_intent",
            outcomes: [{ intentId: "intent_1", outcome: "skipped" }]
          }
        }, 201);
      }
    });

    await expect(
      client.approveProposal({
        proposalId: "proposal_1",
        id: "approval_1",
        approvedIntentIds: ["intent_1"],
        approvedBy: { provider: "github", providerUserId: "42" },
        approvedAt: "2026-06-24T00:00:00.000Z"
      })
    ).resolves.toMatchObject({ decision: { id: "approval_1" } });
    await expect(
      client.createApplyPlan({
        proposalId: "proposal_1",
        id: "apply_1",
        approvalDecisionId: "approval_1",
        adapter: "github"
      })
    ).resolves.toMatchObject({ plan: { id: "apply_1" } });

    expect(requests).toEqual([
      {
        url: "http://dispatcher.test/v1/proposals/proposal_1/approvals",
        authorization: "Bearer pair_1",
        body: {
          id: "approval_1",
          approvedIntentIds: ["intent_1"],
          approvedBy: { provider: "github", providerUserId: "42" },
          approvedAt: "2026-06-24T00:00:00.000Z"
        }
      },
      {
        url: "http://dispatcher.test/v1/proposals/proposal_1/apply-plans",
        authorization: "Bearer pair_1",
        body: {
          id: "apply_1",
          approvalDecisionId: "approval_1",
          adapter: "github"
        }
      }
    ]);
  });

  it("calls repo policy rule endpoints", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
        });
        if (init?.method === "POST") {
          return jsonResponse({
            rule: {
              id: "repo_allows_labels",
              scope: "work_context_owner_container",
              effect: "allow",
              capabilityId: "set_labels",
              reason: "Repo allows labels."
            }
          }, 201);
        }
        return jsonResponse({
          rules: [
            {
              id: "repo_allows_labels",
              scope: "work_context_owner_container",
              effect: "allow",
              capabilityId: "set_labels",
              reason: "Repo allows labels."
            }
          ]
        });
      }
    });

    await expect(
      client.upsertRepoPolicyRule({
        provider: "github",
        owner: "acme",
        repo: "demo",
        rule: {
          id: "repo_allows_labels",
          scope: "work_context_owner_container",
          effect: "allow",
          capabilityId: "set_labels",
          reason: "Repo allows labels."
        }
      })
    ).resolves.toMatchObject({ rule: { id: "repo_allows_labels" } });
    await expect(client.listRepoPolicyRules({ provider: "github", owner: "acme", repo: "demo" })).resolves.toMatchObject({
      rules: [{ id: "repo_allows_labels" }]
    });

    expect(requests).toEqual([
      {
        url: "http://dispatcher.test/v1/repo-bindings/github/acme/demo/policy-rules",
        method: "POST",
        body: {
          rule: {
            id: "repo_allows_labels",
            scope: "work_context_owner_container",
            effect: "allow",
            capabilityId: "set_labels",
            reason: "Repo allows labels."
          }
        }
      },
      {
        url: "http://dispatcher.test/v1/repo-bindings/github/acme/demo/policy-rules",
        method: "GET"
      }
    ]);
  });

  it("calls repo mutation mapping endpoints", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const mapping = {
      id: "github_status_labels",
      adapter: "github" as const,
      domain: "status" as const,
      strategy: "label" as const,
      values: { blocked: "status/blocked" }
    };
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
        });
        if (init?.method === "POST") {
          return jsonResponse({ mapping }, 201);
        }
        return jsonResponse({ mappings: [mapping] });
      }
    });

    await expect(
      client.upsertRepoMutationMapping({
        provider: "github",
        owner: "acme",
        repo: "demo",
        mapping
      })
    ).resolves.toMatchObject({ mapping: { id: "github_status_labels" } });
    await expect(client.listRepoMutationMappings({ provider: "github", owner: "acme", repo: "demo" })).resolves.toMatchObject({
      mappings: [{ id: "github_status_labels" }]
    });

    expect(requests).toEqual([
      {
        url: "http://dispatcher.test/v1/repo-bindings/github/acme/demo/mutation-mappings",
        method: "POST",
        body: { mapping }
      },
      {
        url: "http://dispatcher.test/v1/repo-bindings/github/acme/demo/mutation-mappings",
        method: "GET"
      }
    ]);
  });

  it("calls aggregate metrics endpoints", async () => {
    const requests: string[] = [];
    const metrics = {
      scope: "repo",
      scopeId: "github:acme/demo",
      runCount: 2,
      totalEventCount: 10,
      humanEventCount: 2,
      auditEventCount: 8,
      debugEventCount: 0,
      humanCallbackCount: 2,
      threadNoiseRatio: 0.25,
      suggestedChangesCount: 2,
      approvalDecisionCount: 1,
      applyPlanCount: 1,
      childRunCount: 1,
      applyOutcomeCounts: { applied: 0, skipped: 1, failed: 0, stale: 0, unsupported: 0 },
      staleIntentCount: 0
    };
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async (url) => {
        requests.push(String(url));
        return jsonResponse({ metrics });
      }
    });

    await expect(client.getRepoMetrics({ provider: "github", owner: "acme", repo: "demo" })).resolves.toMatchObject({
      metrics: { scope: "repo", runCount: 2 }
    });
    await expect(client.getWorkThreadMetrics({ threadId: "thread/github/acme/demo#1" })).resolves.toMatchObject({
      metrics: { runCount: 2 }
    });

    expect(requests).toEqual([
      "http://dispatcher.test/v1/repo-bindings/github/acme/demo/metrics",
      "http://dispatcher.test/v1/work-thread-metrics?threadId=thread%2Fgithub%2Facme%2Fdemo%231"
    ]);
  });
});
