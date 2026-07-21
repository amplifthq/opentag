import { describe, expect, it } from "vitest";
import { createDispatcherApp, type CallbackMessage, type GitHubCompletionPolicy } from "../src/index.js";

const strictPolicy: GitHubCompletionPolicy = {
  provider: "github",
  owner: "acme",
  repo: "demo",
  requiredChecks: ["build", "test"]
};

function githubIssueEvent(input: { id: string; sourceEventId: string }) {
  return {
    id: input.id,
    source: "github",
    sourceEventId: input.sourceEventId,
    receivedAt: "2026-07-21T00:00:00.000Z",
    actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: "fix this", intent: "fix", args: {} },
    context: [{
      provider: "github",
      kind: "issue",
      uri: "https://github.com/acme/demo/issues/1",
      visibility: "public"
    }],
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
    metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 1 }
  };
}

function jsonRequest(body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

async function startRun(input: {
  runId: string;
  completionPolicies?: GitHubCompletionPolicy[];
}) {
  const delivered: CallbackMessage[] = [];
  const app = createDispatcherApp({
    databasePath: ":memory:",
    ...(input.completionPolicies ? { completionPolicies: input.completionPolicies } : {}),
    callbackSink: {
      async deliver(message) {
        delivered.push(message);
      }
    }
  });
  expect((await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Local Runner" }))).status).toBe(201);
  expect((await app.request("/v1/repo-bindings", jsonRequest({
    provider: "github",
    owner: "acme",
    repo: "demo",
    runnerId: "runner_1",
    workspacePath: "/Users/test/demo",
    defaultExecutor: "echo"
  }))).status).toBe(201);
  expect((await app.request("/v1/runs", jsonRequest({
    runId: input.runId,
    event: githubIssueEvent({ id: `event_${input.runId}`, sourceEventId: `comment_${input.runId}` })
  }))).status).toBe(201);
  const claimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
  expect(claimResponse.status).toBe(200);
  const claim = await claimResponse.json() as { attemptId: string; fencingToken: string };
  return { app, claim, delivered };
}

async function completeRun(input: {
  setup: Awaited<ReturnType<typeof startRun>>;
  runId: string;
  conclusion: "success" | "failure" | "cancelled" | "timed_out";
  idempotencyKey?: string;
}) {
  return input.setup.app.request(`/v1/runners/runner_1/runs/${input.runId}/complete`, jsonRequest({
    ...input.setup.claim,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    result: {
      conclusion: input.conclusion,
      summary: `${input.conclusion} result`,
      ...(input.conclusion === "success"
        ? { createdPullRequestUrl: "https://github.com/acme/demo/pull/7" }
        : {})
    }
  }));
}

describe("dispatcher completion governance", () => {
  it("rejects an unsafe strict policy without required checks", () => {
    expect(() => createDispatcherApp({
      databasePath: ":memory:",
      completionPolicies: [{ ...strictPolicy, requiredChecks: [] }]
    })).toThrow("must configure at least one required check");
  });

  it("keeps strict work pending after executor success until repository evidence arrives", async () => {
    const setup = await startRun({ runId: "run_strict", completionPolicies: [strictPolicy] });
    const response = await completeRun({ setup, runId: "run_strict", conclusion: "success" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      completion: {
        execution: "succeeded",
        completion: "pending",
        evidenceBacked: true,
        contract: { mode: "governed", cycle: 1, version: 1 },
        missingGateIds: ["required_checks", "merge"],
        currentAssessment: {
          gateResults: [
            { gateId: "pull_request", state: "passed" },
            { gateId: "required_checks", state: "missing" },
            { gateId: "merge", state: "missing" }
          ]
        }
      }
    });
    expect(setup.delivered.at(-1)).toMatchObject({ kind: "final" });
    expect(setup.delivered.at(-1)?.body).toContain("Execution succeeded");
    expect(setup.delivered.at(-1)?.body).toContain("verified repository evidence");
  });

  it("preserves executor-success semantics for repositories without a strict policy", async () => {
    const setup = await startRun({ runId: "run_compat" });
    const response = await completeRun({ setup, runId: "run_compat", conclusion: "success" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      completion: {
        execution: "succeeded",
        completion: "satisfied",
        evidenceBacked: false,
        contract: { mode: "execution_compat" }
      }
    });
    expect(setup.delivered.at(-1)?.body).toContain("success result");
  });

  it("returns the current assessment without duplicating side effects on completion replay", async () => {
    const setup = await startRun({ runId: "run_replay", completionPolicies: [strictPolicy] });
    const first = await completeRun({
      setup,
      runId: "run_replay",
      conclusion: "success",
      idempotencyKey: "completion-replay-key"
    });
    const firstBody = await first.json() as { completion: { currentAssessment: { id: string } } };
    const deliveredAfterFirst = setup.delivered.length;

    const replay = await completeRun({
      setup,
      runId: "run_replay",
      conclusion: "success",
      idempotencyKey: "completion-replay-key"
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      replayed: true,
      completion: { currentAssessment: { id: firstBody.completion.currentAssessment.id } }
    });
    expect(setup.delivered).toHaveLength(deliveredAfterFirst);
  });

  it.each(["failure", "cancelled", "timed_out"] as const)(
    "never treats a %s executor result as completed work",
    async (conclusion) => {
      const runId = `run_${conclusion}`;
      const setup = await startRun({ runId, completionPolicies: [strictPolicy] });
      const response = await completeRun({ setup, runId, conclusion });

      expect(response.status).toBe(200);
      const body = await response.json() as { completion: { execution: string; completion: string } };
      expect(body.completion.execution).toBe(conclusion === "failure" ? "failed" : conclusion);
      expect(body.completion.completion).not.toBe("satisfied");
      expect(body.completion.completion).not.toBe("waived");
    }
  );

  it("promotes the next queued follow-up even while strict completion awaits evidence", async () => {
    const setup = await startRun({ runId: "run_active", completionPolicies: [strictPolicy] });
    const queued = await setup.app.request("/v1/runs", jsonRequest({
      runId: "follow_up_1",
      event: githubIssueEvent({ id: "event_follow_up", sourceEventId: "comment_follow_up" })
    }));
    expect(queued.status).toBe(202);

    const complete = await completeRun({ setup, runId: "run_active", conclusion: "success" });
    expect(complete.status).toBe(200);
    await expect(complete.json()).resolves.toMatchObject({
      completion: { completion: "pending" },
      promotedFollowUp: {
        followUpRequest: { id: "follow_up_1", status: "promoted" },
        run: { parentRunId: "run_active" }
      }
    });
  });
});
