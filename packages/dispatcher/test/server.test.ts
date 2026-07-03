import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDefaultCallbackPresentation } from "../src/presentation.js";
import { createDispatcherApp } from "../src/server.js";

const validEvent = {
  id: "evt_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix", args: {} },
  context: [{ provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/1", visibility: "public" }],
  workItem: {
    provider: "github",
    kind: "issue",
    externalId: "acme/demo#1",
    uri: "https://github.com/acme/demo/issues/1",
    ownerContainer: {
      provider: "github",
      id: "acme/demo",
      uri: "https://github.com/acme/demo"
    }
  },
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

function jsonRequest(body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function githubIssueEvent(input: { id: string; sourceEventId: string; threadKey?: string }) {
  return {
    ...validEvent,
    id: input.id,
    sourceEventId: input.sourceEventId,
    permissions: [
      { scope: "issue:comment", reason: "reply to source thread" },
      { scope: "repo:write", reason: "apply approved issue metadata" }
    ],
    callback: {
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
      ...(input.threadKey ? { threadKey: input.threadKey } : {})
    },
    metadata: { owner: "acme", repo: "demo", issueNumber: 1 }
  };
}

function githubPullRequestEvent(input: { id: string; sourceEventId: string; threadKey?: string }) {
  return {
    ...validEvent,
    id: input.id,
    sourceEventId: input.sourceEventId,
    context: [{ provider: "github", kind: "pull_request", uri: "https://github.com/acme/demo/pull/2", visibility: "public" }],
    workItem: {
      provider: "github",
      kind: "pull_request",
      externalId: "acme/demo#2",
      uri: "https://github.com/acme/demo/pull/2",
      ownerContainer: {
        provider: "github",
        id: "acme/demo",
        uri: "https://github.com/acme/demo"
      }
    },
    permissions: [
      { scope: "issue:comment", reason: "reply to source thread" },
      { scope: "pr:update", reason: "request reviewers after explicit approval" }
    ],
    callback: {
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/2/comments",
      ...(input.threadKey ? { threadKey: input.threadKey } : {})
    },
    metadata: { owner: "acme", repo: "demo", pullRequestNumber: 2 }
  };
}

function gitlabIssueEvent(input: { id: string; sourceEventId: string; threadKey?: string }) {
  return {
    ...validEvent,
    id: input.id,
    source: "gitlab",
    sourceEventId: input.sourceEventId,
    context: [{ provider: "gitlab", kind: "issue", uri: "https://gitlab.example.com/acme/demo/-/issues/1", visibility: "private" }],
    workItem: {
      provider: "gitlab",
      kind: "issue",
      externalId: "issue:acme/demo#1",
      uri: "https://gitlab.example.com/acme/demo/-/issues/1",
      ownerContainer: {
        provider: "gitlab",
        id: "acme/demo",
        uri: "https://gitlab.example.com/acme/demo"
      }
    },
    permissions: [
      { scope: "issue:comment", reason: "reply to the source GitLab thread" },
      { scope: "runner:local", reason: "execute the run on a paired local daemon" },
      { scope: "repo:read", reason: "inspect the repository in the paired local checkout" },
      { scope: "repo:write", reason: "commit code changes on an isolated run branch" },
      { scope: "pr:create", reason: "open a merge request for completed code changes" }
    ],
    callback: {
      provider: "gitlab",
      uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
      ...(input.threadKey ? { threadKey: input.threadKey } : {})
    },
    metadata: {
      repoProvider: "gitlab",
      owner: "acme",
      repo: "demo",
      projectPathWithNamespace: "acme/demo",
      projectId: 42,
      projectVisibility: "private",
      issueIid: 1,
      noteableType: "Issue"
    }
  };
}

function slackRepoEvent(input: { id: string; sourceEventId: string; threadKey: string }) {
  return {
    ...validEvent,
    id: input.id,
    source: "slack",
    sourceEventId: input.sourceEventId,
    actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
    context: [{ provider: "slack", kind: "message", uri: "slack://team/T123/channel/C123/message/1710000000.000100", visibility: "organization" }],
    permissions: [
      { scope: "chat:postMessage", reason: "reply to source thread" },
      { scope: "reactions:write", reason: "mark the source Slack message as received" },
      { scope: "runner:local", reason: "execute on local daemon" },
      { scope: "repo:write", reason: "modify the mapped repository" },
      { scope: "pr:create", reason: "create an approved pull request" }
    ],
    callback: {
      provider: "slack",
      uri: "https://slack.com/api/chat.postMessage",
      threadKey: input.threadKey
    },
    metadata: { teamId: "T123", channelId: "C123", messageTs: "1710000000.000100", repoProvider: "github", owner: "acme", repo: "demo" }
  };
}

function larkRepoEvent(input: { id: string; sourceEventId: string; chatId?: string; messageId?: string }) {
  const chatId = input.chatId ?? "oc_chat";
  const messageId = input.messageId ?? "om_msg";
  return {
    ...validEvent,
    id: input.id,
    source: "lark",
    sourceEventId: input.sourceEventId,
    actor: { provider: "lark", providerUserId: "ou_sender", handle: "ming", organizationId: "tenant_1" },
    context: [{ provider: "lark", kind: "message", uri: `lark://tenant/tenant_1/chat/${chatId}/message/${messageId}`, visibility: "organization" }],
    permissions: [
      { scope: "chat:postMessage", reason: "reply in source chat" },
      { scope: "runner:local", reason: "execute on local daemon" },
      { scope: "repo:write", reason: "modify the mapped repository" }
    ],
    callback: {
      provider: "lark",
      uri: "lark://im/v1/messages",
      threadKey: `tenant_1|${chatId}|${messageId}`
    },
    metadata: {
      tenantKey: "tenant_1",
      chatId,
      messageId,
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }
  };
}

async function seedCompletedProposal(input: {
  app: ReturnType<typeof createDispatcherApp>;
  runId: string;
  event: unknown;
  suggestedChanges: unknown[];
  allowedActors?: string[];
  repoBinding?: { provider: string; owner: string; repo: string };
}) {
  const repoBinding = input.repoBinding ?? { provider: "github", owner: "acme", repo: "demo" };
  await input.app.request("/v1/repo-bindings", jsonRequest({
    provider: repoBinding.provider,
    owner: repoBinding.owner,
    repo: repoBinding.repo,
    runnerId: "runner_1",
    workspacePath: "/Users/test/demo",
    defaultExecutor: "echo",
    ...(input.allowedActors ? { allowedActors: input.allowedActors } : {})
  }));
  const createResponse = await input.app.request("/v1/runs", jsonRequest({ runId: input.runId, event: input.event }));
  expect(createResponse.status).toBe(201);
  await input.app.request("/v1/runners/runner_1/claim", { method: "POST" });
  const completeResponse = await input.app.request(`/v1/runners/runner_1/runs/${input.runId}/complete`, jsonRequest({
    result: {
      conclusion: "needs_human",
      summary: "Prepared suggested actions.",
      suggestedChanges: input.suggestedChanges
    }
  }));
  expect(completeResponse.status).toBe(200);
}

describe("dispatcher API", () => {
  it("requires a bearer token when pairing token auth is configured", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test" });

    const denied = await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
    });
    expect(denied.status).toBe(401);

    const allowed = await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer pair_test" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
    });
    expect(allowed.status).toBe(201);

    const audit = await app.request("/v1/control-plane-events?type=security.auth_failed", {
      headers: { authorization: "Bearer pair_test" }
    });
    expect(audit.status).toBe(200);
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        type: "security.auth_failed",
        severity: "warn",
        subject: "POST /v1/runners",
        payload: expect.objectContaining({
          reason: "invalid_pairing_token",
          endpoint: "POST /v1/runners",
          hasAuthorization: false,
          tokenFingerprint: "none"
        })
      })
    ]);
    expect(JSON.stringify(events)).not.toContain("pair_test");
  });

  it("separates pairing-token admin calls from runner-token runtime calls", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test", runnerToken: "runner_test" });
    const pairJson = (body: unknown) => ({
      ...jsonRequest(body),
      headers: { "content-type": "application/json", authorization: "Bearer pair_test" }
    });
    const runnerJson = (body: unknown) => ({
      ...jsonRequest(body),
      headers: { "content-type": "application/json", authorization: "Bearer runner_test" }
    });
    const runnerAuth = { authorization: "Bearer runner_test" };

    const runnerCannotRegister = await app.request("/v1/runners", runnerJson({ runnerId: "runner_1", name: "Local Runner" }));
    expect(runnerCannotRegister.status).toBe(401);

    const register = await app.request("/v1/runners", pairJson({ runnerId: "runner_1", name: "Local Runner" }));
    expect(register.status).toBe(201);

    const bind = await app.request("/v1/repo-bindings", pairJson({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    expect(bind.status).toBe(201);

    const runnerCanReadRegistration = await app.request("/v1/runners/runner_1", { headers: runnerAuth });
    expect(runnerCanReadRegistration.status).toBe(200);
    const runnerCanReadBinding = await app.request("/v1/repo-bindings/github/acme/demo", { headers: runnerAuth });
    expect(runnerCanReadBinding.status).toBe(200);

    const runnerCannotCreateRun = await app.request("/v1/runs", runnerJson({ runId: "run_scope", event: validEvent }));
    expect(runnerCannotCreateRun.status).toBe(401);

    const createRun = await app.request("/v1/runs", pairJson({ runId: "run_scope", event: validEvent }));
    expect(createRun.status).toBe(201);

    const pairCannotClaimWhenRunnerTokenIsConfigured = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: { authorization: "Bearer pair_test" }
    });
    expect(pairCannotClaimWhenRunnerTokenIsConfigured.status).toBe(401);
    await expect(pairCannotClaimWhenRunnerTokenIsConfigured.json()).resolves.toMatchObject({
      error: "unauthorized",
      reason: "invalid_runner_token"
    });

    const claim = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: runnerAuth
    });
    expect(claim.status).toBe(200);

    const runnerCanReadRun = await app.request("/v1/runs/run_scope", { headers: runnerAuth });
    expect(runnerCanReadRun.status).toBe(200);
    const runnerCanReadAlerts = await app.request("/v1/control-plane-alerts", { headers: runnerAuth });
    expect(runnerCanReadAlerts.status).toBe(200);

    const audit = await app.request("/v1/control-plane-events?type=security.auth_failed", {
      headers: { authorization: "Bearer pair_test" }
    });
    const { events } = await audit.json();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: "POST /v1/runners",
          payload: expect.objectContaining({ reason: "invalid_pairing_token" })
        }),
        expect.objectContaining({
          subject: "POST /v1/runners/:runnerId/claim",
          payload: expect.objectContaining({ reason: "invalid_runner_token" })
        })
      ])
    );
    expect(JSON.stringify(events)).not.toContain("runner_test");
    expect(JSON.stringify(events)).not.toContain("pair_test");
  });

  it("allows runner-operator auth to prune source delivery replay keys and audit metrics", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test", runnerToken: "runner_test" });
    const body = {
      olderThan: "2026-06-24T00:00:00.000Z",
      limit: 25
    };

    const denied = await app.request("/v1/source-deliveries/prune", jsonRequest(body));
    expect(denied.status).toBe(401);

    const pruned = await app.request("/v1/source-deliveries/prune", {
      ...jsonRequest(body),
      headers: { "content-type": "application/json", authorization: "Bearer runner_test" }
    });
    expect(pruned.status).toBe(200);
    await expect(pruned.json()).resolves.toEqual({
      result: {
        scanned: 0,
        pruned: 0,
        retainedActive: 0
      }
    });

    const invalid = await app.request("/v1/source-deliveries/prune", {
      ...jsonRequest({ olderThan: "not-a-date" }),
      headers: { "content-type": "application/json", authorization: "Bearer runner_test" }
    });
    expect(invalid.status).toBe(400);

    const audit = await app.request("/v1/control-plane-events?type=maintenance.source_deliveries_pruned", {
      headers: { authorization: "Bearer pair_test" }
    });
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        type: "maintenance.source_deliveries_pruned",
        severity: "info",
        subject: "source_deliveries",
        payload: expect.objectContaining({
          olderThan: "2026-06-24T00:00:00.000Z",
          limit: 25,
          scanned: 0,
          pruned: 0,
          retainedActive: 0
        })
      })
    ]);
    expect(JSON.stringify(events)).not.toContain("runner_test");
  });

  it("records management audit events for runner registration and binding changes without local paths", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Local Runner" }));
    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/alice/repos/demo",
        defaultExecutor: "echo",
        allowedActors: ["octocat"]
      })
    );
    await app.request(
      "/v1/channel-bindings",
      jsonRequest({
        provider: "telegram",
        accountId: "bot_123",
        conversationId: "chat_456",
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        metadata: { title: "Ops chat" }
      })
    );
    await app.request(
      "/v1/slack-channel-bindings",
      jsonRequest({
        teamId: "T123",
        channelId: "C123",
        owner: "acme",
        repo: "demo"
      })
    );
    await app.request("/v1/channel-bindings/telegram/bot_123/chat_456", { method: "DELETE" });

    const audit = await app.request("/v1/control-plane-events?limit=20");
    const { events } = await audit.json();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "runner.registered",
          subject: "runner_1",
          payload: {
            runnerId: "runner_1",
            name: "Local Runner"
          }
        }),
        expect.objectContaining({
          type: "binding.repository.upserted",
          subject: "github:acme/demo",
          payload: {
            provider: "github",
            owner: "acme",
            repo: "demo",
            runnerId: "runner_1",
            hasWorkspacePath: true,
            defaultExecutor: "echo",
            allowedActorsCount: 1
          }
        }),
        expect.objectContaining({
          type: "binding.channel.upserted",
          subject: "telegram:bot_123/chat_456",
          payload: {
            provider: "telegram",
            accountId: "bot_123",
            conversationId: "chat_456",
            repoProvider: "github",
            owner: "acme",
            repo: "demo",
            hasMetadata: true
          }
        }),
        expect.objectContaining({
          type: "binding.channel.upserted",
          subject: "slack:T123/C123",
          payload: expect.objectContaining({
            provider: "slack",
            accountId: "T123",
            conversationId: "C123",
            compatibilityEndpoint: "/v1/slack-channel-bindings"
          })
        }),
        expect.objectContaining({
          type: "binding.channel.deleted",
          subject: "telegram:bot_123/chat_456",
          payload: {
            provider: "telegram",
            accountId: "bot_123",
            conversationId: "chat_456"
          }
        })
      ])
    );
    expect(JSON.stringify(events)).not.toContain("/Users/alice/repos/demo");
  });

  it("accepts multiple runner tokens during a rotation window", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pair_test",
      runnerToken: "runner_new",
      runnerTokens: ["runner_old"]
    });
    const pairJson = (body: unknown) => ({
      ...jsonRequest(body),
      headers: { "content-type": "application/json", authorization: "Bearer pair_test" }
    });

    await app.request("/v1/runners", pairJson({ runnerId: "runner_1", name: "Local Runner" }));
    const oldTokenClaim = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: { authorization: "Bearer runner_old" }
    });
    expect(oldTokenClaim.status).toBe(204);

    const newTokenClaim = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: { authorization: "Bearer runner_new" }
    });
    expect(newTokenClaim.status).toBe(204);
  });

  it("fails closed when a runner token fingerprint is revoked", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pair_test",
      runnerToken: "runner_new",
      runnerTokens: ["runner_old"],
      revokedRunnerTokenFingerprints: [tokenFingerprint("runner_old")]
    });
    const pairJson = (body: unknown) => ({
      ...jsonRequest(body),
      headers: { "content-type": "application/json", authorization: "Bearer pair_test" }
    });

    await app.request("/v1/runners", pairJson({ runnerId: "runner_1", name: "Local Runner" }));
    const revokedClaim = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: { authorization: "Bearer runner_old" }
    });
    expect(revokedClaim.status).toBe(401);
    await expect(revokedClaim.json()).resolves.toMatchObject({
      error: "unauthorized",
      reason: "runner_token_revoked",
      message: expect.stringContaining("Pair again")
    });

    const currentClaim = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: { authorization: "Bearer runner_new" }
    });
    expect(currentClaim.status).toBe(204);

    const audit = await app.request("/v1/control-plane-events?type=security.auth_failed", {
      headers: { authorization: "Bearer pair_test" }
    });
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        subject: "POST /v1/runners/:runnerId/claim",
        payload: expect.objectContaining({ reason: "runner_token_revoked" })
      })
    ]);
    expect(JSON.stringify(events)).not.toContain("runner_old");
    expect(JSON.stringify(events)).not.toContain(tokenFingerprint("runner_old"));
  });

  it("rejects a revoked pairing token before runner-runtime fallback auth", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      pairingToken: "pair_test",
      revokedRunnerTokenFingerprints: [tokenFingerprint("pair_test")]
    });

    const claim = await app.request("/v1/runners/runner_1/claim", {
      method: "POST",
      headers: { authorization: "Bearer pair_test" }
    });

    expect(claim.status).toBe(401);
    await expect(claim.json()).resolves.toMatchObject({
      error: "unauthorized",
      reason: "runner_token_revoked"
    });
  });

  it("summarizes repeated control-plane security events as alerts", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test" });

    for (let index = 0; index < 3; index += 1) {
      const denied = await app.request("/v1/runners/runner_1", {
        headers: { authorization: "Bearer wrong_secret" }
      });
      expect(denied.status).toBe(401);
    }

    const alertsResponse = await app.request("/v1/control-plane-alerts", {
      headers: { authorization: "Bearer pair_test" }
    });
    expect(alertsResponse.status).toBe(200);
    const { alerts } = await alertsResponse.json();
    expect(alerts).toEqual([
      expect.objectContaining({
        type: "repeated_auth_failures",
        severity: "warn",
        eventType: "security.auth_failed",
        count: 3,
        threshold: 3,
        subject: expect.not.stringContaining("wrong_secret"),
        reason: "Repeated dispatcher authorization failures were observed."
      })
    ]);
    expect(JSON.stringify(alerts)).not.toContain("wrong_secret");
  });

  it("records ingress signature failures as control-plane events and alert candidates", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test" });

    for (let index = 0; index < 3; index += 1) {
      const response = await app.request("/v1/control-plane-events", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer pair_test" },
        body: JSON.stringify({
          type: "security.signature_failed",
          severity: "warn",
          subject: "github:POST /github/webhooks",
          payload: {
            provider: "github",
            endpoint: "POST /github/webhooks",
            reason: "invalid_signature"
          }
        })
      });
      expect(response.status).toBe(201);
    }

    const eventsResponse = await app.request("/v1/control-plane-events?type=security.signature_failed", {
      headers: { authorization: "Bearer pair_test" }
    });
    expect(eventsResponse.status).toBe(200);
    const { events } = await eventsResponse.json();
    expect(events).toHaveLength(3);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "security.signature_failed",
          severity: "warn",
          subject: "github:POST /github/webhooks",
          payload: expect.objectContaining({ provider: "github", reason: "invalid_signature" })
        })
      ])
    );

    const alertsResponse = await app.request("/v1/control-plane-alerts", {
      headers: { authorization: "Bearer pair_test" }
    });
    expect(alertsResponse.status).toBe(200);
    await expect(alertsResponse.json()).resolves.toMatchObject({
      alerts: [
        {
          type: "repeated_signature_failures",
          eventType: "security.signature_failed",
          count: 3,
          threshold: 3,
          subject: "github:POST /github/webhooks"
        }
      ]
    });
  });

  it("summarizes terminal token misuse as an immediate alert candidate", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test" });

    const response = await app.request("/v1/control-plane-events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer pair_test" },
      body: JSON.stringify({
        type: "security.token_misuse",
        severity: "warn",
        subject: "slack:app_token",
        payload: {
          provider: "slack",
          endpoint: "apps.connections.open",
          reason: "token_revoked",
          tokenKind: "app_token",
          mode: "socket_mode",
          tokenFingerprint: "sha256:abc123"
        }
      })
    });
    expect(response.status).toBe(201);

    const alertsResponse = await app.request("/v1/control-plane-alerts", {
      headers: { authorization: "Bearer pair_test" }
    });
    expect(alertsResponse.status).toBe(200);
    const { alerts } = await alertsResponse.json();
    expect(alerts).toEqual([
      expect.objectContaining({
        type: "token_misuse",
        severity: "warn",
        eventType: "security.token_misuse",
        count: 1,
        threshold: 1,
        subject: "slack:app_token",
        reason: "A platform or relay token failed with a terminal authentication or configuration error."
      })
    ]);
    expect(JSON.stringify(alerts)).not.toContain("xapp-");
  });

  it("summarizes high runner claim volume as an alert candidate", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const registerResponse = await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Local Runner" }));
    expect(registerResponse.status).toBe(201);
    const bindingResponse = await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1"
    }));
    expect(bindingResponse.status).toBe(201);

    for (let index = 0; index < 10; index += 1) {
      const createResponse = await app.request("/v1/runs", jsonRequest({
        runId: `run_claim_alert_${index}`,
        event: githubIssueEvent({
          id: `evt_claim_alert_${index}`,
          sourceEventId: `comment_claim_alert_${index}`
        })
      }));
      expect(createResponse.status).toBe(201);
      const claimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
      expect(claimResponse.status).toBe(200);
      const completeResponse = await app.request(`/v1/runners/runner_1/runs/run_claim_alert_${index}/complete`, jsonRequest({
        result: { conclusion: "success", summary: "Claimed and completed." }
      }));
      expect(completeResponse.status).toBe(200);
    }

    const alertsResponse = await app.request("/v1/control-plane-alerts");
    expect(alertsResponse.status).toBe(200);
    const { alerts } = await alertsResponse.json();
    expect(alerts).toEqual([
      expect.objectContaining({
        type: "abnormal_runner_claim_rate",
        severity: "warn",
        eventType: "run.claimed",
        count: 10,
        threshold: 10,
        subject: "runner_1",
        reason: "Runner claim volume exceeded the local alert threshold."
      })
    ]);
  });

  it("rate limits by relay token fingerprint and endpoint when enabled", async () => {
    let now = 1_000;
    const app = createDispatcherApp({
      databasePath: ":memory:",
      rateLimit: {
        windowMs: 1_000,
        maxRequests: 1,
        now: () => now
      }
    });

    const first = await app.request("/v1/runners/runner_1", {
      headers: { authorization: "Bearer token_a" }
    });
    expect(first.status).toBe(404);

    const second = await app.request("/v1/runners/runner_1", {
      headers: { authorization: "Bearer token_a" }
    });
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("1");
    await expect(second.json()).resolves.toEqual({
      error: "rate_limited",
      retryAfterMs: 1_000,
      maxRequests: 1,
      windowMs: 1_000
    });

    const otherToken = await app.request("/v1/runners/runner_1", {
      headers: { authorization: "Bearer token_b" }
    });
    expect(otherToken.status).toBe(404);

    now = 2_001;
    const afterReset = await app.request("/v1/runners/runner_1", {
      headers: { authorization: "Bearer token_a" }
    });
    expect(afterReset.status).toBe(404);
  });

  it("keeps rate-limit buckets separate by runner id, source platform, and tenant", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      rateLimit: {
        windowMs: 1_000,
        maxRequests: 1,
        now: () => 10_000
      }
    });

    const firstRunnerClaim = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(firstRunnerClaim.status).toBe(204);
    const secondRunnerClaim = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(secondRunnerClaim.status).toBe(429);
    const otherRunnerClaim = await app.request("/v1/runners/runner_2/claim", { method: "POST" });
    expect(otherRunnerClaim.status).toBe(204);

    const firstGitHubBindingLookup = await app.request("/v1/repo-bindings/github/acme/demo");
    expect(firstGitHubBindingLookup.status).toBe(404);
    const secondGitHubBindingLookup = await app.request("/v1/repo-bindings/github/acme/demo");
    expect(secondGitHubBindingLookup.status).toBe(429);
    const otherGitHubOwnerLookup = await app.request("/v1/repo-bindings/github/other/demo");
    expect(otherGitHubOwnerLookup.status).toBe(404);
    const slackBindingLookup = await app.request("/v1/repo-bindings/slack/acme/demo");
    expect(slackBindingLookup.status).toBe(404);

    const firstLarkChannelLookup = await app.request("/v1/channel-bindings/lark/tenant_1/chat_1/status");
    expect(firstLarkChannelLookup.status).toBe(404);
    const sameLarkTenantLookup = await app.request("/v1/channel-bindings/lark/tenant_1/chat_2/status");
    expect(sameLarkTenantLookup.status).toBe(429);
    const otherLarkTenantLookup = await app.request("/v1/channel-bindings/lark/tenant_2/chat_1/status");
    expect(otherLarkTenantLookup.status).toBe(404);
  });

  it("creates and claims an echo run", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const runnerResponse = await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
    });
    expect(runnerResponse.status).toBe(201);

    const bindingResponse = await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo",
        allowedActors: ["octocat"]
      })
    });
    expect(bindingResponse.status).toBe(201);

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_1", event: validEvent })
    });
    expect(createResponse.status).toBe(201);

    const claimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(claimResponse.status).toBe(200);
    const claimed = await claimResponse.json();
    expect(claimed.run.id).toBe("run_1");
    expect(claimed.event.command.rawText).toBe("fix this");

    const bindingGetResponse = await app.request("/v1/repo-bindings/github/acme/demo");
    const binding = await bindingGetResponse.json();
    expect(binding.binding).toMatchObject({ runnerId: "runner_1", workspacePath: "/Users/test/demo" });
  });

  it("records dispatcher-created run provenance for relay auditability", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_provenance_http",
        event: {
          ...validEvent,
          id: "evt_provenance_http",
          sourceEventId: "comment_provenance_http",
          metadata: {
            ...validEvent.metadata,
            sourceDeliveryId: "delivery_123",
            webhookSignatureVerified: true
          }
        }
      })
    });
    expect(createResponse.status).toBe(201);

    const eventsResponse = await app.request("/v1/runs/run_provenance_http/events");
    const { events } = await eventsResponse.json();
    expect(events.find((event: { type: string }) => event.type === "run.created")?.payload).toMatchObject({
      eventId: "evt_provenance_http",
      provenance: {
        source: "github",
        sourceEventId: "comment_provenance_http",
        sourceDeliveryId: "delivery_123",
        signatureState: "verified",
        projectTarget: { ref: "github:acme/demo", provider: "github", owner: "acme", repo: "demo" },
        admissionDecision: {
          action: "start",
          reasonCode: "new_event",
          eventId: "evt_provenance_http"
        },
        expectedRunnerId: "runner_1"
      }
    });
  });

  it("returns the existing run for a replayed source event", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const firstResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_duplicate_1", event: validEvent })
    });
    expect(firstResponse.status).toBe(201);

    const secondResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_duplicate_2", event: validEvent })
    });
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({
      decision: {
        action: "drop_duplicate",
        reasonCode: "duplicate_source_event"
      },
      run: { id: "run_duplicate_1" },
      idempotentReplay: true
    });
  });

  it("queues same-thread work as a durable follow-up when a run is already active", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {})
          });
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const first = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_active_1", event: { ...validEvent, id: "evt_active_1", sourceEventId: "comment_active_1" } })
    });
    expect(first.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const second = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "follow_up_1",
        event: {
          ...validEvent,
          id: "evt_follow_up_1",
          sourceEventId: "comment_follow_up_1",
          command: { rawText: "fix this after the current run", intent: "fix", args: {} }
        }
      })
    });
    expect(second.status).toBe(202);
    const secondJson = await second.json();
    expect(secondJson).toMatchObject({
      decision: {
        action: "queue_follow_up",
        reasonCode: "active_run_same_thread",
        activeRunId: "run_active_1"
      },
      followUpRequest: {
        id: "follow_up_1",
        sourceEventId: "evt_follow_up_1",
        status: "queued"
      }
    });
    expect(delivered).toEqual([
      {
        kind: "acknowledgement",
        body: "OpenTag picked this up. Run: `run_active_1`"
      },
      {
        kind: "progress",
        body: "OpenTag progress for `run_active_1`: Queued follow-up follow_up_1 behind the active run.",
        statusMessageKey: "run_active_1:status"
      }
    ]);

    const getFollowUp = await app.request("/v1/follow-up-requests/follow_up_1");
    expect(getFollowUp.status).toBe(200);
    await expect(getFollowUp.json()).resolves.toMatchObject({
      followUpRequest: {
        id: "follow_up_1",
        decision: { action: "queue_follow_up" }
      }
    });

    const promote = await app.request("/v1/follow-up-requests/follow_up_1/create-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_from_follow_up_1" })
    });
    expect(promote.status).toBe(201);
    await expect(promote.json()).resolves.toMatchObject({
      followUpRequest: {
        id: "follow_up_1",
        status: "promoted",
        createdRunId: "run_from_follow_up_1"
      },
      run: {
        id: "run_from_follow_up_1",
        parentRunId: "run_active_1"
      }
    });
  });

  it("auto-promotes the next queued follow-up after a terminal runner completion", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {})
          });
        }
      }
    });

    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    );

    const first = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_auto_promote_active",
        event: githubIssueEvent({ id: "evt_auto_promote_active", sourceEventId: "comment_auto_promote_active" })
      })
    );
    expect(first.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const firstFollowUp = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "follow_up_auto_1",
        event: githubIssueEvent({ id: "evt_follow_up_auto_1", sourceEventId: "comment_follow_up_auto_1" })
      })
    );
    expect(firstFollowUp.status).toBe(202);

    const secondFollowUp = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "follow_up_auto_2",
        event: githubIssueEvent({ id: "evt_follow_up_auto_2", sourceEventId: "comment_follow_up_auto_2" })
      })
    );
    expect(secondFollowUp.status).toBe(202);

    const complete = await app.request(
      "/v1/runners/runner_1/runs/run_auto_promote_active/complete",
      jsonRequest({
        result: { conclusion: "success", summary: "Finished active run." }
      })
    );
    expect(complete.status).toBe(200);
    const completeJson = await complete.json();
    expect(completeJson).toMatchObject({
      ok: true,
      promotedFollowUp: {
        followUpRequest: {
          id: "follow_up_auto_1",
          status: "promoted"
        },
        run: {
          parentRunId: "run_auto_promote_active"
        }
      }
    });
    const promotedRunId = completeJson.promotedFollowUp.run.id;
    expect(promotedRunId).toMatch(/^run_/);
    expect(completeJson.promotedFollowUp.followUpRequest.createdRunId).toBe(promotedRunId);

    await expect((await app.request("/v1/follow-up-requests/follow_up_auto_1")).json()).resolves.toMatchObject({
      followUpRequest: { id: "follow_up_auto_1", status: "promoted", createdRunId: promotedRunId }
    });
    await expect((await app.request("/v1/follow-up-requests/follow_up_auto_2")).json()).resolves.toMatchObject({
      followUpRequest: { id: "follow_up_auto_2", status: "queued" }
    });

    const claimPromoted = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(claimPromoted.status).toBe(200);
    await expect(claimPromoted.json()).resolves.toMatchObject({
      run: { id: promotedRunId, parentRunId: "run_auto_promote_active" }
    });

    const eventsResponse = await app.request("/v1/runs/run_auto_promote_active/events");
    const { events } = await eventsResponse.json();
    expect(events.find((event: { type: string }) => event.type === "follow_up_request.auto_promoted")).toMatchObject({
      payload: {
        followUpRequestId: "follow_up_auto_1",
        createdRunId: promotedRunId
      }
    });
    expect(delivered).toEqual([
      {
        kind: "acknowledgement",
        body: "OpenTag picked this up. Run: `run_auto_promote_active`"
      },
      {
        kind: "progress",
        body: "OpenTag progress for `run_auto_promote_active`: Queued follow-up follow_up_auto_1 behind the active run.",
        statusMessageKey: "run_auto_promote_active:status"
      },
      {
        kind: "progress",
        body: "OpenTag progress for `run_auto_promote_active`: Queued follow-up follow_up_auto_2 behind the active run.",
        statusMessageKey: "run_auto_promote_active:status"
      },
      {
        kind: "final",
        body: expect.stringContaining("Finished active run.")
      },
      {
        kind: "acknowledgement",
        body: `OpenTag picked this up. Run: \`${promotedRunId}\``
      }
    ]);
  });

  it("does not send queued text callbacks for source-receipt liveness providers", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      sourceReceiptSink: {
        async deliver() {
          return { delivered: true };
        }
      }
    });

    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    );

    const first = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_slack_active_1",
        event: slackRepoEvent({ id: "evt_slack_active_1", sourceEventId: "slack_active_1", threadKey: "T123|C123|1710000000.000100" })
      })
    );
    expect(first.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const second = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "follow_up_slack_1",
        event: slackRepoEvent({ id: "evt_slack_follow_up_1", sourceEventId: "slack_follow_up_1", threadKey: "T123|C123|1710000000.000100" })
      })
    );
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toMatchObject({
      followUpRequest: {
        id: "follow_up_slack_1",
        status: "queued",
        activeRunId: "run_slack_active_1"
      }
    });
    expect(delivered.filter((message) => message.kind === "progress")).toEqual([]);
  });

  it("stores and returns repo policy rules", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    const response = await app.request("/v1/repo-bindings/github/acme/demo/policy-rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rule: {
          id: "repo_allows_labels",
          scope: "work_context_owner_container",
          effect: "allow",
          capabilityId: "set_labels",
          reason: "Repo allows approved label changes."
        }
      })
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ rule: { id: "repo_allows_labels" } });

    const listResponse = await app.request("/v1/repo-bindings/github/acme/demo/policy-rules");
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      rules: [{ id: "repo_allows_labels", effect: "allow" }]
    });
  });

  it("stores and returns repo mutation mappings", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    const response = await app.request("/v1/repo-bindings/github/acme/demo/mutation-mappings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mapping: {
          id: "github_status_labels",
          adapter: "github",
          domain: "status",
          strategy: "label",
          values: { blocked: "status/blocked" }
        }
      })
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ mapping: { id: "github_status_labels" } });

    const listResponse = await app.request("/v1/repo-bindings/github/acme/demo/mutation-mappings");
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      mappings: [{ id: "github_status_labels", domain: "status" }]
    });
  });

  it("records management audit events for repo policy and mutation mapping changes without rule details", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request(
      "/v1/repo-bindings/github/acme/demo/policy-rules",
      jsonRequest({
        rule: {
          id: "repo_allows_labels",
          scope: "work_context_owner_container",
          effect: "allow",
          capabilityId: "set_labels",
          reason: "Internal audit detail that should not be copied into control-plane event payloads."
        }
      })
    );
    await app.request(
      "/v1/repo-bindings/github/acme/demo/mutation-mappings",
      jsonRequest({
        mapping: {
          id: "github_status_labels",
          adapter: "github",
          domain: "status",
          strategy: "label",
          values: { blocked: "status/blocked-internal-label" },
          description: "Internal mapping detail that should stay in the mapping record."
        }
      })
    );

    const audit = await app.request("/v1/control-plane-events?limit=20");
    const { events } = await audit.json();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "binding.repository.policy_rule.upserted",
          subject: "github:acme/demo:repo_allows_labels",
          payload: {
            provider: "github",
            owner: "acme",
            repo: "demo",
            ruleId: "repo_allows_labels",
            scope: "work_context_owner_container",
            effect: "allow",
            capabilityId: "set_labels",
            hasReason: true
          }
        }),
        expect.objectContaining({
          type: "binding.repository.mutation_mapping.upserted",
          subject: "github:acme/demo:github_status_labels",
          payload: {
            provider: "github",
            owner: "acme",
            repo: "demo",
            mappingId: "github_status_labels",
            adapter: "github",
            domain: "status",
            strategy: "label",
            valueCount: 1,
            hasDescription: true
          }
        })
      ])
    );
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain("Internal audit detail");
    expect(serializedEvents).not.toContain("status/blocked-internal-label");
    expect(serializedEvents).not.toContain("Internal mapping detail");
  });

  it("delivers acknowledgement, human progress, and final callback messages with audit events", async () => {
    const delivered: { kind: string; body: string; blocks?: unknown[] }[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body, ...(message.blocks?.length ? { blocks: message.blocks } : {}) });
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo",
        allowedActors: ["octocat"]
      })
    });
    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_2", event: { ...validEvent, id: "evt_2", sourceEventId: "comment_2" } })
    });
    expect(createResponse.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_2/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "executor.progress", message: "running tests", at: "2026-06-24T00:00:01.000Z", visibility: "human" })
    });
    const completeResponse = await app.request("/v1/runners/runner_1/runs/run_2/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: { conclusion: "success", summary: "done" } })
    });
    expect(completeResponse.status).toBe(200);

    const getResponse = await app.request("/v1/runs/run_2");
    const stored = await getResponse.json();
    expect(stored.run.status).toBe("succeeded");
    expect(stored.run.result.summary).toBe("done");
    expect(delivered).toEqual([
      { kind: "acknowledgement", body: "OpenTag picked this up. Run: `run_2`" },
      { kind: "progress", body: "OpenTag progress for `run_2`: running tests" },
      { kind: "final", body: "OpenTag finished with **success**.\n\ndone" }
    ]);

    const eventsResponse = await app.request("/v1/runs/run_2/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "callback.acknowledgement.queued",
      "callback.acknowledgement.delivered",
      "run.claimed",
      "run.progress",
      "callback.progress.queued",
      "callback.progress.delivered",
      "run.completed",
      "callback.final.queued",
      "callback.final.delivered"
    ]);
    expect(events.find((event: { type: string }) => event.type === "run.progress")).toMatchObject({
      visibility: "human",
      importance: "normal",
      message: "running tests"
    });
    expect(events.find((event: { type: string }) => event.type === "admission.decided")).toMatchObject({
      visibility: "audit",
      importance: "normal"
    });
    expect(events.find((event: { type: string }) => event.type === "context_packet.generated")).toMatchObject({
      visibility: "audit",
      importance: "normal"
    });
    expect(events.find((event: { type: string }) => event.type === "callback.final.delivered")).toMatchObject({
      visibility: "human",
      importance: "high"
    });
  });

  it("keeps default audit progress out of source-thread callbacks", async () => {
    const delivered: { kind: string; body: string }[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo",
        allowedActors: ["octocat"]
      })
    });
    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_audit_progress", event: { ...validEvent, id: "evt_audit_progress", sourceEventId: "comment_audit_progress" } })
    });
    expect(createResponse.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const progressResponse = await app.request("/v1/runners/runner_1/runs/run_audit_progress/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "executor.progress", message: "internal tool detail", at: "2026-06-24T00:00:01.000Z" })
    });
    expect(progressResponse.status).toBe(200);

    expect(delivered).toEqual([{ kind: "acknowledgement", body: "OpenTag picked this up. Run: `run_audit_progress`" }]);

    const eventsResponse = await app.request("/v1/runs/run_audit_progress/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "callback.acknowledgement.queued",
      "callback.acknowledgement.delivered",
      "run.claimed",
      "run.progress"
    ]);
    expect(events.find((event: { type: string }) => event.type === "run.progress")).toMatchObject({
      visibility: "audit",
      importance: "normal",
      message: "internal tool detail"
    });
  });

  it("keeps hook-ingest progress aliases audit-only by default", async () => {
    const delivered: { kind: string; body: string }[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo",
      allowedActors: ["ou_sender"]
    }));
    const createResponse = await app.request("/v1/runs", jsonRequest({
      runId: "run_hook_ingest_progress",
      event: larkRepoEvent({ id: "evt_hook_ingest_progress", sourceEventId: "msg_hook_ingest_progress" })
    }));
    expect(createResponse.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const progressBody = {
      type: "ingest.hermes.post_llm_call",
      message: "Hermes post_llm_call completed.",
      at: "2026-06-24T00:00:01.000Z",
      idempotencyKey: "hermes:run_hook_ingest_progress:progress:post_llm_call"
    };
    const progressResponse = await app.request(
      "/v1/runners/runner_1/runs/run_hook_ingest_progress/progress",
      jsonRequest(progressBody)
    );
    const replayResponse = await app.request(
      "/v1/runners/runner_1/runs/run_hook_ingest_progress/progress",
      jsonRequest({ ...progressBody, message: "retry should stay invisible" })
    );
    expect(progressResponse.status).toBe(200);
    expect(replayResponse.status).toBe(200);
    await expect(replayResponse.json()).resolves.toEqual({ ok: true, replayed: true });

    expect(delivered.filter((message) => message.kind === "progress")).toEqual([]);

    const eventsResponse = await app.request("/v1/runs/run_hook_ingest_progress/events");
    const { events } = await eventsResponse.json();
    const progressEvents = events.filter((event: { type: string }) => event.type === "run.progress");
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]).toMatchObject({
      visibility: "audit",
      importance: "normal",
      message: "Hermes post_llm_call completed.",
      payload: expect.objectContaining({
        type: "ingest.hermes.post_llm_call",
        idempotencyKey: "hermes:run_hook_ingest_progress:progress:post_llm_call"
      })
    });
    expect(events.some((event: { type: string }) => event.type.startsWith("callback.progress."))).toBe(false);
    expect(JSON.stringify(events)).not.toContain("retry should stay invisible");
  });

  it("requires runner-scoped progress and completion after claim", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Runner One" })
    });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_scoped_1", event: { ...validEvent, id: "evt_scoped_1", sourceEventId: "comment_scoped_1" } })
    });

    const deprecatedProgress = await app.request("/v1/runs/run_scoped_1/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "executor.progress", message: "running tests" })
    });
    expect(deprecatedProgress.status).toBe(410);

    const deprecatedComplete = await app.request("/v1/runs/run_scoped_1/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: { conclusion: "success", summary: "done" } })
    });
    expect(deprecatedComplete.status).toBe(410);
  });

  it("records duplicate source-event admission as an idempotent replay", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Runner One" })
    });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const first = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_dup_a", event: { ...validEvent, id: "evt_dup_a", sourceEventId: "comment_dup_a" } })
    });
    expect(first.status).toBe(201);

    const replay = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_dup_b", event: { ...validEvent, id: "evt_dup_a", sourceEventId: "comment_dup_a" } })
    });
    expect(replay.status).toBe(200);
    const replayJson = await replay.json();
    expect(replayJson.idempotentReplay).toBe(true);
    expect(replayJson.run.id).toBe("run_dup_a");

    const eventsResponse = await app.request("/v1/runs/run_dup_a/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toContain("admission.decided");
    expect(events.map((event: { type: string }) => event.type)).toContain("run.create_idempotent_replay");
  });

  it("replays duplicate source delivery ids even when event ids differ", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Runner One" })
    });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const first = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_delivery_a",
        event: {
          ...validEvent,
          id: "evt_delivery_a",
          sourceEventId: "comment_delivery_a",
          metadata: { ...validEvent.metadata, sourceDeliveryId: "delivery_replay_1", webhookSignatureVerified: true }
        }
      })
    );
    expect(first.status).toBe(201);

    const replay = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_delivery_b",
        event: {
          ...validEvent,
          id: "evt_delivery_b",
          sourceEventId: "comment_delivery_b",
          metadata: { ...validEvent.metadata, sourceDeliveryId: "delivery_replay_1", webhookSignatureVerified: true }
        }
      })
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      decision: {
        action: "drop_duplicate",
        reasonCode: "duplicate_source_delivery",
        activeRunId: "run_delivery_a"
      },
      run: { id: "run_delivery_a" },
      idempotentReplay: true
    });

    const eventsResponse = await app.request("/v1/runs/run_delivery_a/events");
    const { events } = await eventsResponse.json();
    expect(events.find((event: { type: string }) => event.type === "run.create_idempotent_replay")?.payload).toMatchObject({
      replayKey: { kind: "source_delivery", source: "github", deliveryId: "delivery_replay_1" },
      provenance: {
        sourceEventId: "comment_delivery_b",
        sourceDeliveryId: "delivery_replay_1",
        signatureState: "verified",
        admissionDecision: { reasonCode: "duplicate_source_delivery" }
      }
    });
  });

  it("returns 404 when promoting a missing follow-up request", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const response = await app.request("/v1/follow-up-requests/missing/create-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_missing_follow_up" })
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "follow_up_request_not_found" });
  });

  it("returns 409 when promoting a follow-up request that is no longer queued", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_active_for_promote", event: { ...validEvent, id: "evt_active_for_promote", sourceEventId: "comment_active_for_promote" } })
    });
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "follow_up_for_promote", event: { ...validEvent, id: "evt_follow_up_for_promote", sourceEventId: "comment_follow_up_for_promote" } })
    });

    const first = await app.request("/v1/follow-up-requests/follow_up_for_promote/create-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_promoted_once" })
    });
    expect(first.status).toBe(201);

    const second = await app.request("/v1/follow-up-requests/follow_up_for_promote/create-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_promoted_twice" })
    });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({ error: "follow_up_request_not_queued" });
  });

  it("renders Slack callbacks with Slack mrkdwn and keeps progress audit-only", async () => {
    const delivered: { kind: string; body: string; blocks?: unknown[] }[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body, ...(message.blocks?.length ? { blocks: message.blocks } : {}) });
        }
      },
      sourceReceiptSink: {
        async deliver() {
          return { delivered: true };
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const slackEvent = {
      ...validEvent,
      id: "evt_slack_1",
      source: "slack",
      sourceEventId: "Ev123",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      permissions: [{ scope: "chat:postMessage", reason: "reply in thread" }],
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100"
      }
    };

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_slack_1", event: slackEvent })
    });
    expect(createResponse.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const progressResponse = await app.request("/v1/runners/runner_1/runs/run_slack_1/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "executor.progress", message: "Echo executor started", at: "2026-06-24T00:00:01.000Z" })
    });
    expect(progressResponse.status).toBe(200);
    const completeResponse = await app.request("/v1/runners/runner_1/runs/run_slack_1/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "success",
          summary: "Echoed OpenTag command: introduce yourself",
          verification: [{ command: "echo", outcome: "passed" }]
        }
      })
    });
    expect(completeResponse.status).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "final",
        body: "*Finished: success.*\nEchoed OpenTag command: introduce yourself\nVerified: `echo` passed\n\nAudit: `opentag status --run run_slack_1`",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Finished: success.*\nEchoed OpenTag command: introduce yourself"
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Verified: `echo` passed"
            }
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "Audit: `opentag status --run run_slack_1`"
              }
            ]
          }
        ]
      }
    ]);
    expect(delivered.every((message) => (message as { agentId?: string }).agentId === undefined)).toBe(true);
    expect(delivered.at(-1)?.body).not.toContain("**success**");

    const eventsResponse = await app.request("/v1/runs/run_slack_1/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "source_receipt.delivered",
      "run.claimed",
      "run.progress",
      "run.completed",
      "callback.final.queued",
      "callback.final.delivered"
    ]);
    expect(events.find((event: { type: string }) => event.type === "run.progress")).toMatchObject({
      visibility: "audit",
      importance: "normal",
      message: "Echo executor started"
    });
  });

  it("delivers Slack received and running source receipts without posting text acknowledgements", async () => {
    const callbacks: { kind: string }[] = [];
    const receipts: Array<{ runId: string; provider: string; state: string; agentId?: string; channelId: unknown; messageTs: unknown }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          callbacks.push({ kind: message.kind });
        }
      },
      sourceReceiptSink: {
        async deliver(receipt) {
          receipts.push({
            runId: receipt.runId,
            provider: receipt.provider,
            state: receipt.state,
            ...(receipt.agentId ? { agentId: receipt.agentId } : {}),
            channelId: receipt.event.metadata["channelId"],
            messageTs: receipt.event.metadata["messageTs"]
          });
          return { delivered: true };
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = slackRepoEvent({ id: "evt_slack_receipt", sourceEventId: "EvSlackReceipt", threadKey: "T123|C123|1710000000.000100" });
    const createResponse = await app.request("/v1/runs", jsonRequest({ runId: "run_slack_receipt", event }));
    expect(createResponse.status).toBe(201);

    const claimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(claimResponse.status).toBe(200);
    const runningResponse = await app.request("/v1/runners/runner_1/runs/run_slack_receipt/running", jsonRequest({ executor: "echo" }));
    expect(runningResponse.status).toBe(200);

    const replayResponse = await app.request("/v1/runs", jsonRequest({ runId: "run_slack_receipt_replay", event }));
    expect(replayResponse.status).toBe(200);

    expect(callbacks).toEqual([]);
    expect(receipts).toEqual([
      {
        runId: "run_slack_receipt",
        provider: "slack",
        state: "received",
        agentId: "opentag",
        channelId: "C123",
        messageTs: "1710000000.000100"
      },
      {
        runId: "run_slack_receipt",
        provider: "slack",
        state: "running",
        agentId: "opentag",
        channelId: "C123",
        messageTs: "1710000000.000100"
      }
    ]);

    const eventsResponse = await app.request("/v1/runs/run_slack_receipt/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "source_receipt.delivered",
      "run.claimed",
      "run.running",
      "source_receipt.delivered",
      "admission.decided",
      "run.create_idempotent_replay"
    ]);
    expect(
      events
        .filter((event: { type: string }) => event.type === "source_receipt.delivered")
        .map((event: { visibility: string; importance: string; payload: { provider: string; state: string } }) => ({
          visibility: event.visibility,
          importance: event.importance,
          payload: event.payload
        }))
    ).toEqual([
      {
        visibility: "audit",
        importance: "low",
        payload: {
          provider: "slack",
          state: "received"
        }
      },
      {
        visibility: "audit",
        importance: "low",
        payload: {
          provider: "slack",
          state: "running"
        }
      }
    ]);
  });

  it("falls back to a Slack text acknowledgement when the source receipt is not delivered", async () => {
    const callbacks: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          callbacks.push({ kind: message.kind, body: message.body });
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = slackRepoEvent({ id: "evt_slack_receipt_fallback", sourceEventId: "EvSlackReceiptFallback", threadKey: "T123|C123|1710000000.000100" });
    const createResponse = await app.request("/v1/runs", jsonRequest({ runId: "run_slack_receipt_fallback", event }));
    expect(createResponse.status).toBe(201);
    expect(callbacks).toEqual([{ kind: "acknowledgement", body: "Working on it." }]);

    const eventsResponse = await app.request("/v1/runs/run_slack_receipt_fallback/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "callback.acknowledgement.queued",
      "callback.acknowledgement.delivered"
    ]);
  });

  it("delivers Lark received source receipts without posting received cards", async () => {
    const callbacks: { kind: string }[] = [];
    const receipts: Array<{ runId: string; provider: string; state: string; chatId: unknown; messageId: unknown }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          callbacks.push({ kind: message.kind });
        }
      },
      sourceReceiptSink: {
        async deliver(receipt) {
          receipts.push({
            runId: receipt.runId,
            provider: receipt.provider,
            state: receipt.state,
            chatId: receipt.event.metadata["chatId"],
            messageId: receipt.event.metadata["messageId"]
          });
          return { delivered: true };
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = larkRepoEvent({ id: "evt_lark_receipt", sourceEventId: "EvLarkReceipt" });
    const createResponse = await app.request("/v1/runs", jsonRequest({ runId: "run_lark_receipt", event }));
    expect(createResponse.status).toBe(201);

    expect(callbacks).toEqual([]);
    expect(receipts).toEqual([
      {
        runId: "run_lark_receipt",
        provider: "lark",
        state: "received",
        chatId: "oc_chat",
        messageId: "om_msg"
      }
    ]);

    const eventsResponse = await app.request("/v1/runs/run_lark_receipt/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "source_receipt.delivered"
    ]);
  });

  it("falls back to a Lark received card when the source receipt is not delivered", async () => {
    const callbacks: Array<{ kind: string; hasRich?: boolean }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          callbacks.push({ kind: message.kind, ...(message.rich ? { hasRich: true } : {}) });
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = larkRepoEvent({ id: "evt_lark_receipt_fallback", sourceEventId: "EvLarkReceiptFallback" });
    const createResponse = await app.request("/v1/runs", jsonRequest({ runId: "run_lark_receipt_fallback", event }));
    expect(createResponse.status).toBe(201);
    expect(callbacks).toEqual([{ kind: "acknowledgement", hasRich: true }]);
  });

  it("does not create a delayed Lark status card when the run finishes before the threshold", async () => {
    const delivered: Array<{ kind: string; statusMessageKey?: string; externalMessageId?: string; hasRich?: boolean }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      larkStatusCards: { delayMs: 20 },
      sourceReceiptSink: {
        async deliver() {
          return { delivered: true };
        }
      },
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {}),
            ...(message.externalMessageId ? { externalMessageId: message.externalMessageId } : {}),
            ...(message.rich ? { hasRich: true } : {})
          });
          return { externalMessageId: message.externalMessageId ?? "om_final" };
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = larkRepoEvent({ id: "evt_lark_short_status_card", sourceEventId: "EvLarkShortStatusCard" });
    expect((await app.request("/v1/runs", jsonRequest({ runId: "run_lark_short_status_card", event }))).status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(
      (await app.request("/v1/runners/runner_1/runs/run_lark_short_status_card/running", jsonRequest({ executor: "codex" }))).status
    ).toBe(200);
    expect(
      (await app.request("/v1/runners/runner_1/runs/run_lark_short_status_card/complete", jsonRequest({
        result: {
          conclusion: "success",
          summary: "Done quickly.",
          verification: [{ command: "echo", outcome: "passed" }]
        }
      }))).status
    ).toBe(200);

    await wait(40);

    expect(delivered).toEqual([
      {
        kind: "final",
        statusMessageKey: "run_lark_short_status_card:status",
        hasRich: true
      }
    ]);
  });

  it("creates a delayed Lark status card for long runs and patches final into the same message", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string; externalMessageId?: string; hasRich?: boolean }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      larkStatusCards: { delayMs: 10, minUpdateIntervalMs: 50 },
      sourceReceiptSink: {
        async deliver() {
          return { delivered: true };
        }
      },
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {}),
            ...(message.externalMessageId ? { externalMessageId: message.externalMessageId } : {}),
            ...(message.rich ? { hasRich: true } : {})
          });
          return { externalMessageId: message.externalMessageId ?? "om_status" };
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = larkRepoEvent({ id: "evt_lark_delayed_status_card", sourceEventId: "EvLarkDelayedStatusCard" });
    expect((await app.request("/v1/runs", jsonRequest({ runId: "run_lark_delayed_status_card", event }))).status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(
      (await app.request("/v1/runners/runner_1/runs/run_lark_delayed_status_card/running", jsonRequest({ executor: "codex" }))).status
    ).toBe(200);

    await wait(30);

    expect(delivered).toEqual([
      {
        kind: "progress",
        body: ["Running with codex.", "Run: run_lark_delayed_status_card", "Use /status here for details."].join("\n"),
        statusMessageKey: "run_lark_delayed_status_card:status",
        hasRich: true
      }
    ]);

    expect(
      (await app.request("/v1/runners/runner_1/runs/run_lark_delayed_status_card/complete", jsonRequest({
        result: {
          conclusion: "success",
          summary: "Done after status.",
          verification: [{ command: "echo", outcome: "passed" }]
        }
      }))).status
    ).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "progress",
        body: ["Running with codex.", "Run: run_lark_delayed_status_card", "Use /status here for details."].join("\n"),
        statusMessageKey: "run_lark_delayed_status_card:status",
        hasRich: true
      },
      {
        kind: "final",
        body: expect.stringContaining("Finished with success."),
        statusMessageKey: "run_lark_delayed_status_card:status",
        externalMessageId: "om_status",
        hasRich: true
      }
    ]);
  });

  it("patches delayed Lark progress at phase changes and throttles repeated progress", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string; externalMessageId?: string; hasRich?: boolean }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      larkStatusCards: { delayMs: 10, minUpdateIntervalMs: 1_000 },
      sourceReceiptSink: {
        async deliver() {
          return { delivered: true };
        }
      },
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {}),
            ...(message.externalMessageId ? { externalMessageId: message.externalMessageId } : {}),
            ...(message.rich ? { hasRich: true } : {})
          });
          return { externalMessageId: message.externalMessageId ?? "om_status" };
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));

    const event = larkRepoEvent({ id: "evt_lark_progress_status_card", sourceEventId: "EvLarkProgressStatusCard" });
    expect((await app.request("/v1/runs", jsonRequest({ runId: "run_lark_progress_status_card", event }))).status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_lark_progress_status_card/running", jsonRequest({ executor: "codex" }));
    await wait(30);
    expect(delivered).toHaveLength(1);
    await wait(10);

    expect((await app.request("/v1/runners/runner_1/runs/run_lark_progress_status_card/progress", jsonRequest({
      type: "executor.progress",
      message: "Starting codex exec"
    }))).status).toBe(200);
    expect((await app.request("/v1/runners/runner_1/runs/run_lark_progress_status_card/progress", jsonRequest({
      type: "executor.progress",
      message: "Still working with internal details"
    }))).status).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "progress",
        body: ["Running with codex.", "Run: run_lark_progress_status_card", "Use /status here for details."].join("\n"),
        statusMessageKey: "run_lark_progress_status_card:status",
        hasRich: true
      },
      {
        kind: "progress",
        body: ["OpenTag is still working.", "Run: run_lark_progress_status_card", "Use /status here for details."].join("\n"),
        statusMessageKey: "run_lark_progress_status_card:status",
        externalMessageId: "om_status",
        hasRich: true
      }
    ]);
    expect(delivered.map((delivery) => delivery.body).join("\n")).not.toContain("Still working with internal details");
  });

  it("renders Lark callbacks with lightweight acknowledgement while keeping process progress audit-only", async () => {
    const delivered: { kind: string; body: string }[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const larkEvent = {
      ...validEvent,
      id: "evt_lark_1",
      source: "lark",
      sourceEventId: "EvLark123",
      actor: { provider: "lark", providerUserId: "ou_123", handle: "Felix", organizationId: "tenant_123" },
      permissions: [{ scope: "chat:postMessage", reason: "reply in thread" }],
      callback: {
        provider: "lark",
        uri: "lark://im/v1/messages",
        threadKey: "tk_123|oc_chat|om_msg"
      }
    };

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_lark_1", event: larkEvent })
    });
    expect(createResponse.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const runningResponse = await app.request("/v1/runners/runner_1/runs/run_lark_1/running", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executor: "echo" })
    });
    expect(runningResponse.status).toBe(200);
    const progressResponse = await app.request("/v1/runners/runner_1/runs/run_lark_1/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "executor.progress",
        message: "Echo executor started",
        at: "2026-06-24T00:00:01.000Z",
        visibility: "human"
      })
    });
    expect(progressResponse.status).toBe(200);

    const completeResponse = await app.request("/v1/runners/runner_1/runs/run_lark_1/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "success",
          summary: "Echoed OpenTag command: introduce yourself",
          verification: [{ command: "echo", outcome: "passed" }]
        }
      })
    });
    expect(completeResponse.status).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "acknowledgement",
        body: ["Received. OpenTag is working.", "Run: run_lark_1", "Use /status here for queue state; audit locally with opentag status --run run_lark_1."].join(
          "\n"
        )
      },
      {
        kind: "final",
        body: "Finished with success.\n\nEchoed OpenTag command: introduce yourself\n\nVerification\n- echo: passed\n\nAudit: opentag status --run run_lark_1"
      }
    ]);

    const eventsResponse = await app.request("/v1/runs/run_lark_1/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "callback.acknowledgement.queued",
      "callback.acknowledgement.delivered",
      "run.claimed",
      "run.running",
      "run.progress",
      "callback.progress.suppressed",
      "run.completed",
      "callback.final.queued",
      "callback.final.delivered"
    ]);
    expect(events.find((event: { type: string }) => event.type === "run.progress")).toMatchObject({
      visibility: "human",
      importance: "normal",
      message: "Echo executor started"
    });
    expect(events.filter((event: { type: string }) => event.type === "callback.progress.suppressed")).toHaveLength(1);
    expect(events.filter((event: { type: string }) => event.type === "callback.progress.suppressed")[0]).toMatchObject({
      visibility: "audit",
      importance: "low",
      payload: {
        provider: "lark",
        reason: "platform_liveness_strategy",
        requestedVisibility: "human",
        livenessStrategy: "source_receipt"
      }
    });
  });

  it("reuses the first Lark status message id when delivering the final card", async () => {
    const delivered: Array<{
      kind: string;
      statusMessageKey?: string;
      externalMessageId?: string;
      hasRich?: boolean;
    }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {}),
            ...(message.externalMessageId ? { externalMessageId: message.externalMessageId } : {}),
            ...(message.rich ? { hasRich: true } : {})
          });
          return { externalMessageId: message.externalMessageId ?? "om_status" };
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const larkEvent = {
      ...validEvent,
      id: "evt_lark_status_card",
      source: "lark",
      sourceEventId: "EvLarkStatusCard",
      actor: { provider: "lark", providerUserId: "ou_123", handle: "Felix", organizationId: "tenant_123" },
      permissions: [{ scope: "chat:postMessage", reason: "reply in thread" }],
      callback: {
        provider: "lark",
        uri: "lark://im/v1/messages",
        threadKey: "tk_123|oc_chat|om_msg"
      }
    };

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_lark_status_card", event: larkEvent })
    });
    expect(createResponse.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const completeResponse = await app.request("/v1/runners/runner_1/runs/run_lark_status_card/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "success",
          summary: "Done.",
          verification: [{ command: "echo", outcome: "passed" }]
        }
      })
    });
    expect(completeResponse.status).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "acknowledgement",
        statusMessageKey: "run_lark_status_card:status",
        hasRich: true
      },
      {
        kind: "final",
        statusMessageKey: "run_lark_status_card:status",
        externalMessageId: "om_status",
        hasRich: true
      }
    ]);
  });

  it("records proposal approval decisions and creates apply plans", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        allowedActors: ["octocat"]
      })
    });

    const event = {
      ...validEvent,
      id: "evt_protocol",
      sourceEventId: "comment_protocol",
      permissions: [
        ...validEvent.permissions,
        { scope: "repo:write", reason: "mutate labels after approval" }
      ],
      metadata: { owner: "acme", repo: "demo", issueNumber: 2 }
    };
    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_protocol", event })
    });
    expect(createResponse.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_protocol/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "needs_human",
          summary: "Prepared proposal.",
          suggestedChanges: [
            {
              proposalId: "proposal_protocol",
              createdAt: "2026-06-24T00:00:01.000Z",
              sourceRunId: "run_protocol",
              summary: "Add bug label.",
              intents: [
                {
                  intentId: "intent_label_bug",
                  domain: "labels",
                  action: "add_label",
                  summary: "Add the bug label.",
                  params: { label: "bug" }
                }
              ]
            }
          ]
        }
      })
    });

    const proposalResponse = await app.request("/v1/proposals/proposal_protocol");
    expect(proposalResponse.status).toBe(200);
    await expect(proposalResponse.json()).resolves.toMatchObject({
      runId: "run_protocol",
      snapshot: { proposalId: "proposal_protocol" }
    });
    const lineageResponse = await app.request("/v1/proposals/proposal_protocol/lineage");
    expect(lineageResponse.status).toBe(200);
    await expect(lineageResponse.json()).resolves.toMatchObject({
      lineage: {
        entries: [{ proposalId: "proposal_protocol", intentId: "intent_label_bug", status: "current" }]
      }
    });
    const currentIntentsResponse = await app.request("/v1/proposals/proposal_protocol/current-intents");
    expect(currentIntentsResponse.status).toBe(200);
    await expect(currentIntentsResponse.json()).resolves.toMatchObject({
      intents: [{ intentId: "intent_label_bug", status: "current" }]
    });

    const approvalResponse = await app.request("/v1/proposals/proposal_protocol/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "approval_protocol",
        approvedIntentIds: ["intent_label_bug"],
        approvedBy: { provider: "github", providerUserId: "42", handle: "octocat" },
        approvedAt: "2026-06-24T00:00:02.000Z",
        reason: "Maintainer approved label mutation.",
        metadata: { source: "manual_protocol_test" }
      })
    });
    expect(approvalResponse.status).toBe(201);
    await expect(approvalResponse.json()).resolves.toMatchObject({
      decision: {
        reason: "Maintainer approved label mutation.",
        metadata: { source: "manual_protocol_test" }
      }
    });

    const applyResponse = await app.request("/v1/proposals/proposal_protocol/apply-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "apply_protocol",
        approvalDecisionId: "approval_protocol",
        adapter: "github"
      })
    });
    expect(applyResponse.status).toBe(201);
    await expect(applyResponse.json()).resolves.toMatchObject({
      plan: {
        id: "apply_protocol",
        outcomes: [{ intentId: "intent_label_bug", outcome: "skipped" }]
      }
    });

    const eventsResponse = await app.request("/v1/runs/run_protocol/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual(
      expect.arrayContaining(["proposal.snapshot.created", "approval.decision.recorded", "apply_plan.created"])
    );

    const metricsResponse = await app.request("/v1/runs/run_protocol/metrics");
    expect(metricsResponse.status).toBe(200);
    await expect(metricsResponse.json()).resolves.toMatchObject({
      metrics: {
        runId: "run_protocol",
        suggestedChangesCount: 1,
        approvalDecisionCount: 1,
        applyPlanCount: 1,
        applyOutcomeCounts: { skipped: 1 }
      }
    });
    const repoMetricsResponse = await app.request("/v1/repo-bindings/github/acme/demo/metrics");
    expect(repoMetricsResponse.status).toBe(200);
    await expect(repoMetricsResponse.json()).resolves.toMatchObject({
      metrics: {
        scope: "repo",
        scopeId: "github:acme/demo",
        runCount: 1,
        suggestedChangesCount: 1
      }
    });
    const proposalAgainResponse = await app.request("/v1/proposals/proposal_protocol");
    const proposalAgain = await proposalAgainResponse.json();
    const threadId = proposalAgain.snapshot.workThread.id;
    const threadMetricsResponse = await app.request(`/v1/work-thread-metrics?threadId=${encodeURIComponent(threadId)}`);
    expect(threadMetricsResponse.status).toBe(200);
    await expect(threadMetricsResponse.json()).resolves.toMatchObject({
      metrics: {
        scope: "work_thread",
        scopeId: threadId,
        runCount: 1,
        suggestedChangesCount: 1
      }
    });
  });

  it("rejects approval decisions with overlapping approved and rejected intents", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    const response = await app.request("/v1/proposals/proposal_overlap/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        approvedIntentIds: ["intent_1"],
        rejectedIntentIds: ["intent_1"],
        approvedBy: { provider: "github", providerUserId: "42" }
      })
    });

    expect(response.status).toBe(400);
  });

  it("creates child runs from next action hints with lineage fields", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    });
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_parent", event: { ...validEvent, id: "evt_parent", sourceEventId: "comment_parent" } })
    });

    const childResponse = await app.request("/v1/runs/run_parent/child-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_child",
        action: {
          kind: "apply_suggested_changes",
          targetId: "proposal_parent",
          selectedIntentIds: ["intent_label_bug"]
        },
        commandText: "Apply approved label change"
      })
    });
    expect(childResponse.status).toBe(201);
    await expect(childResponse.json()).resolves.toMatchObject({
      run: {
        id: "run_child",
        parentRunId: "run_parent",
        sourceProposalId: "proposal_parent",
        triggeredByAction: {
          kind: "apply_suggested_changes",
          targetId: "proposal_parent"
        }
      }
    });

    const claimedResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const claimed = await claimedResponse.json();
    expect(claimed.run.id).toBe("run_parent");

    const parentEventsResponse = await app.request("/v1/runs/run_parent/events");
    const { events } = await parentEventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toContain("run.child_created");
  });

  it("executes approved GitHub label and assignee apply plans when explicitly requested", async () => {
    const githubRequests: Array<{ url: string; method: string; body: unknown; authorization: string | null }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "ghs_test",
        fetchImpl: (async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method ?? "GET",
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
            authorization: new Headers(init?.headers).get("authorization")
          });
          return Response.json({});
        }) as typeof fetch
      }
    });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        allowedActors: ["octocat"]
      })
    });

    const event = {
      ...validEvent,
      id: "evt_execute",
      sourceEventId: "comment_execute",
      permissions: [...validEvent.permissions, { scope: "repo:write", reason: "mutate issue fields after approval" }],
      metadata: { owner: "acme", repo: "demo", issueNumber: 7 }
    };
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_execute", event })
    });
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_execute/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "needs_human",
          summary: "Prepared proposal.",
          suggestedChanges: [
            {
              proposalId: "proposal_execute",
              createdAt: "2026-06-24T00:00:01.000Z",
              sourceRunId: "run_execute",
              summary: "Add bug label and assign owner.",
              intents: [
                {
                  intentId: "intent_label_bug",
                  domain: "labels",
                  action: "add_label",
                  summary: "Add the bug label.",
                  params: { label: "bug" }
                },
                {
                  intentId: "intent_assignee_alice",
                  domain: "assignee",
                  action: "set_assignee",
                  summary: "Assign the issue to Alice.",
                  params: { assignee: "alice" }
                }
              ]
            }
          ]
        }
      })
    });
    githubRequests.length = 0;
    await app.request("/v1/proposals/proposal_execute/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "approval_execute",
        approvedIntentIds: ["intent_label_bug", "intent_assignee_alice"],
        approvedBy: { provider: "github", providerUserId: "42", handle: "octocat" },
        approvedAt: "2026-06-24T00:00:02.000Z"
      })
    });

    const applyResponse = await app.request("/v1/proposals/proposal_execute/apply-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "apply_execute",
        approvalDecisionId: "approval_execute",
        adapter: "github",
        execute: true
      })
    });
    expect(applyResponse.status).toBe(201);
    await expect(applyResponse.json()).resolves.toMatchObject({
      plan: {
        id: "apply_execute",
        outcomes: [
          { intentId: "intent_label_bug", outcome: "applied", externalUri: "https://github.com/acme/demo/issues/7" },
          { intentId: "intent_assignee_alice", outcome: "applied", externalUri: "https://github.com/acme/demo/issues/7" }
        ]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/7/labels",
        method: "POST",
        authorization: "Bearer ghs_test",
        body: { labels: ["bug"] }
      },
      {
        url: "https://api.github.com/repos/acme/demo/issues/7",
        method: "PATCH",
        authorization: "Bearer ghs_test",
        body: { assignees: ["alice"] }
      }
    ]);

    const storedPlanResponse = await app.request("/v1/apply-plans/apply_execute");
    await expect(storedPlanResponse.json()).resolves.toMatchObject({
      plan: {
        adapterPlan: { externalWritesExecuted: true },
        outcomes: [
          { intentId: "intent_label_bug", outcome: "applied" },
          { intentId: "intent_assignee_alice", outcome: "applied" }
        ]
      }
    });

    const eventsResponse = await app.request("/v1/runs/run_execute/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toContain("apply_plan.executed");
  });

  it("does not persist apply plans when execution prerequisites fail", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        allowedActors: ["octocat"]
      })
    });
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_apply_prevalidation",
        event: {
          ...validEvent,
          id: "evt_apply_prevalidation",
          sourceEventId: "comment_apply_prevalidation",
          permissions: [...validEvent.permissions, { scope: "repo:write", reason: "mutate labels after approval" }],
          metadata: { owner: "acme", repo: "demo", issueNumber: 9 }
        }
      })
    });
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_apply_prevalidation/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "needs_human",
          summary: "Prepared proposal.",
          suggestedChanges: [
            {
              proposalId: "proposal_apply_prevalidation",
              createdAt: "2026-06-24T00:00:01.000Z",
              sourceRunId: "run_apply_prevalidation",
              summary: "Add bug label.",
              intents: [
                {
                  intentId: "intent_label_bug",
                  domain: "labels",
                  action: "add_label",
                  summary: "Add the bug label.",
                  params: { label: "bug" }
                }
              ]
            }
          ]
        }
      })
    });
    await app.request("/v1/proposals/proposal_apply_prevalidation/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "approval_apply_prevalidation",
        approvedIntentIds: ["intent_label_bug"],
        approvedBy: { provider: "github", providerUserId: "42", handle: "octocat" },
        approvedAt: "2026-06-24T00:00:02.000Z"
      })
    });

    const applyResponse = await app.request("/v1/proposals/proposal_apply_prevalidation/apply-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "apply_prevalidation",
        approvalDecisionId: "approval_apply_prevalidation",
        adapter: "github",
        execute: true
      })
    });
    expect(applyResponse.status).toBe(422);
    await expect(applyResponse.json()).resolves.toEqual({ error: "github_apply_not_configured" });

    const eventsResponse = await app.request("/v1/runs/run_apply_prevalidation/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).not.toContain("apply_plan.created");
  });

  it("executes approved GitHub status intents through label mappings", async () => {
    const githubRequests: Array<{ url: string; method: string; body: unknown; authorization: string | null }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "ghs_test",
        fetchImpl: (async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method ?? "GET",
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
            authorization: new Headers(init?.headers).get("authorization")
          });
          return Response.json({});
        }) as typeof fetch
      }
    });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        allowedActors: ["octocat"]
      })
    });
    await app.request("/v1/repo-bindings/github/acme/demo/mutation-mappings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mapping: {
          id: "github_status_labels",
          adapter: "github",
          domain: "status",
          strategy: "label",
          values: { blocked: "status/blocked" }
        }
      })
    });

    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_status_mapping",
        event: {
          ...validEvent,
          id: "evt_status_mapping",
          sourceEventId: "comment_status_mapping",
          permissions: [...validEvent.permissions, { scope: "repo:write", reason: "mutate issue status after approval" }],
          metadata: { owner: "acme", repo: "demo", issueNumber: 8 }
        }
      })
    });
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_status_mapping/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          conclusion: "needs_human",
          summary: "Prepared status proposal.",
          suggestedChanges: [
            {
              proposalId: "proposal_status_mapping",
              createdAt: "2026-06-24T00:00:01.000Z",
              sourceRunId: "run_status_mapping",
              summary: "Mark blocked.",
              intents: [
                {
                  intentId: "intent_status_blocked",
                  domain: "status",
                  action: "transition_status",
                  summary: "Mark blocked.",
                  params: { status: "blocked" }
                }
              ]
            }
          ]
        }
      })
    });
    await app.request("/v1/proposals/proposal_status_mapping/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "approval_status_mapping",
        approvedIntentIds: ["intent_status_blocked"],
        approvedBy: { provider: "github", providerUserId: "42", handle: "octocat" },
        approvedAt: "2026-06-24T00:00:02.000Z"
      })
    });

    const applyResponse = await app.request("/v1/proposals/proposal_status_mapping/apply-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "apply_status_mapping",
        approvalDecisionId: "approval_status_mapping",
        adapter: "github",
        execute: true
      })
    });
    expect(applyResponse.status).toBe(201);
    await expect(applyResponse.json()).resolves.toMatchObject({
      plan: {
        outcomes: [{ intentId: "intent_status_blocked", outcome: "applied" }]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/8/labels",
        method: "POST",
        authorization: "Bearer ghs_test",
        body: { labels: ["status/blocked"] }
      }
    ]);
  });

  it("adds a stable statusMessageKey when progress callbacks are delivered", async () => {
    const delivered: Array<{ kind: string; statusMessageKey?: string }> = [];
    const defaultPresentation = createDefaultCallbackPresentation();
    const app = createDispatcherApp({
      databasePath: ":memory:",
      presentation: {
        ...defaultPresentation,
        shouldDeliverAcknowledgement() {
          return true;
        },
        shouldDeliverStatusUpdate(provider) {
          return provider === "slack";
        },
        shouldDeliverProgress(provider) {
          return provider === "slack";
        },
        acknowledgement({ runId }) {
          return `ack ${runId}`;
        },
        progress({ message }) {
          return `progress ${message}`;
        },
        final() {
          return { body: "final" };
        },
        render(input) {
          if (input.presentation.kind === "run_status" && input.presentation.state === "received") {
            return { body: `ack ${input.presentation.runId}` };
          }
          if (input.presentation.kind === "run_status") {
            return { body: `progress ${input.presentation.message ?? input.presentation.state}` };
          }
          if (input.presentation.kind === "final_summary") {
            return { body: "final" };
          }
          return defaultPresentation.render(input);
        }
      },
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {})
          });
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_status_key",
        event: {
          ...validEvent,
          id: "evt_status_key",
          source: "slack",
          sourceEventId: "EvStatus",
          actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
          permissions: [{ scope: "chat:postMessage", reason: "reply in thread" }],
          callback: {
            provider: "slack",
            uri: "https://slack.com/api/chat.postMessage",
            threadKey: "T123|C123|1710000000.000100"
          }
        }
      })
    });
    expect(response.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const progressResponse = await app.request("/v1/runners/runner_1/runs/run_status_key/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "executor.progress", message: "working", at: "2026-06-24T00:00:01.000Z", visibility: "human" })
    });
    expect(progressResponse.status).toBe(200);

    expect(delivered).toEqual([
      { kind: "acknowledgement" },
      { kind: "progress", statusMessageKey: "run_status_key:status" }
    ]);
  });

  it("delivers a running liveness status when a status-update provider starts executing", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {})
          });
        }
      }
    });

    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    );

    const response = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_liveness_running",
        event: githubIssueEvent({ id: "evt_liveness_running", sourceEventId: "comment_liveness_running" })
      })
    );
    expect(response.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const runningResponse = await app.request(
      "/v1/runners/runner_1/runs/run_liveness_running/running",
      jsonRequest({ executor: "echo" })
    );
    expect(runningResponse.status).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "acknowledgement",
        body: "OpenTag picked this up. Run: `run_liveness_running`"
      },
      {
        kind: "progress",
        body: "OpenTag progress for `run_liveness_running`: Running with echo.",
        statusMessageKey: "run_liveness_running:status"
      }
    ]);
  });

  it("deduplicates runner running retries by idempotency key before liveness delivery", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {})
          });
        }
      }
    });

    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    );
    const response = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_running_replay",
        event: githubIssueEvent({ id: "evt_running_replay", sourceEventId: "comment_running_replay" })
      })
    );
    expect(response.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const body = {
      executor: "echo",
      runTimeoutMs: 30_000,
      idempotencyKey: "runner_1:run_running_replay:running"
    };
    const first = await app.request("/v1/runners/runner_1/runs/run_running_replay/running", jsonRequest(body));
    const replay = await app.request("/v1/runners/runner_1/runs/run_running_replay/running", jsonRequest({ ...body, executor: "codex" }));
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ ok: true, replayed: true });

    expect(delivered).toEqual([
      { kind: "acknowledgement", body: "OpenTag picked this up. Run: `run_running_replay`" },
      {
        kind: "progress",
        body: "OpenTag progress for `run_running_replay`: Running with echo.",
        statusMessageKey: "run_running_replay:status"
      }
    ]);
    const eventsResponse = await app.request("/v1/runs/run_running_replay/events");
    const { events } = await eventsResponse.json();
    expect(events.filter((event: { type: string }) => event.type === "run.running")).toHaveLength(1);
    expect(events.filter((event: { type: string }) => event.type === "callback.progress.delivered")).toHaveLength(1);
    expect(events.find((event: { type: string }) => event.type === "run.running")).toMatchObject({
      payload: expect.objectContaining({
        executor: "echo",
        runTimeoutMs: 30_000,
        idempotencyKey: "runner_1:run_running_replay:running"
      })
    });
    expect(JSON.stringify(events)).not.toContain("codex");
  });

  it("delivers a waiting-for-approval liveness status before a needs_human final callback", async () => {
    const delivered: Array<{ kind: string; body: string; statusMessageKey?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            body: message.body,
            ...(message.statusMessageKey ? { statusMessageKey: message.statusMessageKey } : {})
          });
        }
      }
    });

    await app.request(
      "/v1/repo-bindings",
      jsonRequest({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    );

    const response = await app.request(
      "/v1/runs",
      jsonRequest({
        runId: "run_waiting_approval",
        event: githubIssueEvent({ id: "evt_waiting_approval", sourceEventId: "comment_waiting_approval" })
      })
    );
    expect(response.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const completeResponse = await app.request(
      "/v1/runners/runner_1/runs/run_waiting_approval/complete",
      jsonRequest({
        result: {
          conclusion: "needs_human",
          summary: "Prepared approval request.",
          nextAction: "Approve or reject the proposed action."
        }
      })
    );
    expect(completeResponse.status).toBe(200);

    expect(delivered).toEqual([
      {
        kind: "acknowledgement",
        body: "OpenTag picked this up. Run: `run_waiting_approval`"
      },
      {
        kind: "progress",
        body: "OpenTag progress for `run_waiting_approval`: Waiting for approval.",
        statusMessageKey: "run_waiting_approval:status"
      },
      {
        kind: "final",
        body: expect.stringContaining("OpenTag finished with **needs_human**.")
      }
    ]);
  });

  it("deduplicates runner progress retries by idempotency key before callback delivery", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const defaultPresentation = createDefaultCallbackPresentation();
    const app = createDispatcherApp({
      databasePath: ":memory:",
      presentation: {
        ...defaultPresentation,
        shouldDeliverStatusUpdate(provider) {
          return provider === "github";
        },
        shouldDeliverProgress(provider) {
          return provider === "github";
        }
      },
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    const createResponse = await app.request("/v1/runs", jsonRequest({
      runId: "run_progress_replay",
      event: { ...validEvent, id: "evt_progress_replay", sourceEventId: "comment_progress_replay" }
    }));
    expect(createResponse.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const body = {
      type: "executor.progress",
      message: "working",
      at: "2026-06-24T00:00:01.000Z",
      visibility: "human",
      idempotencyKey: "runner_1:run_progress_replay:progress:1"
    };
    const first = await app.request("/v1/runners/runner_1/runs/run_progress_replay/progress", jsonRequest(body));
    const replay = await app.request("/v1/runners/runner_1/runs/run_progress_replay/progress", jsonRequest({ ...body, message: "working retry" }));
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ ok: true, replayed: true });

    expect(delivered).toEqual([
      { kind: "acknowledgement", body: "OpenTag picked this up. Run: `run_progress_replay`" },
      { kind: "progress", body: "OpenTag progress for `run_progress_replay`: working" }
    ]);
    const eventsResponse = await app.request("/v1/runs/run_progress_replay/events");
    const { events } = await eventsResponse.json();
    expect(events.filter((event: { type: string }) => event.type === "run.progress")).toHaveLength(1);
    expect(events.filter((event: { type: string }) => event.type === "callback.progress.delivered")).toHaveLength(1);
    expect(events.find((event: { type: string }) => event.type === "run.progress")).toMatchObject({
      payload: expect.objectContaining({ idempotencyKey: "runner_1:run_progress_replay:progress:1" })
    });
    expect(JSON.stringify(events)).not.toContain("working retry");
  });

  it("deduplicates runner completion retries by idempotency key before final callback delivery", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    const createResponse = await app.request("/v1/runs", jsonRequest({
      runId: "run_complete_replay",
      event: { ...validEvent, id: "evt_complete_replay", sourceEventId: "comment_complete_replay" }
    }));
    expect(createResponse.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const first = await app.request("/v1/runners/runner_1/runs/run_complete_replay/complete", jsonRequest({
      result: { conclusion: "success", summary: "done" },
      idempotencyKey: "runner_1:run_complete_replay:complete:1"
    }));
    const replay = await app.request("/v1/runners/runner_1/runs/run_complete_replay/complete", jsonRequest({
      result: { conclusion: "failure", summary: "retry should not replace result" },
      idempotencyKey: "runner_1:run_complete_replay:complete:1"
    }));
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ ok: true, replayed: true });

    expect(delivered).toEqual([
      { kind: "acknowledgement", body: "OpenTag picked this up. Run: `run_complete_replay`" },
      { kind: "final", body: "OpenTag finished with **success**.\n\ndone" }
    ]);
    const getResponse = await app.request("/v1/runs/run_complete_replay");
    await expect(getResponse.json()).resolves.toMatchObject({
      run: {
        status: "succeeded",
        result: { conclusion: "success", summary: "done" }
      }
    });
    const eventsResponse = await app.request("/v1/runs/run_complete_replay/events");
    const { events } = await eventsResponse.json();
    expect(events.filter((event: { type: string }) => event.type === "run.completed")).toHaveLength(1);
    expect(events.filter((event: { type: string }) => event.type === "callback.final.delivered")).toHaveLength(1);
    expect(events.find((event: { type: string }) => event.type === "run.completed")).toMatchObject({
      payload: expect.objectContaining({ idempotencyKey: "runner_1:run_complete_replay:complete:1" })
    });
    expect(JSON.stringify(events)).not.toContain("retry should not replace result");
  });

  it("rejects runs for repositories without an explicit binding", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_unbound", event: validEvent })
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      decision: {
        action: "needs_human_decision",
        reasonCode: "repo_not_bound"
      }
    });
    const audit = await app.request("/v1/control-plane-events?type=admission.needs_human_decision");
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        type: "admission.needs_human_decision",
        severity: "warn",
        subject: "run_unbound",
        payload: expect.objectContaining({
          runId: "run_unbound",
          source: "github",
          sourceEventId: "comment_1",
          projectTarget: "github:acme/demo",
          decision: expect.objectContaining({
            action: "needs_human_decision",
            reasonCode: "repo_not_bound"
          })
        })
      })
    ]);
  });

  it("rejects write-capable runs from actors outside the repo binding allowlist", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        allowedActors: ["someone-else"]
      })
    });
    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_denied",
        event: {
          ...validEvent,
          permissions: [
            ...validEvent.permissions,
            { scope: "repo:write", reason: "write branch" },
            { scope: "pr:create", reason: "open pull request" }
          ]
        }
      })
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      decision: {
        action: "needs_human_decision",
        reasonCode: "actor_not_allowed_for_write"
      }
    });
  });

  it("can require a human decision through an agent access profile hook", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      agentAccessProfileCheck: async () => ({
        allowed: false,
        reason: "The configured agent access profile does not allow this run in the current container.",
        reasonCode: "agent_access_profile_denied"
      })
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo"
      })
    });

    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_access_denied", event: validEvent })
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      decision: {
        action: "needs_human_decision",
        reasonCode: "agent_access_profile_denied"
      }
    });
  });

  it("accepts runner heartbeat for claimed runs", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
    });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" })
    });
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_heartbeat", event: validEvent })
    });
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const response = await app.request("/v1/runners/runner_1/runs/run_heartbeat/heartbeat", { method: "POST" });
    expect(response.status).toBe(200);

    const runnerResponse = await app.request("/v1/runners/runner_1");
    await expect(runnerResponse.json()).resolves.toMatchObject({
      runner: {
        runnerId: "runner_1",
        heartbeatAt: expect.any(String)
      }
    });

    const eventsResponse = await app.request("/v1/runs/run_heartbeat/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toContain("run.heartbeat");
  });

  it("returns needs_human_decision when the agent access profile hook denies the run", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      agentAccessProfileCheck: async () => ({
        allowed: false,
        reason: "access denied",
        reasonCode: "agent_access_profile_denied"
      })
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    });

    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_access_denied", event: validEvent })
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      decision: {
        action: "needs_human_decision",
        reasonCode: "agent_access_profile_denied"
      }
    });
  });

  it("stores and returns generic channel bindings", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const create = await app.request("/v1/channel-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "telegram",
        accountId: "bot_123",
        conversationId: "chat_456",
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        metadata: { title: "Ops chat" }
      })
    });
    expect(create.status).toBe(201);

    const get = await app.request("/v1/channel-bindings/telegram/bot_123/chat_456");
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.binding).toEqual({
      provider: "telegram",
      accountId: "bot_123",
      conversationId: "chat_456",
      repoProvider: "github",
      owner: "acme",
      repo: "demo",
      metadata: { title: "Ops chat" }
    });
  });

  it("deletes generic channel bindings", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/channel-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "lark",
        accountId: "tenant_1",
        conversationId: "oc_chat",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      })
    });

    const deleted = await app.request("/v1/channel-bindings/lark/tenant_1/oc_chat", { method: "DELETE" });
    expect(deleted.status).toBe(204);

    const get = await app.request("/v1/channel-bindings/lark/tenant_1/oc_chat");
    expect(get.status).toBe(404);

    const deleteAgain = await app.request("/v1/channel-bindings/lark/tenant_1/oc_chat", { method: "DELETE" });
    expect(deleteAgain.status).toBe(404);
  });

  it("cancels the active run for a bound source container", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    await app.request("/v1/channel-bindings", jsonRequest({
      provider: "lark",
      accountId: "tenant_1",
      conversationId: "oc_chat",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }));
    const create = await app.request("/v1/runs", jsonRequest({
      runId: "run_lark_cancel",
      event: larkRepoEvent({ id: "evt_lark_cancel", sourceEventId: "msg_lark_cancel" })
    }));
    expect(create.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_lark_cancel/running", jsonRequest({ executor: "echo" }));
    const followUp = await app.request("/v1/runs", jsonRequest({
      runId: "follow_up_lark_cancel",
      event: larkRepoEvent({ id: "evt_lark_cancel_follow_up", sourceEventId: "msg_lark_cancel_follow_up" })
    }));
    expect(followUp.status).toBe(202);

    const cancel = await app.request("/v1/channel-bindings/lark/tenant_1/oc_chat/cancel-active-run", jsonRequest({
      reason: "Stop requested from Lark.",
      requestedBy: "lark:ou_sender"
    }));
    expect(cancel.status).toBe(200);
    await expect(cancel.json()).resolves.toMatchObject({
      outcome: "cancelled",
      run: {
        id: "run_lark_cancel",
        status: "cancelled",
        result: { conclusion: "cancelled" }
      }
    });

    const lateComplete = await app.request("/v1/runners/runner_1/runs/run_lark_cancel/complete", jsonRequest({
      result: { conclusion: "success", summary: "late success" }
    }));
    expect(lateComplete.status).toBe(404);

    const stored = await app.request("/v1/runs/run_lark_cancel");
    await expect(stored.json()).resolves.toMatchObject({
      run: {
        status: "cancelled",
        result: { conclusion: "cancelled" }
      }
    });

    const queuedFollowUp = await app.request("/v1/follow-up-requests/follow_up_lark_cancel");
    await expect(queuedFollowUp.json()).resolves.toMatchObject({
      followUpRequest: {
        id: "follow_up_lark_cancel",
        status: "queued"
      }
    });
  });

  it("reports active run and queued follow-ups for a bound source container", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    await app.request("/v1/channel-bindings", jsonRequest({
      provider: "lark",
      accountId: "tenant_1",
      conversationId: "oc_chat",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }));
    const create = await app.request("/v1/runs", jsonRequest({
      runId: "run_lark_status",
      event: larkRepoEvent({ id: "evt_lark_status", sourceEventId: "msg_lark_status", messageId: "om_thread" })
    }));
    expect(create.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_lark_status/running", jsonRequest({ executor: "echo", runTimeoutMs: 30_000 }));

    const followUp = await app.request("/v1/runs", jsonRequest({
      runId: "follow_up_lark_status",
      event: larkRepoEvent({ id: "evt_lark_status_follow_up", sourceEventId: "msg_lark_status_follow_up", messageId: "om_thread" })
    }));
    expect(followUp.status).toBe(202);

    const status = await app.request("/v1/channel-bindings/lark/tenant_1/oc_chat/status");

    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      binding: {
        provider: "lark",
        accountId: "tenant_1",
        conversationId: "oc_chat",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      },
      activeRun: {
        id: "run_lark_status",
        status: "running"
      },
      runTimeoutPolicy: {
        hardTimeoutMs: 30_000
      },
      queuedFollowUps: [
        {
          id: "follow_up_lark_status",
          activeRunId: "run_lark_status",
          status: "queued"
        }
      ]
    });
  });

  it("replies to GitHub source-thread /status without creating a run", async () => {
    const delivered: Array<{ kind: string; body: string; runId: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body, runId: message.runId });
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    const create = await app.request("/v1/runs", jsonRequest({
      runId: "run_github_thread_status",
      event: githubIssueEvent({ id: "evt_github_thread_status", sourceEventId: "comment_github_thread_status", threadKey: "acme/demo#1" })
    }));
    expect(create.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_github_thread_status/running", jsonRequest({ executor: "echo", runTimeoutMs: 45_000 }));
    const followUp = await app.request("/v1/runs", jsonRequest({
      runId: "follow_up_github_thread_status",
      event: githubIssueEvent({ id: "evt_github_thread_status_follow_up", sourceEventId: "comment_github_thread_status_follow_up", threadKey: "acme/demo#1" })
    }));
    expect(followUp.status).toBe(202);
    delivered.length = 0;

    const status = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "@opentag /status",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      },
      metadata: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        issueNumber: 1
      }
    }));

    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      outcome: "status",
      bindingState: "bound",
      activeRun: {
        id: "run_github_thread_status",
        status: "running"
      },
      queuedFollowUps: [
        {
          id: "follow_up_github_thread_status",
          status: "queued"
        }
      ],
      runTimeoutPolicy: {
        hardTimeoutMs: 45_000
      }
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      kind: "final",
      runId: "run_github_thread_status"
    });
    expect(delivered[0]!.body).toContain("OpenTag status:");
    expect(delivered[0]!.body).toContain("Source container: github:acme/demo#1");
    expect(delivered[0]!.body).toContain("Project Target: github:acme/demo");
    expect(delivered[0]!.body).toContain("Active run: run_github_thread_status (running)");
    expect(delivered[0]!.body).toContain("Queued follow-ups: 1 (follow_up_github_thread_status (queued)");
  });

  it("replies to source-thread /doctor without creating a run when no run is active", async () => {
    const delivered: Array<{ kind: string; body: string; runId: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body, runId: message.runId });
        }
      }
    });
    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo"
    }));

    const doctor = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "@opentag /doctor",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      },
      metadata: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        issueNumber: 1
      }
    }));

    expect(doctor.status).toBe(200);
    await expect(doctor.json()).resolves.toMatchObject({
      outcome: "doctor",
      bindingState: "bound"
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.runId).toMatch(/^control_/);
    expect(delivered[0]!.body).toContain("OpenTag doctor (redacted):");
    expect(delivered[0]!.body).toContain("OK Source thread: github:acme/demo#1");
    const missing = await app.request(`/v1/runs/${delivered[0]!.runId}`);
    expect(missing.status).toBe(404);
  });

  it("cancels a GitLab active source-thread run from /stop without auto-promoting queued follow-ups", async () => {
    const delivered: Array<{ kind: string; body: string; runId: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body, runId: message.runId });
        }
      }
    });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "gitlab",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    const create = await app.request("/v1/runs", jsonRequest({
      runId: "run_gitlab_thread_stop",
      event: gitlabIssueEvent({ id: "evt_gitlab_thread_stop", sourceEventId: "note_gitlab_thread_stop", threadKey: "acme/demo|issue|1" })
    }));
    expect(create.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_gitlab_thread_stop/running", jsonRequest({ executor: "echo" }));
    const followUp = await app.request("/v1/runs", jsonRequest({
      runId: "follow_up_gitlab_thread_stop",
      event: gitlabIssueEvent({ id: "evt_gitlab_thread_stop_follow_up", sourceEventId: "note_gitlab_thread_stop_follow_up", threadKey: "acme/demo|issue|1" })
    }));
    expect(followUp.status).toBe(202);
    delivered.length = 0;

    const stop = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "@opentag /stop",
      actor: { provider: "gitlab", providerUserId: "7", handle: "alice" },
      callback: {
        provider: "gitlab",
        uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
        threadKey: "acme/demo|issue|1"
      },
      metadata: {
        repoProvider: "gitlab",
        owner: "acme",
        repo: "demo",
        projectPathWithNamespace: "acme/demo",
        issueIid: 1
      }
    }));

    expect(stop.status).toBe(200);
    await expect(stop.json()).resolves.toMatchObject({
      outcome: "cancelled",
      run: {
        id: "run_gitlab_thread_stop",
        status: "cancelled",
        result: { conclusion: "cancelled" }
      }
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      kind: "final",
      runId: "run_gitlab_thread_stop"
    });
    expect(delivered[0]!.body).toContain("Cancellation requested for run run_gitlab_thread_stop.");

    const lateComplete = await app.request("/v1/runners/runner_1/runs/run_gitlab_thread_stop/complete", jsonRequest({
      result: { conclusion: "success", summary: "late success" }
    }));
    expect(lateComplete.status).toBe(404);
    const queuedFollowUp = await app.request("/v1/follow-up-requests/follow_up_gitlab_thread_stop");
    await expect(queuedFollowUp.json()).resolves.toMatchObject({
      followUpRequest: {
        id: "follow_up_gitlab_thread_stop",
        status: "queued"
      }
    });
  });

  it("cancels a run by id", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    }));
    const create = await app.request("/v1/runs", jsonRequest({
      runId: "run_cancel_by_id",
      event: githubIssueEvent({ id: "evt_cancel_by_id", sourceEventId: "comment_cancel_by_id" })
    }));
    expect(create.status).toBe(201);

    const cancel = await app.request("/v1/runs/run_cancel_by_id/cancel", jsonRequest({ reason: "Stop requested." }));
    expect(cancel.status).toBe(200);
    await expect(cancel.json()).resolves.toMatchObject({
      outcome: "cancelled",
      run: { id: "run_cancel_by_id", status: "cancelled" }
    });

    const cancelAgain = await app.request("/v1/runs/run_cancel_by_id/cancel", jsonRequest({ reason: "Stop again." }));
    expect(cancelAgain.status).toBe(409);
    await expect(cancelAgain.json()).resolves.toMatchObject({ error: "run_already_terminal" });

    const events = await app.request("/v1/runs/run_cancel_by_id/events");
    await expect(events.json()).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "run.cancel_requested",
          payload: expect.objectContaining({
            terminalReason: "cancelled_by_user",
            terminalSemantics: "A human stop request is not a successful completion and does not auto-promote queued follow-ups."
          })
        })
      ])
    });
  });

  it("keeps Slack channel binding endpoints as compatibility wrappers", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const create = await app.request("/v1/slack-channel-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        teamId: "T123",
        channelId: "C123",
        repoProvider: "gitlab",
        owner: "acme",
        repo: "demo"
      })
    });
    expect(create.status).toBe(201);

    const get = await app.request("/v1/slack-channel-bindings/T123/C123");
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.binding).toEqual({
      teamId: "T123",
      channelId: "C123",
      repoProvider: "gitlab",
      owner: "acme",
      repo: "demo"
    });

    const genericGet = await app.request("/v1/channel-bindings/slack/T123/C123");
    expect(genericGet.status).toBe(200);
    await expect(genericGet.json()).resolves.toEqual({
      binding: {
        provider: "slack",
        accountId: "T123",
        conversationId: "C123",
        repoProvider: "gitlab",
        owner: "acme",
        repo: "demo"
      }
    });
  });

  it("accepts a Slack event when its repo metadata matches a bound GitHub repo", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    });

    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_slack_bound",
        event: {
          id: "evt_slack_bound",
          source: "slack",
          sourceEventId: "Ev123",
          receivedAt: "2026-06-24T00:00:00.000Z",
          actor: { provider: "slack", providerUserId: "U456", handle: "U456", organizationId: "T123" },
          target: { mention: "<@U_APP>", agentId: "opentag" },
          command: { rawText: "investigate this", intent: "investigate", args: {} },
          context: [],
          permissions: [
            { scope: "chat:postMessage", reason: "reply in thread" },
            { scope: "runner:local", reason: "execute locally" }
          ],
          callback: {
            provider: "slack",
            uri: "https://slack.com/api/chat.postMessage",
            threadKey: "T123|C123|1710000000.000100"
          },
          metadata: {
            teamId: "T123",
            channelId: "C123",
            messageTs: "1710000000.000100",
            repoProvider: "github",
            owner: "acme",
            repo: "demo"
          }
        }
      })
    });

    expect(response.status).toBe(201);
  });

  it("passes the target agent id through Slack callbacks", async () => {
    const delivered: Array<{ kind: string; agentId?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({
            kind: message.kind,
            ...(message.agentId ? { agentId: message.agentId } : {})
          });
        }
      },
      sourceReceiptSink: {
        async deliver() {
          return { delivered: true };
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    });

    const slackEvent = {
      ...validEvent,
      id: "evt_slack_agent",
      source: "slack",
      sourceEventId: "EvAgent",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      target: { mention: "<@U_DEEP>", agentId: "deepseek" },
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100"
      }
    };

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_slack_agent", event: slackEvent })
    });
    expect(createResponse.status).toBe(201);

    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    const completeResponse = await app.request("/v1/runners/runner_1/runs/run_slack_agent/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: { conclusion: "success", summary: "done" } })
    });
    expect(completeResponse.status).toBe(200);

    expect(delivered).toEqual([
      { kind: "final", agentId: "deepseek" }
    ]);
  });

  it("applies a model-suggested GitHub label action from a source-thread reply", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: Array<{ url: string; method?: string; body?: unknown; authorization?: string | null }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            authorization: new Headers(init?.headers).get("authorization")
          });
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_apply",
      event: githubIssueEvent({ id: "evt_thread_apply", sourceEventId: "comment_thread_apply", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_apply",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "applied",
      decision: { proposalId: "proposal_thread_apply", approvedIntentIds: ["intent_label_bug"] },
      plan: {
        proposalId: "proposal_thread_apply",
        selectedIntentIds: ["intent_label_bug"],
        outcomes: [{ intentId: "intent_label_bug", outcome: "applied" }]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/1/labels",
        method: "POST",
        body: { labels: ["bug"] },
        authorization: "Bearer gh_test"
      }
    ]);
    expect(delivered.some((message) => message.body.includes("<summary>Ready to apply</summary>"))).toBe(true);
    expect(delivered.at(-1)?.body).toContain("Applied: Add the bug label.");
    expect(delivered.at(-1)?.body).not.toContain("proposal_thread_apply");
    expect(delivered.at(-1)?.body).not.toContain("intent_label_bug");

    const deliveredCountAfterFirstApply = delivered.length;
    const replayResponse = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(replayResponse.status).toBe(200);
    await expect(replayResponse.json()).resolves.toMatchObject({
      outcome: "already_applied",
      plan: {
        proposalId: "proposal_thread_apply",
        outcomes: [{ intentId: "intent_label_bug", outcome: "applied" }]
      }
    });
    expect(githubRequests).toHaveLength(1);
    expect(delivered).toHaveLength(deliveredCountAfterFirstApply + 1);
    expect(delivered.at(-1)?.body).toContain("Already applied: Add the bug label.");
    expect(delivered.at(-1)?.body).toContain("No external write was repeated.");
    expect(delivered.at(-1)?.body).not.toContain("proposal_thread_apply");
  });

  it("renders needs-setup receipts without apply commands when GitHub apply is not configured", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_apply_not_configured",
      event: githubIssueEvent({ id: "evt_thread_apply_not_configured", sourceEventId: "comment_thread_apply_not_configured", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_apply_not_configured",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug_not_configured",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });

    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("Add the bug label."));
    expect(finalMessage?.body).toContain("<summary>Needs setup</summary>");
    expect(finalMessage?.body).toContain("GitHub apply is not configured on this dispatcher.");
    expect(finalMessage?.body).not.toContain("`apply 1`");
    expect(finalMessage?.body).toContain("`continue 1`");
    expect(finalMessage?.body).toContain("`reject 1`");
  });

  it("renders needs-setup receipts when create PR lacks the branch-exists executor condition", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const event = githubIssueEvent({ id: "evt_thread_pr_missing_condition", sourceEventId: "comment_thread_pr_missing_condition", threadKey: "acme/demo" });
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async () => {
          throw new Error("missing executor condition should prevent apply from looking ready");
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_pr_missing_condition",
      event: {
        ...event,
        permissions: [...event.permissions, { scope: "pr:create", reason: "create an approved pull request" }]
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_pr_missing_condition",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Create a pull request.",
          intents: [
            {
              intentId: "intent_pr_missing_condition",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create a pull request for branch opentag/missing-condition.",
              params: {
                title: "OpenTag run missing condition",
                head: "opentag/missing-condition",
                base: "main"
              }
            }
          ]
        }
      ]
    });

    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("Create a pull request for branch"));
    expect(finalMessage?.body).toContain("<summary>Needs setup</summary>");
    expect(finalMessage?.body).toContain("Missing executor condition: isolated branch exists.");
    expect(finalMessage?.body).not.toContain("`apply 1`");
    expect(finalMessage?.body).toContain("`continue 1`");
  });

  it("renders needs-setup receipts before GitHub preflight when platform write permission is missing", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async () => {
          throw new Error("missing platform permission should prevent GitHub preflight");
        }
      }
    });
    const event = githubIssueEvent({ id: "evt_thread_missing_permission", sourceEventId: "comment_thread_missing_permission", threadKey: "acme/demo" });

    await seedCompletedProposal({
      app,
      runId: "run_thread_missing_permission",
      event: {
        ...event,
        permissions: [{ scope: "issue:comment", reason: "reply to source thread" }]
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_missing_permission",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_missing_permission",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });

    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("Add the bug label."));
    expect(finalMessage?.body).toContain("<summary>Needs setup</summary>");
    expect(finalMessage?.body).toContain("Missing platform permission for set_labels.");
    expect(finalMessage?.body).not.toContain("`apply 1`");
    expect(finalMessage?.body).toContain("`continue 1`");
  });

  it("renders needs-setup receipts when GitHub preflight cannot access the target", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: Array<{ url: string; method?: string; authorization?: string | null; hasSignal: boolean }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            authorization: new Headers(init?.headers).get("authorization"),
            hasSignal: Boolean(init?.signal)
          });
          return new Response("forbidden", { status: 403 });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_preflight_forbidden",
      event: githubIssueEvent({ id: "evt_thread_preflight_forbidden", sourceEventId: "comment_thread_preflight_forbidden", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_preflight_forbidden",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_preflight_forbidden",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });

    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/1",
        method: "GET",
        authorization: "Bearer gh_test",
        hasSignal: true
      }
    ]);
    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("Add the bug label."));
    expect(finalMessage?.body).toContain("<summary>Needs setup</summary>");
    expect(finalMessage?.body).toContain("GitHub apply token cannot access GitHub issue or pull request #1.");
    expect(finalMessage?.body).not.toContain("`apply 1`");
    expect(finalMessage?.body).toContain("`continue 1`");
  });

  it("deduplicates receipt preflight requests for multiple intents on the same target", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: string[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(String(url));
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_preflight_dedupe",
      event: githubIssueEvent({ id: "evt_thread_preflight_dedupe", sourceEventId: "comment_thread_preflight_dedupe", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_preflight_dedupe",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug_dedupe",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            },
            {
              intentId: "intent_label_help_dedupe",
              domain: "labels",
              action: "add_label",
              summary: "Add the help wanted label.",
              params: { label: "help wanted" }
            }
          ]
        }
      ]
    });

    expect(githubRequests).toEqual(["https://api.github.com/repos/acme/demo/issues/1"]);
    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("Add the bug label."));
    expect(finalMessage?.body).toContain("<summary>Ready to apply</summary>");
    expect(finalMessage?.body).toContain("`apply 1`");
    expect(finalMessage?.body).toContain("`apply 2`");
  });

  it("renders needs-setup receipts when GitHub preflight cannot find the target issue or branch", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: string[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(String(url));
          return new Response("not found", { status: 404 });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_preflight_not_found",
      event: {
        ...githubIssueEvent({ id: "evt_thread_preflight_not_found", sourceEventId: "comment_thread_preflight_not_found", threadKey: "acme/demo" }),
        permissions: [
          { scope: "issue:comment", reason: "reply to source thread" },
          { scope: "repo:write", reason: "apply approved issue metadata" },
          { scope: "pr:create", reason: "create an approved pull request" }
        ]
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_preflight_not_found_issue",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the missing issue.",
          intents: [
            {
              intentId: "intent_label_preflight_not_found",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        },
        {
          proposalId: "proposal_thread_preflight_not_found_branch",
          createdAt: "2026-06-24T00:00:01.000Z",
          summary: "Create a pull request.",
          intents: [
            {
              intentId: "intent_pr_preflight_not_found",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create a pull request for branch opentag/missing-branch.",
              params: {
                title: "OpenTag missing branch",
                head: "opentag/missing-branch",
                base: "main",
                executorConditions: ["isolated branch exists"]
              }
            }
          ]
        }
      ]
    });

    expect(githubRequests).toEqual([
      "https://api.github.com/repos/acme/demo/issues/1",
      "https://api.github.com/repos/acme/demo/branches/opentag%2Fmissing-branch",
      "https://api.github.com/repos/acme/demo/branches/main"
    ]);
    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("Add the bug label."));
    expect(finalMessage?.body).toContain("<summary>Needs setup</summary>");
    expect(finalMessage?.body).toContain("GitHub issue or pull request #1 was not found.");
    expect(finalMessage?.body).toContain("GitHub branch opentag/missing-branch was not found.");
    expect(finalMessage?.body).not.toContain("`apply 1`");
  });

  it("renders a stale receipt when applying a superseded source-thread action", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: unknown[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(url);
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_stale_1",
      event: githubIssueEvent({ id: "evt_thread_stale_1", sourceEventId: "comment_thread_stale_1", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_stale_1",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug_stale",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    await seedCompletedProposal({
      app,
      runId: "run_thread_stale_2",
      event: githubIssueEvent({ id: "evt_thread_stale_2", sourceEventId: "comment_thread_stale_2", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_stale_2",
          createdAt: "2026-06-24T00:00:01.000Z",
          summary: "Refine the label.",
          intents: [
            {
              intentId: "intent_label_triaged_current",
              domain: "labels",
              action: "add_label",
              summary: "Add the triaged label.",
              params: { label: "triaged" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      },
      metadata: {
        source: "slack_button",
        proposalId: "proposal_thread_stale_1",
        intentId: "intent_label_bug_stale"
      }
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "stale",
      plan: {
        proposalId: "proposal_thread_stale_1",
        outcomes: [{ intentId: "intent_label_bug_stale", outcome: "stale" }]
      }
    });
    expect(githubRequests).toHaveLength(0);
    expect(delivered.at(-1)?.body).toContain("Stale: Add the bug label.");
    expect(delivered.at(-1)?.body).toContain("The target changed since this action was proposed.");
    expect(delivered.at(-1)?.body).toContain("Reply `continue 1` to refresh");
    expect(delivered.at(-1)?.body).not.toContain("Child run:");
    expect(delivered.at(-1)?.body).not.toContain("proposal_thread_stale_1");
  });

  it("resolves issue-scoped action replies against legacy repo-scoped GitHub issue proposals", async () => {
    const githubRequests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
          });
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_apply_legacy",
      event: githubIssueEvent({
        id: "evt_thread_apply_legacy",
        sourceEventId: "comment_thread_apply_legacy",
        threadKey: "acme/demo"
      }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_apply_legacy",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the legacy bug.",
          intents: [
            {
              intentId: "intent_label_legacy_bug",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      },
      metadata: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        issueNumber: 1
      }
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "applied",
      decision: { proposalId: "proposal_thread_apply_legacy", approvedIntentIds: ["intent_label_legacy_bug"] },
      plan: {
        proposalId: "proposal_thread_apply_legacy",
        outcomes: [{ intentId: "intent_label_legacy_bug", outcome: "applied" }]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/1/labels",
        method: "POST",
        body: { labels: ["bug"] }
      }
    ]);
  });

  it("does not execute the adapter twice for concurrent duplicate apply replies", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: unknown[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(url);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_apply_race",
      event: githubIssueEvent({ id: "evt_thread_apply_race", sourceEventId: "comment_thread_apply_race", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_apply_race",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug_race",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const action = {
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    };
    const responses = await Promise.all([
      app.request("/v1/thread-actions", jsonRequest(action)),
      app.request("/v1/thread-actions", jsonRequest(action))
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(bodies.map((body) => body.outcome).sort()).toEqual(["already_planned", "applied"]);
    expect(githubRequests).toHaveLength(1);
    expect(delivered.some((message) => message.body.includes("Already planned: Add the bug label."))).toBe(true);
    expect(delivered.some((message) => message.body.includes("OpenTag did not execute this repeated reply."))).toBe(true);
  });

  it("rejects unauthorized source-thread action actors before approval or adapter execution", async () => {
    const githubRequests: unknown[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(url);
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_unauthorized",
      event: githubIssueEvent({ id: "evt_thread_unauthorized", sourceEventId: "comment_thread_unauthorized", threadKey: "acme/demo" }),
      allowedActors: ["octocat"],
      suggestedChanges: [
        {
          proposalId: "proposal_thread_unauthorized",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "99", handle: "mallory" },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "unauthorized",
      reason: "actor_not_allowed"
    });
    expect(githubRequests).toHaveLength(0);

    const eventsResponse = await app.request("/v1/runs/run_thread_unauthorized/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).not.toContain("approval.decision.recorded");
    expect(events.map((event: { type: string }) => event.type)).not.toContain("apply_plan.created");
  });

  it("rejects public-repo source-thread action actors without write access by default", async () => {
    const githubRequests: unknown[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(url);
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_public_no_write",
      event: githubIssueEvent({ id: "evt_thread_public_no_write", sourceEventId: "comment_thread_public_no_write", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_public_no_write",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "99", handle: "mallory" },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "unauthorized",
      reason: "actor_not_allowed"
    });
    expect(githubRequests).toHaveLength(0);

    const eventsResponse = await app.request("/v1/runs/run_thread_public_no_write/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).not.toContain("approval.decision.recorded");
    expect(events.map((event: { type: string }) => event.type)).not.toContain("apply_plan.created");
  });

  it("rejects Slack thread actions when the source channel binding is missing", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await seedCompletedProposal({
      app,
      runId: "run_thread_slack_missing_binding",
      event: {
        ...validEvent,
        id: "evt_thread_slack_missing_binding",
        source: "slack",
        sourceEventId: "slack_thread_missing_binding",
        actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
        callback: {
          provider: "slack",
          uri: "https://slack.com/api/chat.postMessage",
          threadKey: "T123|C123|1719187200.000100"
        },
        metadata: { repoProvider: "github", owner: "acme", repo: "demo", teamId: "T123", channelId: "C123" }
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_slack_missing_binding",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Continue the work.",
          intents: [
            {
              intentId: "intent_continue_slack_missing_binding",
              domain: "follow_up",
              action: "continue_run",
              summary: "Continue in a child run.",
              params: {}
            }
          ]
        }
      ]
    });

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "continue 1",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1719187200.000100"
      }
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "unauthorized",
      reason: "channel_binding_mismatch"
    });
  });

  it("does not replay Slack source delivery ids when creating action fallback child runs", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    const parentEvent = slackRepoEvent({
      id: "evt_thread_slack_fallback_delivery",
      sourceEventId: "slack_thread_fallback_delivery",
      threadKey: "T123|C123|1710000000.000100"
    });
    await seedCompletedProposal({
      app,
      runId: "run_thread_slack_fallback_delivery",
      event: {
        ...parentEvent,
        metadata: {
          ...parentEvent.metadata,
          sourceDeliveryId: "EvSlackFallbackDelivery",
          slackEventId: "EvSlackFallbackDelivery"
        }
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_slack_fallback_delivery",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Ask for review.",
          intents: [
            {
              intentId: "intent_slack_fallback_delivery",
              domain: "review",
              action: "request_review",
              summary: "Ask a human to review the result.",
              params: { surface: "slack" }
            }
          ]
        }
      ]
    });
    await app.request("/v1/slack-channel-bindings", jsonRequest({
      teamId: "T123",
      channelId: "C123",
      owner: "acme",
      repo: "demo"
    }));

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100"
      }
    }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "child_run_created",
      run: {
        parentRunId: "run_thread_slack_fallback_delivery",
        sourceProposalId: "proposal_thread_slack_fallback_delivery"
      }
    });
    expect(body.run.id).not.toBe("run_thread_slack_fallback_delivery");
    expect(body.run.sourceApplyPlanId).toBe(body.plan.id);

    const parentEvents = await app.request("/v1/runs/run_thread_slack_fallback_delivery/events");
    const { events } = await parentEvents.json();
    expect(events.map((event: { type: string }) => event.type)).toContain("run.child_created");

    const child = await app.request(`/v1/runs/${body.run.id}`);
    expect(child.status).toBe(200);
    const stored = await child.json();
    expect(stored.event.id).toBe(`evt_${body.run.id}`);
    expect(stored.event.sourceEventId).toContain(body.run.id);
    expect(stored.event.metadata).toMatchObject({
      parentRunId: "run_thread_slack_fallback_delivery",
      sourceProposalId: "proposal_thread_slack_fallback_delivery",
      sourceApplyPlanId: body.plan.id
    });
    expect(stored.event.metadata).not.toHaveProperty("sourceDeliveryId");
    expect(stored.event.metadata).not.toHaveProperty("slackEventId");
  });

  it("does not reuse a provided approval id for a different selected action", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await seedCompletedProposal({
      app,
      runId: "run_thread_approval_id_conflict",
      event: githubIssueEvent({ id: "evt_thread_approval_id_conflict", sourceEventId: "comment_thread_approval_id_conflict", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_approval_id_conflict",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the issue.",
          intents: [
            {
              intentId: "intent_label_bug_conflict",
              domain: "labels",
              action: "add_label",
              summary: "Add bug label.",
              params: { label: "bug" }
            },
            {
              intentId: "intent_label_help_conflict",
              domain: "labels",
              action: "add_label",
              summary: "Add help wanted label.",
              params: { label: "help wanted" }
            }
          ]
        }
      ]
    });

    const first = await app.request("/v1/thread-actions", jsonRequest({
      id: "approval_ingress_retry_id",
      rawText: "approve 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({
      decision: { id: "approval_ingress_retry_id", approvedIntentIds: ["intent_label_bug_conflict"] }
    });

    const second = await app.request("/v1/thread-actions", jsonRequest({
      id: "approval_ingress_retry_id",
      rawText: "approve 2",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(second.status).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.decision).toMatchObject({ approvedIntentIds: ["intent_label_help_conflict"] });
    expect(secondBody.decision.id).not.toBe("approval_ingress_retry_id");
  });

  it("records approve-only and reject replies with compact source-thread receipts", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      }
    });
    await seedCompletedProposal({
      app,
      runId: "run_thread_record_receipts",
      event: githubIssueEvent({ id: "evt_thread_record_receipts", sourceEventId: "comment_thread_record_receipts", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_record_receipts",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the issue.",
          intents: [
            {
              intentId: "intent_label_bug_receipt",
              domain: "labels",
              action: "add_label",
              summary: "Add bug label.",
              params: { label: "bug" }
            },
            {
              intentId: "intent_label_help_receipt",
              domain: "labels",
              action: "add_label",
              summary: "Add help wanted label.",
              params: { label: "help wanted" }
            }
          ]
        }
      ]
    });

    const baseAction = {
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    };
    const approve = await app.request("/v1/thread-actions", jsonRequest({ ...baseAction, rawText: "approve 1" }));
    const reject = await app.request("/v1/thread-actions", jsonRequest({ ...baseAction, rawText: "reject 2" }));

    expect(approve.status).toBe(201);
    expect(reject.status).toBe(201);
    expect(delivered.some((message) => message.body.includes("Approved only: Add bug label."))).toBe(true);
    expect(delivered.some((message) => message.body.includes("No external write was performed."))).toBe(true);
    expect(delivered.some((message) => message.body.includes("Direct apply is not available yet: GitHub apply is not configured on this dispatcher."))).toBe(true);
    expect(delivered.some((message) => message.body.includes("Next: reply `continue 1`"))).toBe(true);
    expect(delivered.some((message) => message.body.includes("Next: reply `apply 1`"))).toBe(false);
    expect(delivered.some((message) => message.body.includes("Rejected: Add help wanted label."))).toBe(true);
    expect(delivered.some((message) => message.body.includes("No external write will be performed for this action."))).toBe(true);
    expect(delivered.some((message) => message.body.includes("proposal_thread_record_receipts"))).toBe(false);
    expect(delivered.some((message) => message.body.includes("intent_label_bug_receipt"))).toBe(false);
  });

  it("keeps the approve-only apply hint only when direct apply preflight is ready", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const githubRequests: Array<{ url: string; method?: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({ url: String(url), method: init?.method });
          return Response.json({});
        }
      }
    });
    await seedCompletedProposal({
      app,
      runId: "run_thread_approve_ready",
      event: githubIssueEvent({ id: "evt_thread_approve_ready", sourceEventId: "comment_thread_approve_ready", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_approve_ready",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the issue.",
          intents: [
            {
              intentId: "intent_label_bug_approve_ready",
              domain: "labels",
              action: "add_label",
              summary: "Add bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "approve 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));

    expect(response.status).toBe(201);
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/1",
        method: "GET"
      }
    ]);
    expect(delivered.at(-1)?.body).toContain("Approved only: Add bug label.");
    expect(delivered.at(-1)?.body).toContain("No external write was performed.");
    expect(delivered.at(-1)?.body).toContain("Next: reply `apply 1` to write it to the system of record");
    expect(delivered.at(-1)?.body).not.toContain("Direct apply is not available yet");
  });

  it("rejects explicit proposal action replies from the wrong source thread", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    await seedCompletedProposal({
      app,
      runId: "run_thread_cross",
      event: githubIssueEvent({ id: "evt_thread_cross", sourceEventId: "comment_thread_cross", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_cross",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Label the bug.",
          intents: [
            {
              intentId: "intent_label_bug",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ]
    });

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply proposal_thread_cross",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/99/comments",
        threadKey: "acme/demo#wrong"
      }
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "no_match"
    });
  });

  it("applies a model-suggested GitHub PR review request from a source-thread reply", async () => {
    const githubRequests: Array<{ url: string; method?: string; body?: unknown; authorization?: string | null }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            authorization: new Headers(init?.headers).get("authorization")
          });
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_review",
      event: githubPullRequestEvent({ id: "evt_thread_review", sourceEventId: "comment_thread_review", threadKey: "acme/demo#2" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_review",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Request PR review.",
          intents: [
            {
              intentId: "intent_review_alice",
              domain: "review",
              action: "request_review",
              summary: "Request Alice's review.",
              params: { reviewer: "alice" }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/2/comments",
        threadKey: "acme/demo#2"
      }
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "applied",
      plan: {
        proposalId: "proposal_thread_review",
        outcomes: [
          {
            intentId: "intent_review_alice",
            outcome: "applied",
            externalUri: "https://github.com/acme/demo/pull/2"
          }
        ]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/pulls/2/requested_reviewers",
        method: "GET",
        authorization: "Bearer gh_test"
      },
      {
        url: "https://api.github.com/repos/acme/demo/pulls/2/requested_reviewers",
        method: "POST",
        body: { reviewers: ["alice"] },
        authorization: "Bearer gh_test"
      }
    ]);
  });

  it("applies a model-suggested create PR action from a source-thread reply", async () => {
    const githubRequests: Array<{ url: string; method?: string; body?: unknown; authorization?: string | null }> = [];
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            authorization: new Headers(init?.headers).get("authorization")
          });
          return Response.json({ html_url: "https://github.com/acme/demo/pull/42" });
        }
      }
    });

    const event = githubIssueEvent({ id: "evt_thread_create_pr", sourceEventId: "comment_thread_create_pr", threadKey: "acme/demo#1" });
    await seedCompletedProposal({
      app,
      runId: "run_thread_create_pr",
      event: {
        ...event,
        permissions: [...event.permissions, { scope: "pr:create", reason: "create an approved pull request" }]
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_create_pr",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Create a pull request for the generated branch.",
          intents: [
            {
              intentId: "intent_create_pr",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create PR for branch opentag/run_thread_create_pr.",
              params: {
                title: "OpenTag run run_thread_create_pr",
                body: "PR body",
                head: "opentag/run_thread_create_pr",
                base: "main",
                changedFiles: ["src/demo.ts"],
                verification: [{ command: "pnpm test", outcome: "passed" }],
                risks: ["Review before merge."],
                executorConditions: ["isolated branch exists"]
              }
            }
          ]
        }
      ]
    });
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      }
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "applied",
      plan: {
        proposalId: "proposal_thread_create_pr",
        outcomes: [
          {
            intentId: "intent_create_pr",
            outcome: "applied",
            externalUri: "https://github.com/acme/demo/pull/42"
          }
        ]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/pulls",
        method: "POST",
        authorization: "Bearer gh_test",
        body: {
          title: "OpenTag run run_thread_create_pr",
          body: [
            "PR body",
            "",
            "## Changed Files",
            "- `src/demo.ts`",
            "",
            "## Risks",
            "- Review before merge.",
            "",
            "## Verification",
            "- `pnpm test`: passed",
            "",
            "## Executor Conditions",
            "- isolated branch exists"
          ].join("\n"),
          head: "opentag/run_thread_create_pr",
          base: "main"
        }
      }
    ]);
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("https://github.com/acme/demo/pull/42"))).toBe(true);
  });

  it("falls back with a quiet receipt when GitHub PR creation fails", async () => {
    const githubRequests: Array<{ url: string; method?: string; body?: unknown; authorization?: string | null }> = [];
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            authorization: new Headers(init?.headers).get("authorization")
          });
          if (init?.method === "POST") {
            return new Response("Validation Failed: pull request already exists for this head; token ghp_aaaaaaaaaaaaaaaaaaaa; path /home/alice/repos/demo", {
              status: 422
            });
          }
          return Response.json({ name: String(url).split("/").at(-1) });
        }
      }
    });

    const event = githubIssueEvent({ id: "evt_thread_create_pr_failed", sourceEventId: "comment_thread_create_pr_failed", threadKey: "acme/demo#1" });
    await seedCompletedProposal({
      app,
      runId: "run_thread_create_pr_failed",
      event: {
        ...event,
        permissions: [...event.permissions, { scope: "pr:create", reason: "create an approved pull request" }]
      },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_create_pr_failed",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Create a pull request for the generated branch.",
          intents: [
            {
              intentId: "intent_create_pr_failed",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create PR for branch opentag/run_thread_create_pr_failed.",
              params: {
                title: "OpenTag run run_thread_create_pr_failed",
                body: "PR body",
                head: "opentag/run_thread_create_pr_failed",
                base: "main",
                changedFiles: ["src/demo.ts"],
                executorConditions: ["isolated branch exists"]
              }
            }
          ]
        }
      ]
    });
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("Ready to apply"))).toBe(true);
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      }
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "child_run_created",
      plan: {
        proposalId: "proposal_thread_create_pr_failed",
        outcomes: [
          {
            intentId: "intent_create_pr_failed",
            outcome: "failed",
            error: "create pull request failed: 422 Validation Failed: pull request already exists for this head; token [redacted]; path [redacted local path]"
          }
        ]
      },
      run: {
        parentRunId: "run_thread_create_pr_failed",
        sourceProposalId: "proposal_thread_create_pr_failed"
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/pulls",
        method: "POST",
        authorization: "Bearer gh_test",
        body: {
          title: "OpenTag run run_thread_create_pr_failed",
          body: ["PR body", "", "## Changed Files", "- `src/demo.ts`", "", "## Executor Conditions", "- isolated branch exists"].join("\n"),
          head: "opentag/run_thread_create_pr_failed",
          base: "main"
        }
      }
    ]);
    const finalMessage = delivered.at(-1)?.body ?? "";
    expect(finalMessage).toContain("Needs setup before OpenTag can apply this action directly.");
    expect(finalMessage).toContain("Child run:");
    expect(finalMessage).toContain("Reason: Direct apply failed: create pull request failed: 422 Validation Failed: pull request already exists for this head");
    expect(finalMessage).toContain("token [redacted]");
    expect(finalMessage).toContain("path [redacted local path]");
    expect(finalMessage).not.toContain("proposal_thread_create_pr_failed");
    expect(finalMessage).not.toContain("intent_create_pr_failed");
    expect(finalMessage).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaa");
    expect(finalMessage).not.toContain("/home/alice/repos/demo");
    expect(finalMessage).not.toContain("gh_test");
    expect(finalMessage).not.toContain("authorization");
  });

  it("applies a model-suggested create PR action from a GitLab source-thread reply as an MR", async () => {
    const gitlabRequests: Array<{ url: string; method?: string; body?: unknown; token?: string | null }> = [];
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      gitlabApply: {
        token: "glpat_test",
        baseUrl: "https://gitlab.example.com",
        fetchImpl: async (url, init) => {
          gitlabRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            token: new Headers(init?.headers).get("PRIVATE-TOKEN")
          });
          if (init?.method === "GET") {
            return Response.json({ name: String(url).split("/").at(-1) });
          }
          return Response.json({ web_url: "https://gitlab.example.com/acme/demo/-/merge_requests/42" });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_create_mr",
      event: gitlabIssueEvent({ id: "evt_thread_create_mr", sourceEventId: "note_thread_create_mr", threadKey: "acme/demo|issue|1" }),
      repoBinding: { provider: "gitlab", owner: "acme", repo: "demo" },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_create_mr",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Create a merge request for the generated branch.",
          intents: [
            {
              intentId: "intent_create_mr",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create MR for branch opentag/run_thread_create_mr.",
              params: {
                title: "OpenTag run run_thread_create_mr",
                body: "MR body",
                head: "opentag/run_thread_create_mr",
                base: "main",
                changedFiles: ["src/demo.ts"],
                verification: [{ command: "pnpm test", outcome: "passed" }],
                risks: ["Review before merge."],
                executorConditions: ["isolated branch exists"]
              }
            }
          ]
        }
      ]
    });
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("### Ready to apply"))).toBe(true);
    gitlabRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "gitlab", providerUserId: "7", handle: "alice" },
      callback: {
        provider: "gitlab",
        uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
        threadKey: "acme/demo|issue|1"
      }
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "applied",
      plan: {
        adapter: "gitlab",
        proposalId: "proposal_thread_create_mr",
        outcomes: [
          {
            intentId: "intent_create_mr",
            outcome: "applied",
            externalUri: "https://gitlab.example.com/acme/demo/-/merge_requests/42"
          }
        ]
      }
    });
    expect(gitlabRequests).toEqual([
      {
        url: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/merge_requests",
        method: "POST",
        token: "glpat_test",
        body: {
          title: "OpenTag run run_thread_create_mr",
          description: [
            "MR body",
            "",
            "## Changed Files",
            "- `src/demo.ts`",
            "",
            "## Risks",
            "- Review before merge.",
            "",
            "## Verification",
            "- `pnpm test`: passed",
            "",
            "## Executor Conditions",
            "- isolated branch exists"
          ].join("\n"),
          source_branch: "opentag/run_thread_create_mr",
          target_branch: "main"
        }
      }
    ]);
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("https://gitlab.example.com/acme/demo/-/merge_requests/42"))).toBe(true);
  });

  it("falls back with a quiet receipt when GitLab MR creation fails", async () => {
    const gitlabRequests: Array<{ url: string; method?: string; body?: unknown; token?: string | null }> = [];
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      gitlabApply: {
        token: "glpat_test",
        baseUrl: "https://gitlab.example.com",
        fetchImpl: async (url, init) => {
          gitlabRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            token: new Headers(init?.headers).get("PRIVATE-TOKEN")
          });
          if (init?.method === "POST") {
            return new Response("A merge request already exists for this source branch; token glpat-aaaaaaaaaaaaaaaaaaaa; path C:\\Users\\alice\\repo", {
              status: 409
            });
          }
          return Response.json({ name: String(url).split("/").at(-1) });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_create_mr_failed",
      event: gitlabIssueEvent({ id: "evt_thread_create_mr_failed", sourceEventId: "note_thread_create_mr_failed", threadKey: "acme/demo|issue|1" }),
      repoBinding: { provider: "gitlab", owner: "acme", repo: "demo" },
      suggestedChanges: [
        {
          proposalId: "proposal_thread_create_mr_failed",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Create a merge request for the generated branch.",
          intents: [
            {
              intentId: "intent_create_mr_failed",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create MR for branch opentag/run_thread_create_mr_failed.",
              params: {
                title: "OpenTag run run_thread_create_mr_failed",
                body: "MR body",
                head: "opentag/run_thread_create_mr_failed",
                base: "main",
                changedFiles: ["src/demo.ts"],
                executorConditions: ["isolated branch exists"]
              }
            }
          ]
        }
      ]
    });
    expect(delivered.some((message) => message.kind === "final" && message.body.includes("Ready to apply"))).toBe(true);
    gitlabRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "gitlab", providerUserId: "7", handle: "alice" },
      callback: {
        provider: "gitlab",
        uri: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
        threadKey: "acme/demo|issue|1"
      }
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "child_run_created",
      plan: {
        adapter: "gitlab",
        proposalId: "proposal_thread_create_mr_failed",
        outcomes: [
          {
            intentId: "intent_create_mr_failed",
            outcome: "failed",
            error: "create merge request failed: 409 A merge request already exists for this source branch; token [redacted]; path [redacted local path]"
          }
        ]
      },
      run: {
        parentRunId: "run_thread_create_mr_failed",
        sourceProposalId: "proposal_thread_create_mr_failed"
      }
    });
    expect(gitlabRequests).toEqual([
      {
        url: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/merge_requests",
        method: "POST",
        token: "glpat_test",
        body: {
          title: "OpenTag run run_thread_create_mr_failed",
          description: ["MR body", "", "## Changed Files", "- `src/demo.ts`", "", "## Executor Conditions", "- isolated branch exists"].join("\n"),
          source_branch: "opentag/run_thread_create_mr_failed",
          target_branch: "main"
        }
      }
    ]);
    const finalMessage = delivered.at(-1)?.body ?? "";
    expect(finalMessage).toContain("Needs setup before OpenTag can apply this action directly.");
    expect(finalMessage).toContain("Child run:");
    expect(finalMessage).toContain("Reason: Direct apply failed: create merge request failed: 409 A merge request already exists for this source branch");
    expect(finalMessage).toContain("token [redacted]");
    expect(finalMessage).toContain("path [redacted local path]");
    expect(finalMessage).not.toContain("proposal_thread_create_mr_failed");
    expect(finalMessage).not.toContain("intent_create_mr_failed");
    expect(finalMessage).not.toContain("glpat-aaaaaaaaaaaaaaaaaaaa");
    expect(finalMessage).not.toContain("C:\\Users\\alice\\repo");
    expect(finalMessage).not.toContain("glpat_test");
    expect(finalMessage).not.toContain("PRIVATE-TOKEN");
  });

  it("routes repo-level create_pull_request actions from Slack threads to the GitHub adapter", async () => {
    const githubRequests: Array<{ url: string; method?: string; body?: unknown; authorization?: string | null }> = [];
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url, init) => {
          githubRequests.push({
            url: String(url),
            method: init?.method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            authorization: new Headers(init?.headers).get("authorization")
          });
          return Response.json({ html_url: "https://github.com/acme/demo/pull/43" });
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_slack_create_pr",
      event: slackRepoEvent({ id: "evt_slack_create_pr", sourceEventId: "slack_thread_create_pr", threadKey: "T123|C123|1710000000.000100" }),
      suggestedChanges: [
        {
          proposalId: "proposal_slack_create_pr",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Create a pull request for the generated branch.",
          intents: [
            {
              intentId: "intent_slack_create_pr",
              domain: "pull_request",
              action: "create_pull_request",
              summary: "Create PR for branch opentag/run_slack_create_pr.",
              params: {
                title: "OpenTag run run_slack_create_pr",
                body: "PR body",
                head: "opentag/run_slack_create_pr",
                base: "main",
                changedFiles: ["README.md"],
                executorConditions: ["isolated branch exists"]
              }
            }
          ]
        }
      ]
    });
    const bindingResponse = await app.request("/v1/slack-channel-bindings", jsonRequest({
      teamId: "T123",
      channelId: "C123",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    }));
    expect(bindingResponse.status).toBe(201);
    githubRequests.length = 0;

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100"
      }
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "applied",
      plan: {
        adapter: "github",
        proposalId: "proposal_slack_create_pr",
        outcomes: [
          {
            intentId: "intent_slack_create_pr",
            outcome: "applied",
            externalUri: "https://github.com/acme/demo/pull/43"
          }
        ]
      }
    });
    expect(githubRequests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/pulls",
        method: "POST",
        authorization: "Bearer gh_test",
        body: {
          title: "OpenTag run run_slack_create_pr",
          body: ["PR body", "", "## Changed Files", "- `README.md`", "", "## Executor Conditions", "- isolated branch exists"].join("\n"),
          head: "opentag/run_slack_create_pr",
          base: "main"
        }
      }
    ]);
    const finalMessage = delivered.find((message) => message.kind === "final" && message.body.includes("https://github.com/acme/demo/pull/43"));
    expect(finalMessage?.body).toContain("Applied: Create PR for branch opentag/run_slack_create_pr.");
    expect(finalMessage?.body).not.toContain("..");
    expect(finalMessage?.body).not.toContain("proposal_slack_create_pr");
    expect(finalMessage?.body).not.toContain("intent_slack_create_pr");
  });

  it("falls back to a child run when a PR review request lacks reviewer params", async () => {
    const githubRequests: unknown[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      githubApply: {
        token: "gh_test",
        fetchImpl: async (url) => {
          githubRequests.push(url);
          return Response.json({});
        }
      }
    });

    await seedCompletedProposal({
      app,
      runId: "run_thread_review_missing_reviewer",
      event: githubPullRequestEvent({
        id: "evt_thread_review_missing_reviewer",
        sourceEventId: "comment_thread_review_missing_reviewer",
        threadKey: "acme/demo#2"
      }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_review_missing_reviewer",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Request PR review.",
          intents: [
            {
              intentId: "intent_review_missing_reviewer",
              domain: "review",
              action: "request_review",
              summary: "Request review.",
              params: {}
            }
          ]
        }
      ]
    });

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/2/comments",
        threadKey: "acme/demo#2"
      }
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "child_run_created",
      plan: {
        proposalId: "proposal_thread_review_missing_reviewer",
        outcomes: [{ intentId: "intent_review_missing_reviewer", outcome: "failed" }]
      },
      run: {
        parentRunId: "run_thread_review_missing_reviewer",
        sourceProposalId: "proposal_thread_review_missing_reviewer"
      }
    });
    expect(githubRequests).toHaveLength(0);
  });

  it("creates a child run with proposal context when the user replies continue", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      }
    });
    await seedCompletedProposal({
      app,
      runId: "run_thread_continue",
      event: githubIssueEvent({ id: "evt_thread_continue", sourceEventId: "comment_thread_continue", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_continue",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Continue the investigation.",
          intents: [
            {
              intentId: "intent_continue_tests",
              domain: "follow_up",
              action: "continue_run",
              summary: "Continue fixing the failing test.",
              params: { focus: "failing test" }
            }
          ]
        }
      ]
    });

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "continue 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "child_run_created",
      run: {
        parentRunId: "run_thread_continue",
        sourceProposalId: "proposal_thread_continue"
      }
    });

    const runResponse = await app.request(`/v1/runs/${body.run.id}`);
    expect(runResponse.status).toBe(200);
    const stored = await runResponse.json();
    expect(stored.event.command.rawText).toContain("Continue approved OpenTag action");
    expect(stored.event.metadata).toMatchObject({
      parentRunId: "run_thread_continue",
      sourceProposalId: "proposal_thread_continue",
      threadActionVerb: "continue",
      approvalDecisionId: body.decision.id,
      selectedIntentIds: ["intent_continue_tests"],
      previousRunSummary: "Prepared suggested actions."
    });
    expect(stored.event.context.some((pointer: { uri?: string }) => pointer.uri?.includes("OpenTag thread action continuation."))).toBe(true);
    expect(stored.run.contextPacket.facts.map((fact: { text: string }) => fact.text)).toEqual(
      expect.arrayContaining([
        "Action loop thread action: continue",
        "Action loop parent run: run_thread_continue",
        "Action loop proposal: proposal_thread_continue",
        `Action loop approval decision: ${body.decision.id}`,
        "Action loop selected intents: intent_continue_tests",
        "Action loop previous result: Prepared suggested actions."
      ])
    );
    expect(
      delivered.some(
        (message) =>
          message.body.includes("Continuing in OpenTag from this approved action.") &&
          message.body.includes("Action: Continue fixing the failing test.") &&
          message.body.includes(`Child run: \`${body.run.id}\``) &&
          message.body.includes(`Audit: run \`opentag status --run ${body.run.id}\` locally.`) &&
          !message.body.includes("proposal_thread_continue") &&
          !message.body.includes(body.decision.id)
      )
    ).toBe(true);
  });

  it("falls back to a child run when an approved action has no direct adapter operation", async () => {
    const delivered: Array<{ kind: string; body: string }> = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      },
      githubApply: {
        token: "gh_test",
        fetchImpl: async () => {
          throw new Error("unsupported actions should not call GitHub");
        }
      }
    });
    await seedCompletedProposal({
      app,
      runId: "run_thread_fallback",
      event: githubIssueEvent({ id: "evt_thread_fallback", sourceEventId: "comment_thread_fallback", threadKey: "acme/demo" }),
      suggestedChanges: [
        {
          proposalId: "proposal_thread_fallback",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Ask for review.",
          intents: [
            {
              intentId: "intent_request_review",
              domain: "review",
              action: "request_review",
              summary: "Request a reviewer.",
              params: { reviewer: "maintainer" }
            }
          ]
        }
      ]
    });

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo"
      }
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "child_run_created",
      plan: {
        proposalId: "proposal_thread_fallback",
        outcomes: [{ intentId: "intent_request_review", outcome: "unsupported" }]
      },
      run: {
        parentRunId: "run_thread_fallback",
        sourceProposalId: "proposal_thread_fallback"
      }
    });
    expect(body.run.sourceApplyPlanId).toBe(body.plan.id);
    const runResponse = await app.request(`/v1/runs/${body.run.id}`);
    expect(runResponse.status).toBe(200);
    const stored = await runResponse.json();
    expect(stored.event.metadata).toMatchObject({
      parentRunId: "run_thread_fallback",
      sourceProposalId: "proposal_thread_fallback",
      approvalDecisionId: body.decision.id,
      sourceApplyPlanId: body.plan.id,
      selectedIntentIds: ["intent_request_review"],
      threadActionVerb: "apply",
      previousRunSummary: "Prepared suggested actions."
    });
    expect(stored.event.metadata.fallbackReason).toContain("No selected intent has a direct adapter execution path.");
    expect(stored.event.permissions.map((permission: { scope: string }) => permission.scope)).toEqual(
      expect.arrayContaining(["repo:read", "repo:write"])
    );
    expect(stored.run.contextPacket.facts.map((fact: { text: string }) => fact.text)).toEqual(
      expect.arrayContaining([
        "Action loop thread action: apply",
        "Action loop parent run: run_thread_fallback",
        "Action loop proposal: proposal_thread_fallback",
        `Action loop approval decision: ${body.decision.id}`,
        `Action loop apply plan: ${body.plan.id}`,
        "Action loop selected intents: intent_request_review",
        "Action loop previous result: Prepared suggested actions.",
        "Action loop fallback reason: No selected intent has a direct adapter execution path."
      ])
    );
    expect(
      delivered.some(
        (message) =>
          message.kind === "final" &&
          message.body.includes("Needs setup before OpenTag can apply this action directly.") &&
          message.body.includes("Action: Request a reviewer.") &&
          message.body.includes(`Child run: \`${body.run.id}\``) &&
          message.body.includes("Reason:") &&
          message.body.includes(`Audit: run \`opentag status --run ${body.run.id}\` locally.`) &&
          !message.body.includes(`Approval decision: \`${body.decision.id}\``)
      )
    ).toBe(true);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const response = await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not valid json"
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("invalid_json_body");
    const audit = await app.request("/v1/control-plane-events?type=security.request_body_rejected");
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        type: "security.request_body_rejected",
        severity: "warn",
        subject: "POST /v1/runners",
        payload: expect.objectContaining({
          reason: "invalid_json_body",
          error: "invalid_json_body",
          endpoint: "POST /v1/runners"
        })
      })
    ]);
  });

  it("returns 400 for a body that fails schema validation", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const response = await app.request("/v1/runners", jsonRequest({ nope: true }));

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("invalid_request_body");
    const audit = await app.request("/v1/control-plane-events?type=security.request_body_rejected");
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        type: "security.request_body_rejected",
        severity: "warn",
        subject: "POST /v1/runners",
        payload: expect.objectContaining({
          reason: "invalid_request_body",
          error: "invalid_request_body",
          endpoint: "POST /v1/runners"
        })
      })
    ]);
  });

  it("returns 413 before validation when a request body is too large", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", maxRequestBodyBytes: 24 });

    const response = await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Local Runner" }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "request_body_too_large", maxBytes: 24 });
    const audit = await app.request("/v1/control-plane-events?type=security.request_body_rejected");
    const { events } = await audit.json();
    expect(events).toEqual([
      expect.objectContaining({
        type: "security.request_body_rejected",
        severity: "warn",
        subject: "POST /v1/runners",
        payload: expect.objectContaining({
          reason: "request_body_too_large",
          endpoint: "POST /v1/runners",
          maxBytes: 24
        })
      })
    ]);
  });

  it("applies the request body size limit to approval endpoints", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", maxRequestBodyBytes: 24 });

    const response = await app.request("/v1/proposals/proposal_1/approvals", jsonRequest({
      approvedIntentIds: ["intent_1"],
      approvedBy: "octocat",
      reason: "This reason intentionally exceeds the tiny test request body limit."
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "request_body_too_large", maxBytes: 24 });
  });

  it("does not mask an internal ZodError as a 400 (yields 500)", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    // Simulate a non-request-body ZodError, e.g. a store repository validating a
    // DB row. It must surface as 500 so monitoring alerts on it, not 400.
    app.get("/__test/internal-zod", () => {
      z.object({ value: z.string() }).parse({ value: 123 });
      return new Response("unreachable");
    });

    const response = await app.request("/__test/internal-zod");

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("invalid_request_body");
  });

  it("does not mask an internal SyntaxError as a 400 (yields 500)", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });
    // Simulate a non-request-body SyntaxError, e.g. JSON.parse of a corrupt DB
    // column or an external API response. It must surface as 500, not 400.
    app.get("/__test/internal-syntax", () => {
      JSON.parse("{ not valid json");
      return new Response("unreachable");
    });

    const response = await app.request("/__test/internal-syntax");

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("invalid_json_body");
  });
});
