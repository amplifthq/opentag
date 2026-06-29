import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDispatcherApp } from "../src/server.js";

const validEvent = {
  id: "evt_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42", handle: "octocat" },
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

async function seedCompletedProposal(input: {
  app: ReturnType<typeof createDispatcherApp>;
  runId: string;
  event: unknown;
  suggestedChanges: unknown[];
  allowedActors?: string[];
}) {
  await input.app.request("/v1/repo-bindings", jsonRequest({
    provider: "github",
    owner: "acme",
    repo: "demo",
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

  it("delivers acknowledgement, progress, and final callback messages with audit events", async () => {
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
      body: JSON.stringify({ type: "executor.progress", message: "running tests", at: "2026-06-24T00:00:01.000Z" })
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
      visibility: "audit",
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
        body: "*Finished: success.*\nEchoed OpenTag command: introduce yourself\nVerified: `echo` passed",
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

  it("delivers Slack source receipts without posting text acknowledgements", async () => {
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
      }
    ]);

    const eventsResponse = await app.request("/v1/runs/run_slack_receipt/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
      "source_receipt.delivered",
      "admission.decided",
      "run.create_idempotent_replay"
    ]);
    expect(events.find((event: { type: string }) => event.type === "source_receipt.delivered")).toMatchObject({
      visibility: "audit",
      importance: "low",
      payload: {
        provider: "slack",
        state: "received"
      }
    });
  });

  it("renders Lark final callbacks as plain text while keeping acknowledgement and progress audit-only", async () => {
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
    const progressResponse = await app.request("/v1/runners/runner_1/runs/run_lark_1/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "executor.progress", message: "Echo executor started", at: "2026-06-24T00:00:01.000Z" })
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
        kind: "final",
        body: "Finished with success.\n\nEchoed OpenTag command: introduce yourself\n\nVerification\n- echo: passed"
      }
    ]);

    const eventsResponse = await app.request("/v1/runs/run_lark_1/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "admission.decided",
      "run.created",
      "context_packet.generated",
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
    const app = createDispatcherApp({
      databasePath: ":memory:",
      presentation: {
        shouldDeliverAcknowledgement() {
          return true;
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
      body: JSON.stringify({ type: "executor.progress", message: "working", at: "2026-06-24T00:00:01.000Z" })
    });
    expect(progressResponse.status).toBe(200);

    expect(delivered).toEqual([
      { kind: "acknowledgement" },
      { kind: "progress", statusMessageKey: "run_status_key:status" }
    ]);
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

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
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
    expect(delivered.some((message) => message.body.includes("Suggested actions:"))).toBe(true);
    expect(delivered.at(-1)?.body).toContain("Applied 1. Add the bug label.");

    const deliveredCountAfterFirstApply = delivered.length;
    const replayResponse = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
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
    expect(delivered).toHaveLength(deliveredCountAfterFirstApply);
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

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
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
    const githubRequests: unknown[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
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

    const action = {
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
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
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
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
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
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
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
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

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
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

    const response = await app.request("/v1/thread-actions", jsonRequest({
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
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
    expect(finalMessage?.body).toContain("Applied 1. Create PR for branch opentag/run_slack_create_pr.");
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
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
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
    const app = createDispatcherApp({ databasePath: ":memory:" });
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
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
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
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
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
          message.body.includes("Context carried into the child run:") &&
          message.body.includes(`Child run: \`${body.run.id}\``) &&
          message.body.includes(`Approval decision: \`${body.decision.id}\``) &&
          message.body.includes("Fallback reason:")
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
  });

  it("returns 400 for a body that fails schema validation", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const response = await app.request("/v1/runners", jsonRequest({ nope: true }));

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("invalid_request_body");
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
