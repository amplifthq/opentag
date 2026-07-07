import { describe, expect, it, vi } from "vitest";
import { computeLinearSignature, createLinearWebhookApp, verifyLinearSignature, verifyLinearWebhookTimestamp } from "../src/ingress.js";

const WEBHOOK_NOW = "2026-07-07T00:00:00.000Z";
const WEBHOOK_TIMESTAMP = Date.parse(WEBHOOK_NOW);

function signedHeaders(secret: string, rawBody: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "linear-signature": computeLinearSignature({ webhookSecret: secret, rawBody }),
    "linear-timestamp": String(WEBHOOK_TIMESTAMP)
  };
}

describe("Linear webhook ingress", () => {
  it("verifies Linear HMAC signatures", () => {
    const rawBody = JSON.stringify({ type: "Comment" });
    const signature = computeLinearSignature({ webhookSecret: "secret", rawBody });
    expect(verifyLinearSignature({ webhookSecret: "secret", rawBody, signature })).toBe(true);
    expect(verifyLinearSignature({ webhookSecret: "secret", rawBody, signature: `sha256=${signature}` })).toBe(true);
    expect(verifyLinearSignature({ webhookSecret: "wrong", rawBody, signature })).toBe(false);
  });

  it("verifies Linear webhook timestamps within the replay window", () => {
    expect(verifyLinearWebhookTimestamp({ timestampMs: WEBHOOK_TIMESTAMP, nowMs: WEBHOOK_TIMESTAMP })).toBe(true);
    expect(verifyLinearWebhookTimestamp({ timestampMs: WEBHOOK_TIMESTAMP - 60_001, nowMs: WEBHOOK_TIMESTAMP })).toBe(false);
    expect(verifyLinearWebhookTimestamp({ timestampMs: null, nowMs: WEBHOOK_TIMESTAMP })).toBe(false);
  });

  it("creates a run for signed @opentag issue comments", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_linear_1" }));
    const app = createLinearWebhookApp({
      webhookSecret: "linear_secret",
      projectTarget: { repoProvider: "github", owner: "acme", repo: "demo" },
      createRun,
      now: () => WEBHOOK_NOW
    });
    const rawBody = JSON.stringify({
      type: "Comment",
      action: "create",
      webhookId: "webhook_1",
      organizationId: "org_acme",
      createdAt: "2026-07-07T00:00:00.000Z",
      webhookTimestamp: WEBHOOK_TIMESTAMP,
      data: {
        id: "comment_1",
        body: "@opentag investigate this",
        url: "https://linear.app/acme/issue/ENG-123#comment-comment_1",
        issue: {
          id: "issue_123",
          identifier: "ENG-123",
          title: "Fix import",
          url: "https://linear.app/acme/issue/ENG-123/fix-import",
          team: { id: "team_eng", key: "ENG", name: "Engineering" }
        },
        user: { id: "user_alice", displayName: "Alice" }
      }
    });

    const response = await app.request("/linear/webhooks", {
      method: "POST",
      headers: signedHeaders("linear_secret", rawBody),
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, runId: "run_linear_1" });
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "linear",
        sourceEventId: "webhook_1",
        metadata: expect.objectContaining({ owner: "acme", repo: "demo" })
      })
    );
  });

  it("creates a run for signed AgentSessionEvent webhooks", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_linear_agent_1" }));
    const onAgentSessionAccepted = vi.fn(async () => undefined);
    const app = createLinearWebhookApp({
      webhookSecret: "linear_secret",
      projectTarget: { repoProvider: "github", owner: "acme", repo: "demo" },
      createRun,
      onAgentSessionAccepted,
      now: () => WEBHOOK_NOW
    });
    const rawBody = JSON.stringify({
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "webhook_agent_1",
      organizationId: "org_acme",
      createdAt: "2026-07-07T00:00:00.000Z",
      webhookTimestamp: WEBHOOK_TIMESTAMP,
      promptContext: "<issue identifier=\"ENG-123\">Fix import</issue>",
      agentSession: {
        id: "agent_session_1",
        creator: { id: "user_alice", name: "Alice" },
        issue: {
          id: "issue_123",
          identifier: "ENG-123",
          title: "Fix import",
          url: "https://linear.app/acme/issue/ENG-123/fix-import",
          team: { id: "team_eng", key: "ENG", name: "Engineering" }
        }
      }
    });

    const response = await app.request("/linear/webhooks", {
      method: "POST",
      headers: signedHeaders("linear_secret", rawBody),
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, runId: "run_linear_agent_1" });
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "linear",
        metadata: expect.objectContaining({ agentSessionId: "agent_session_1", owner: "acme", repo: "demo" })
      })
    );
    await vi.waitFor(() => {
      expect(onAgentSessionAccepted).toHaveBeenCalledWith({
        agentSessionId: "agent_session_1",
        runId: "run_linear_agent_1",
        action: "created"
      });
    });
  });

  it("does not fail AgentSessionEvent webhook responses when accepted activity delivery fails", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_linear_agent_1" }));
    const onAgentSessionAccepted = vi.fn(async () => {
      throw new Error("Linear GraphQL unavailable");
    });
    const app = createLinearWebhookApp({
      webhookSecret: "linear_secret",
      createRun,
      onAgentSessionAccepted,
      now: () => WEBHOOK_NOW
    });
    const rawBody = JSON.stringify({
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "webhook_agent_2",
      webhookTimestamp: WEBHOOK_TIMESTAMP,
      agentSession: {
        id: "agent_session_2"
      }
    });

    const response = await app.request("/linear/webhooks", {
      method: "POST",
      headers: signedHeaders("linear_secret", rawBody),
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, runId: "run_linear_agent_1" });
    await vi.waitFor(() => {
      expect(onAgentSessionAccepted).toHaveBeenCalledWith({
        agentSessionId: "agent_session_2",
        runId: "run_linear_agent_1",
        action: "created"
      });
    });
  });

  it("routes AgentSessionEvent stop signals to source-thread cancellation instead of creating a run", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_linear_agent_1" }));
    const submitThreadAction = vi.fn(async () => undefined);
    const onAgentSessionAccepted = vi.fn(async () => undefined);
    const app = createLinearWebhookApp({
      webhookSecret: "linear_secret",
      projectTarget: { repoProvider: "github", owner: "acme", repo: "demo" },
      createRun,
      submitThreadAction,
      onAgentSessionAccepted,
      now: () => WEBHOOK_NOW
    });
    const rawBody = JSON.stringify({
      type: "AgentSessionEvent",
      action: "prompted",
      webhookId: "webhook_agent_stop_1",
      organizationId: "org_acme",
      createdAt: "2026-07-07T00:00:00.000Z",
      webhookTimestamp: WEBHOOK_TIMESTAMP,
      agentActivity: {
        id: "activity_stop_1",
        body: "Stop",
        signal: "stop"
      },
      agentSession: {
        id: "agent_session_1",
        creator: { id: "user_alice", name: "Alice" },
        issue: {
          id: "issue_123",
          identifier: "ENG-123",
          title: "Fix import",
          url: "https://linear.app/acme/issue/ENG-123/fix-import",
          team: { id: "team_eng", key: "ENG", name: "Engineering" }
        }
      }
    });

    const response = await app.request("/linear/webhooks", {
      method: "POST",
      headers: signedHeaders("linear_secret", rawBody),
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, action: "stop" });
    expect(createRun).not.toHaveBeenCalled();
    expect(onAgentSessionAccepted).not.toHaveBeenCalled();
    expect(submitThreadAction).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "linear_control_webhook_agent_stop_1",
        rawText: "/stop",
        actor: expect.objectContaining({ provider: "linear", providerUserId: "user_alice", handle: "Alice", organizationId: "org_acme" }),
        callback: {
          provider: "linear",
          uri: "linear://agent-session/agent_session_1/activities",
          threadKey: "ENG|agent-session|agent_session_1"
        },
        metadata: expect.objectContaining({
          linearAgentActivitySignal: "stop",
          agentSessionId: "agent_session_1",
          owner: "acme",
          repo: "demo"
        })
      })
    );
  });

  it("submits thread actions instead of creating new runs", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_linear_1" }));
    const submitThreadAction = vi.fn(async () => undefined);
    const app = createLinearWebhookApp({
      webhookSecret: "linear_secret",
      createRun,
      submitThreadAction,
      now: () => WEBHOOK_NOW
    });
    const rawBody = JSON.stringify({
      type: "Comment",
      action: "create",
      webhookTimestamp: WEBHOOK_TIMESTAMP,
      data: {
        id: "comment_2",
        body: "apply 1",
        issue: {
          id: "issue_123",
          identifier: "ENG-123",
          url: "https://linear.app/acme/issue/ENG-123/fix-import",
          team: { id: "team_eng", key: "ENG" }
        },
        user: { id: "user_alice", displayName: "Alice" }
      }
    });

    const response = await app.request("/linear/webhooks", {
      method: "POST",
      headers: signedHeaders("linear_secret", rawBody),
      body: rawBody
    });

    expect(response.status).toBe(200);
    expect(createRun).not.toHaveBeenCalled();
    expect(submitThreadAction).toHaveBeenCalledWith(
      expect.objectContaining({
        rawText: "apply 1",
        callback: expect.objectContaining({ provider: "linear", uri: "linear://issue/issue_123/comments" })
      })
    );
  });

  it("rejects signed webhooks with missing or stale timestamps", async () => {
    const app = createLinearWebhookApp({
      webhookSecret: "linear_secret",
      createRun: vi.fn(async () => ({ runId: "run_linear_1" })),
      now: () => WEBHOOK_NOW
    });
    const missingTimestampBody = JSON.stringify({
      type: "Comment",
      action: "create",
      data: {
        id: "comment_3",
        body: "@opentag investigate this",
        issue: {
          id: "issue_123",
          identifier: "ENG-123",
          url: "https://linear.app/acme/issue/ENG-123/fix-import",
          team: { id: "team_eng", key: "ENG" }
        },
        user: { id: "user_alice", displayName: "Alice" }
      }
    });

    const missingTimestamp = await app.request("/linear/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": computeLinearSignature({ webhookSecret: "linear_secret", rawBody: missingTimestampBody }),
        "linear-timestamp": String(WEBHOOK_TIMESTAMP)
      },
      body: missingTimestampBody
    });
    expect(missingTimestamp.status).toBe(400);
    await expect(missingTimestamp.json()).resolves.toEqual({ error: "invalid_timestamp" });

    const staleBody = JSON.stringify({
      type: "Comment",
      action: "create",
      webhookTimestamp: WEBHOOK_TIMESTAMP - 60_001,
      data: {
        id: "comment_4",
        body: "@opentag investigate this",
        issue: {
          id: "issue_123",
          identifier: "ENG-123",
          url: "https://linear.app/acme/issue/ENG-123/fix-import",
          team: { id: "team_eng", key: "ENG" }
        },
        user: { id: "user_alice", displayName: "Alice" }
      }
    });

    const stale = await app.request("/linear/webhooks", {
      method: "POST",
      headers: signedHeaders("linear_secret", staleBody),
      body: staleBody
    });
    expect(stale.status).toBe(400);
    await expect(stale.json()).resolves.toEqual({ error: "invalid_timestamp" });
  });

  it("rejects invalid signatures before parsing the payload", async () => {
    const app = createLinearWebhookApp({
      webhookSecret: "linear_secret",
      createRun: vi.fn(async () => ({ runId: "run_linear_1" })),
      now: () => WEBHOOK_NOW
    });
    const response = await app.request("/linear/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json", "linear-signature": "bad" },
      body: "{"
    });
    expect(response.status).toBe(401);
  });
});
