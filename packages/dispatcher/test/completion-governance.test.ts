import { describe, expect, it } from "vitest";
import { createDispatcherApp, type CallbackMessage, type GitHubCompletionPolicy } from "../src/index.js";

const strictPolicy: GitHubCompletionPolicy = {
  provider: "github",
  owner: "acme",
  repo: "demo",
  requiredChecks: ["build", "test"]
};

const HEAD_OLD = "a".repeat(40);
const HEAD_CURRENT = "b".repeat(40);
const BASE_SHA = "c".repeat(40);

function githubSnapshot(input: {
  deliveryId: string;
  headSha?: string;
  state?: "open" | "closed" | "merged";
  checks?: Record<string, "passed" | "failed" | "pending">;
  observedAt?: string;
  resourceRef?: string;
}) {
  return {
    provider: "github",
    deliveryId: input.deliveryId,
    eventName: "pull_request",
    repository: { owner: "acme", repo: "demo" },
    pullRequest: {
      number: 7,
      resourceRef: input.resourceRef ?? "github:acme/demo:pull_request:7",
      headSha: input.headSha ?? HEAD_CURRENT,
      baseSha: BASE_SHA,
      baseBranch: "main",
      state: input.state ?? "merged"
    },
    checks: input.checks ?? { build: "passed", test: "passed" },
    observedAt: input.observedAt ?? "2026-07-21T10:05:00.000Z",
    payloadDigest: `sha256:${(input.deliveryId === "delivery-old" ? "d" : "e").repeat(64)}`
  };
}

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

  it("becomes satisfied only after verified current-head checks and merge evidence", async () => {
    const setup = await startRun({ runId: "run_verified", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_verified", conclusion: "success" });

    const evidence = await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(githubSnapshot({ deliveryId: "delivery-verified" }))
    );
    expect(evidence.status).toBe(201);
    await expect(evidence.json()).resolves.toMatchObject({
      outcome: "recorded",
      completion: {
        execution: "succeeded",
        completion: "satisfied",
        evidenceBacked: true,
        targetBindings: [{ resourceRef: "github:acme/demo:pull_request:7", resourceVersion: HEAD_CURRENT }],
        missingGateIds: [],
        failedGateIds: [],
        blockedGateIds: []
      }
    });
  });

  it("fails a configured base-branch gate when GitHub reports another base", async () => {
    const setup = await startRun({
      runId: "run_wrong_base",
      completionPolicies: [{ ...strictPolicy, baseBranch: "release" }]
    });
    await completeRun({ setup, runId: "run_wrong_base", conclusion: "success" });
    const evidence = await setup.app.request(
      "/v1/completion-evidence/github",
      jsonRequest(githubSnapshot({ deliveryId: "delivery-wrong-base" }))
    );

    await expect(evidence.json()).resolves.toMatchObject({
      completion: {
        completion: "unsatisfied",
        failedGateIds: ["base_branch"]
      }
    });
  });

  it("deduplicates a GitHub delivery without appending another assessment", async () => {
    const setup = await startRun({ runId: "run_delivery_replay", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_delivery_replay", conclusion: "success" });
    const snapshot = githubSnapshot({ deliveryId: "delivery-replay" });
    const first = await setup.app.request("/v1/completion-evidence/github", jsonRequest(snapshot));
    const firstBody = await first.json() as { completion: { currentAssessment: { id: string } } };
    const replay = await setup.app.request("/v1/completion-evidence/github", jsonRequest(snapshot));

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      outcome: "duplicate",
      completion: { currentAssessment: { id: firstBody.completion.currentAssessment.id } }
    });
  });

  it("keeps old-head green evidence visible but fails it against the new PR head", async () => {
    const setup = await startRun({ runId: "run_stale_head", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_stale_head", conclusion: "success" });
    const oldEvidence = await setup.app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({
      deliveryId: "delivery-old",
      headSha: HEAD_OLD,
      observedAt: "2026-07-21T10:05:00.000Z"
    })));
    expect((await oldEvidence.json() as { completion: { completion: string } }).completion.completion).toBe("satisfied");

    const newEvidence = await setup.app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({
      deliveryId: "delivery-new",
      headSha: HEAD_CURRENT,
      state: "open",
      checks: { build: "passed", test: "pending" },
      observedAt: "2026-07-21T10:10:00.000Z"
    })));
    await expect(newEvidence.json()).resolves.toMatchObject({
      outcome: "recorded",
      completion: {
        completion: "unsatisfied",
        targetBindings: [{ resourceVersion: HEAD_CURRENT }],
        failedGateIds: ["required_checks", "merge"]
      }
    });
  });

  it("persists uncorrelated evidence and attaches it when the matching run result arrives later", async () => {
    const delivered: CallbackMessage[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      completionPolicies: [strictPolicy],
      callbackSink: { async deliver(message) { delivered.push(message); } }
    });
    const early = await app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({ deliveryId: "delivery-early" })));
    expect(early.status).toBe(200);
    await expect(early.json()).resolves.toEqual({ outcome: "uncorrelated" });

    expect((await app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Local Runner" }))).status).toBe(201);
    expect((await app.request("/v1/repo-bindings", jsonRequest({
      provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1"
    }))).status).toBe(201);
    expect((await app.request("/v1/runs", jsonRequest({
      runId: "run_evidence_first",
      event: githubIssueEvent({ id: "event_evidence_first", sourceEventId: "comment_evidence_first" })
    }))).status).toBe(201);
    const claim = await (await app.request("/v1/runners/runner_1/claim", { method: "POST" })).json() as {
      attemptId: string;
      fencingToken: string;
    };
    const complete = await app.request("/v1/runners/runner_1/runs/run_evidence_first/complete", jsonRequest({
      ...claim,
      result: {
        conclusion: "success",
        summary: "created the PR",
        createdPullRequestUrl: "https://github.com/acme/demo/pull/7"
      }
    }));
    expect(complete.status).toBe(200);
    await expect(complete.json()).resolves.toMatchObject({
      completion: { execution: "succeeded", completion: "satisfied" }
    });
    expect(delivered.at(-1)?.body).toContain("created the PR");
  });

  it("rejects a spoofed resource identity instead of correlating it", async () => {
    const setup = await startRun({ runId: "run_spoof", completionPolicies: [strictPolicy] });
    await completeRun({ setup, runId: "run_spoof", conclusion: "success" });
    const response = await setup.app.request("/v1/completion-evidence/github", jsonRequest(githubSnapshot({
      deliveryId: "delivery-spoof",
      resourceRef: "github:other/demo:pull_request:7"
    })));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_completion_evidence_identity" });
  });
});
