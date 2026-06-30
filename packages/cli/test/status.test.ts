import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenTagEvent } from "@opentag/core";
import { describe, expect, it, vi } from "vitest";
import { createSetupConfig } from "../src/setup.js";
import { formatRunStatus, formatStatus, runStatusFromConfig, statusFromConfig } from "../src/status.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function config() {
  return createSetupConfig({
    language: "en",
    platform: "lark",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    lark: {
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      setupMethod: "scan",
      bindingMethod: "default_project"
    }
  });
}

function hangingFetch(): typeof fetch {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as unknown as typeof fetch;
}

const runEvent: OpenTagEvent = {
  id: "evt_status_run",
  source: "github",
  sourceEventId: "comment_status_run",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42", handle: "octocat" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "label this bug", intent: "fix", args: {} },
  context: [],
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

describe("OpenTag CLI status", () => {
  it("reports offline dispatcher without failing the config summary", async () => {
    const summary = await statusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      })
    });

    expect(summary.dispatcher).toBe("offline");
    expect(formatStatus(summary)).toContain("Dispatcher: offline");
    expect(formatStatus(summary)).toContain("Platforms: lark");
  });

  it("reports offline when dispatcher health hangs until timeout", async () => {
    const fetchImpl = hangingFetch();

    const summary = await statusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      fetchImpl,
      healthTimeoutMs: 5
    });

    expect(summary.dispatcher).toBe("offline");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("formats one run audit summary from dispatcher status endpoints", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      requests.push(href);
      if (href.endsWith("/v1/runs/run_status_1")) {
        return Response.json({
          run: {
            id: "run_status_1",
            eventId: "evt_status_run",
            status: "succeeded",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:01:00.000Z",
            result: { conclusion: "success", summary: "Done." }
          },
          event: runEvent
        });
      }
      if (href.endsWith("/v1/runs/run_status_1/events")) {
        return Response.json({
          events: [
            {
              type: "run.created",
              visibility: "audit",
              importance: "normal",
              message: "Queued run.",
              createdAt: "2026-06-24T00:00:00.000Z"
            },
            {
              type: "callback.final.delivered",
              visibility: "human",
              importance: "normal",
              message: "Delivered final receipt.",
              createdAt: "2026-06-24T00:01:00.000Z"
            }
          ]
        });
      }
      if (href.endsWith("/v1/runs/run_status_1/metrics")) {
        return Response.json({
          metrics: {
            runId: "run_status_1",
            totalEventCount: 2,
            humanEventCount: 1,
            auditEventCount: 1,
            debugEventCount: 0,
            humanCallbackCount: 1,
            threadNoiseRatio: 0.5,
            suggestedChangesCount: 1,
            approvalDecisionCount: 0,
            applyPlanCount: 0,
            childRunCount: 0,
            applyOutcomeCounts: { applied: 0, skipped: 0, failed: 0, stale: 0, unsupported: 0 },
            staleIntentCount: 0
          }
        });
      }
      return Response.json({ error: "unexpected_url" }, { status: 500 });
    }) as unknown as typeof fetch;

    const summary = await runStatusFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      runId: "run_status_1",
      fetchImpl
    });

    expect(requests).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/v1/runs/run_status_1"),
        expect.stringContaining("/v1/runs/run_status_1/events"),
        expect.stringContaining("/v1/runs/run_status_1/metrics")
      ])
    );
    expect(formatRunStatus(summary)).toContain("Run: run_status_1");
    expect(formatRunStatus(summary)).toContain("Status: succeeded (success)");
    expect(formatRunStatus(summary)).toContain("Metrics: 2 events, 1 suggested action(s), 0 apply plan(s), 0 stale intent(s)");
    expect(formatRunStatus(summary)).toContain("callback.final.delivered - Delivered final receipt.");
  });
});
