import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenTagEvent, OpenTagRunResult } from "@opentag/core";
import type { ExecutorAdapter } from "@opentag/runner";
import { describe, expect, it, vi } from "vitest";
import {
  executeClaimedRun,
  resolveRepositoryBinding,
  type ClaimedRunExecutionClient,
} from "../src/daemon.js";

function event(metadata: Record<string, unknown>, permissions: OpenTagEvent["permissions"] = [{ scope: "repo:write", reason: "security test" }]): OpenTagEvent {
  return {
    id: "evt_security",
    source: "slack",
    sourceEventId: "EvSecurity",
    receivedAt: "2026-06-30T00:00:00.000Z",
    actor: { provider: "slack", providerUserId: "U123", handle: "alice", organizationId: "T123" },
    target: { mention: "@opentag", agentId: "opentag", executorHint: "capture" },
    command: { rawText: "fix this", intent: "fix", args: {} },
    context: [],
    permissions,
    callback: { provider: "slack", uri: "https://slack.com/api/chat.postMessage" },
    metadata: { teamId: "T123", channelId: "C123", ...metadata },
  };
}

function lifecycle() {
  const completed: OpenTagRunResult[] = [];
  const progress: Array<{ type: string; message: string }> = [];
  const client: ClaimedRunExecutionClient = {
    markRunning: vi.fn(async () => {}),
    rejectAttemptStart: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
    progress: vi.fn(async (_runId, _lease, item) => { progress.push(item); }),
    complete: vi.fn(async (_runId, _lease, result) => { completed.push(result); }),
    requestActionPermission: vi.fn(async () => { throw new Error("unexpected permission request"); }),
    resolveActionPermission: vi.fn(async () => { throw new Error("unexpected permission resolution"); }),
    recordMaterialActionReceipt: vi.fn(async () => { throw new Error("unexpected material receipt"); }),
  };
  return { client, completed, progress };
}

function executor() {
  const run = vi.fn(async () => ({ conclusion: "success" as const, summary: "done" }));
  const canRun = vi.fn(async () => ({ ready: true as const }));
  const adapter: ExecutorAdapter = {
    id: "capture",
    displayName: "Capture",
    canRun,
    run,
    async cancel() {},
  };
  return { adapter, canRun, run };
}

async function execute(input: {
  sourceEvent: OpenTagEvent;
  repositories?: Parameters<typeof executeClaimedRun>[0]["repositories"];
  executor?: ExecutorAdapter;
  scratchRoot?: string;
  security?: Parameters<typeof executeClaimedRun>[0]["security"];
}) {
  const state = lifecycle();
  await executeClaimedRun({
    runnerId: "runner_local",
    claimed: {
      run: {
        id: "run_security",
        eventId: input.sourceEvent.id,
        status: "assigned",
        assignedRunnerId: "runner_local",
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      },
      event: input.sourceEvent,
      attemptId: "attempt_security",
      attemptNumber: 1,
      fencingToken: "fence_security",
    },
    repositories: input.repositories ?? [],
    executors: input.executor ? { capture: input.executor } : {},
    scratchRoot: input.scratchRoot ?? join(mkdtempSync(join(tmpdir(), "opentag-security-scratch-")), "scratch"),
    ...(input.security ? { security: input.security } : {}),
    heartbeatIntervalMs: 0,
    client: state.client,
  });
  return state;
}

describe("claimed Run workspace security", () => {
  it("matches a mixed-case GitHub target to its canonical local binding", () => {
    const binding = {
      projectTargetId: "target_1",
      provider: "github",
      owner: "acme",
      repo: "demo",
      checkoutPath: mkdtempSync(join(tmpdir(), "opentag-security-binding-")),
      defaultExecutor: "capture",
    };
    expect(resolveRepositoryBinding(
      event({ repoProvider: "GitHub", owner: "AcMe", repo: "DeMo" }),
      [binding],
    )).toBe(binding);
  });

  it("refuses a Project Target outside the local allowlist before executor readiness", async () => {
    const capture = executor();
    const state = await execute({
      sourceEvent: event({ repoProvider: "github", owner: "other", repo: "demo" }),
      repositories: [{
        projectTargetId: "target_1",
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: mkdtempSync(join(tmpdir(), "opentag-security-allowlist-")),
        defaultExecutor: "capture",
      }],
      executor: capture.adapter,
    });
    expect(state.completed[0]).toMatchObject({
      conclusion: "needs_human",
      summary: "This run targets github:other/demo, which is not in this runner's local Project Target allowlist.",
    });
    expect(capture.canRun).not.toHaveBeenCalled();
    expect(capture.run).not.toHaveBeenCalled();
  });

  it("refuses partial Project Target metadata before executor selection", async () => {
    const capture = executor();
    const state = await execute({
      sourceEvent: event({ owner: "acme" }),
      executor: capture.adapter,
    });
    expect(state.completed[0]).toMatchObject({
      conclusion: "needs_human",
      summary: "Repository-bearing events require complete Project Target metadata.",
    });
    expect(capture.run).not.toHaveBeenCalled();
  });

  it("passes the exact bound repository workspace to the executor", async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), "opentag-security-workspace-"));
    let observedWorkspace: unknown;
    const adapter: ExecutorAdapter = {
      id: "capture",
      displayName: "Capture",
      async canRun(input) {
        observedWorkspace = input.workspace;
        return { ready: true };
      },
      async run(input) {
        expect(input.workspace).toEqual(observedWorkspace);
        return { conclusion: "success", summary: "done" };
      },
      async cancel() {},
    };
    const state = await execute({
      sourceEvent: event({ repoProvider: "github", owner: "acme", repo: "demo" }),
      repositories: [{
        projectTargetId: "target_1",
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath,
        defaultExecutor: "capture",
      }],
      executor: adapter,
    });
    expect(observedWorkspace).toEqual({ kind: "repository", path: checkoutPath });
    expect(state.completed[0]?.conclusion).toBe("success");
  });

  it("blocks a repository workspace outside the configured security root", async () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), "opentag-security-allowed-"));
    const outsideCheckout = mkdtempSync(join(tmpdir(), "opentag-security-outside-"));
    const capture = executor();
    const state = await execute({
      sourceEvent: event({ repoProvider: "github", owner: "acme", repo: "demo" }),
      repositories: [{
        projectTargetId: "target_1",
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: outsideCheckout,
        defaultExecutor: "capture",
      }],
      executor: capture.adapter,
      security: { allowedWorkspaceRoot: allowedRoot },
    });
    expect(state.progress[0]).toMatchObject({ type: "security.blocked" });
    expect(state.completed[0]?.summary).toContain("workspace.outside_allowed_root");
    expect(capture.run).not.toHaveBeenCalled();
  });

  it("uses an isolated scratch root for repository-free work", async () => {
    const configuredRepositoryRoot = mkdtempSync(join(tmpdir(), "opentag-security-repository-"));
    const scratchRoot = join(mkdtempSync(join(tmpdir(), "opentag-security-root-")), "scratch");
    let workspacePath: string | undefined;
    const adapter: ExecutorAdapter = {
      id: "capture",
      displayName: "Capture",
      async canRun(input) {
        workspacePath = input.workspace.path;
        return { ready: true };
      },
      async run() { return { conclusion: "success", summary: "done" }; },
      async cancel() {},
    };
    const state = await execute({
      sourceEvent: event({}, []),
      executor: adapter,
      scratchRoot,
      security: { allowedWorkspaceRoot: configuredRepositoryRoot },
    });
    expect(workspacePath?.startsWith(`${scratchRoot}/`)).toBe(true);
    expect(state.completed[0]?.conclusion).toBe("success");
    expect(existsSync(workspacePath ?? "")).toBe(false);
  });

  it("refuses to reuse a pre-existing scratch Attempt directory", async () => {
    const scratchRoot = join(mkdtempSync(join(tmpdir(), "opentag-security-reuse-")), "scratch");
    const segment = createHash("sha256").update("attempt_security").digest("hex").slice(0, 24);
    const attemptPath = join(scratchRoot, `attempt-${segment}`);
    mkdirSync(attemptPath, { recursive: true });
    const capture = executor();
    const state = await execute({ sourceEvent: event({}, []), executor: capture.adapter, scratchRoot });
    expect(state.completed[0]).toMatchObject({
      conclusion: "needs_human",
      summary: "Scratch attempt workspace already exists; refusing to reuse it.",
    });
    expect(capture.canRun).not.toHaveBeenCalled();
    expect(existsSync(attemptPath)).toBe(true);
  });
});
