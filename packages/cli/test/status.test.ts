import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenTagEvent } from "@opentag/core";
import { describe, expect, it, vi } from "vitest";
import { createSetupConfig } from "../src/setup.js";
import {
  channelStatusFromConfig,
  formatChannelStatus,
  formatRunStatus,
  formatStatus,
  getStatusSummary,
  runStatusCommand,
  runStatusFromConfig,
  statusFromConfig
} from "../src/status.js";

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

function githubRelayConfig() {
  const built = createSetupConfig({
    language: "en",
    platform: "github",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    github: {
      token: "ghp_token",
      webhookSecret: "github_webhook_secret",
      owner: "acme",
      repo: "demo",
      webhookPath: "/github/webhooks",
      autoCreatePullRequest: false,
      port: 3050
    }
  });
  built.runtime = {
    mode: "relay",
    relayUrl: "https://relay.example",
    relayProvider: "custom"
  };
  built.daemon.dispatcherUrl = "https://relay.example";
  return built;
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
    const configured = config();
    const checkoutPath = configured.daemon.repositories[0]?.checkoutPath;
    const summary = await statusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      })
    });

    const formatted = formatStatus(summary);
    expect(summary.dispatcher).toBe("offline");
    expect(formatted).toContain("Dispatcher: offline");
    expect(formatted).toContain("Run Timeout: disabled");
    expect(formatted).toContain("Secrets:");
    expect(formatted).toContain("daemon.pairingToken: inline (redacted)");
    expect(formatted).toContain("daemon.runnerToken: daemon.pairingToken fallback");
    expect(formatted).toContain("platforms.lark.appSecret: inline (redacted)");
    expect(formatted).not.toContain("secret_test");
    expect(formatted).toContain("Agent Session Profile:");
    expect(formatted).toContain(
      "default template: opentag-{provider}-{accountId}-{conversationId}-{owner}-{repo}-{actorId}"
    );
    expect(formatted).toContain("session identity excludes checkout paths and secrets");
    expect(formatted).toContain("Platforms: lark");
    expect(formatted).toContain("Capabilities:");
    expect(formatted).toContain("platform Lark / Feishu:");
    expect(formatted).toContain("rich=yes");
    expect(formatted).toContain("liveness=thread_reply");
    expect(formatted).toContain("executor Echo:");
    expect(formatted).toContain("isolation=none");
    expect(formatted).toContain("secrets=none");
    expect(formatted).toContain("completion=process_exit");
    expect(formatted).toContain("Project Targets:");
    expect(formatted).toContain("local:path_");
    expect(formatted).toContain("(hasWorkspacePath=yes)");
    expect(checkoutPath).toBeTruthy();
    expect(formatted).not.toContain(checkoutPath);
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

  it("formats configured agent session profile identity rules in the config summary", async () => {
    const configured = config();
    configured.daemon.agentSessionProfile = {
      profile: "opentag-fixed",
      profileTemplate: "opentag-{provider}-{projectTarget}-{actorId}"
    };

    const summary = await statusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      })
    });

    const formatted = formatStatus(summary);
    expect(formatted).toContain("Agent Session Profile:");
    expect(formatted).toContain("fixed profile: opentag-fixed");
    expect(formatted).toContain("template ignored while fixed profile is set: opentag-{provider}-{projectTarget}-{actorId}");
    expect(formatted).not.toContain("checkoutPath");
  });

  it("formats secret refs in the config summary without printing resolved values", async () => {
    const configured = config();
    const configPath = join(tempDir(), "config.json");
    const previous = process.env.OPENTAG_TEST_LARK_SECRET;
    process.env.OPENTAG_TEST_LARK_SECRET = "secret_from_env";
    writeFileSync(
      configPath,
      `${JSON.stringify({
        ...configured,
        platforms: {
          ...configured.platforms,
          lark: {
            ...configured.platforms.lark!,
            appSecret: { kind: "env", name: "OPENTAG_TEST_LARK_SECRET" }
          }
        }
      })}\n`,
      { mode: 0o600 }
    );

    try {
      const summary = await getStatusSummary({
        configPath,
        fetchImpl: vi.fn(async () => Response.json({ ok: true }))
      });

      const formatted = formatStatus(summary);
      expect(formatted).toContain("platforms.lark.appSecret: env ref (OPENTAG_TEST_LARK_SECRET)");
      expect(formatted).not.toContain("secret_from_env");
      expect(formatted).not.toContain("secret_test");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENTAG_TEST_LARK_SECRET;
      } else {
        process.env.OPENTAG_TEST_LARK_SECRET = previous;
      }
    }
  });

  it("formats relay security checks in the config summary", async () => {
    const summary = await statusFromConfig({
      config: githubRelayConfig(),
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => Response.json({ ok: true }))
    });

    const formatted = formatStatus(summary);
    expect(formatted).toContain("Runtime: relay");
    expect(formatted).toContain("Relay: https://relay.example");
    expect(formatted).toContain("Relay Security:");
    expect(formatted).toContain("OK relay transport: HTTPS is enabled.");
    expect(formatted).toContain("OK GitHub webhook secret: Configured locally; the relay /github/webhooks endpoint must verify this secret before creating runs.");
    expect(formatted).toContain("WARN relay token scope: This self-hosted MVP still uses the daemon pairing token for registration and runner calls");
    expect(formatted).toContain("WARN runner security policy: No explicit daemon.security policy is configured");
  });

  it("formats relay token scope as split when runnerToken is configured", async () => {
    const configured = githubRelayConfig();
    configured.daemon.runnerToken = "runner_token";
    configured.daemon.runnerTokens = ["runner_old"];
    configured.daemon.revokedRunnerTokenFingerprints = ["abc123"];
    const summary = await statusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => Response.json({ ok: true }))
    });

    const formatted = formatStatus(summary);
    expect(formatted).toContain("OK relay token scope: Runner calls use daemon.runnerToken instead of the pairing token");
    expect(formatted).toContain("OK runner token rotation: 1 additional runner token(s) configured for the rotation window.");
    expect(formatted).toContain("OK runner token revocation: 1 revoked runner token fingerprint(s) configured");
    expect(formatted).not.toContain("still uses the daemon pairing token for registration and runner calls");
  });


  it("formats configured run timeout policy in the config summary", async () => {
    const configured = config();
    configured.daemon.runTimeoutMs = 30_000;

    const summary = await statusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async () => Response.json({ ok: true }))
    });

    expect(formatStatus(summary)).toContain("Run Timeout: hard timeout after 30 second(s)");
  });

  it("formats control-plane alert candidates in the config summary", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const configured = config();
    configured.daemon.runnerToken = "runner_token";
    const summary = await statusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      fetchImpl: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        requests.push({ url: href, init });
        if (href.endsWith("/healthz")) return Response.json({ ok: true });
        if (href.endsWith("/v1/control-plane-alerts?limit=5")) {
          return Response.json({
            alerts: [
              {
                id: "abnormal_runner_claim_rate:run.claimed:runner_local",
                type: "abnormal_runner_claim_rate",
                severity: "warn",
                eventType: "run.claimed",
                count: 10,
                threshold: 10,
                firstSeenAt: "2026-06-24T00:00:00.000Z",
                lastSeenAt: "2026-06-24T00:01:00.000Z",
                subject: "runner_local",
                reason: "Runner claim volume exceeded the local alert threshold.",
                nextAction: "Check for runaway runner loops."
              },
              {
                id: "token_misuse:security.token_misuse:slack:app_token",
                type: "token_misuse",
                severity: "warn",
                eventType: "security.token_misuse",
                count: 1,
                threshold: 1,
                firstSeenAt: "2026-06-24T00:02:00.000Z",
                lastSeenAt: "2026-06-24T00:02:00.000Z",
                subject: "slack:app_token",
                reason: "A platform or relay token failed with a terminal authentication or configuration error.",
                nextAction: "Rotate or replace the affected token, then restart or re-pair the ingress or runner that owns it."
              }
            ]
          });
        }
        return Response.json({ error: "unexpected_url" }, { status: 500 });
      }) as unknown as typeof fetch
    });

    const formatted = formatStatus(summary);
    expect(requests.map((request) => request.url)).toEqual([
      "http://localhost:3030/healthz",
      "http://localhost:3030/v1/control-plane-alerts?limit=5"
    ]);
    expect(requests[1]?.init?.headers).toMatchObject({ authorization: "Bearer runner_token" });
    expect(formatted).toContain("Control Plane Alerts:");
    expect(formatted).toContain("WARN abnormal_runner_claim_rate: runner_local count=10 threshold=10 last=2026-06-24T00:01:00.000Z");
    expect(formatted).toContain("Runner claim volume exceeded the local alert threshold.");
    expect(formatted).toContain("Next: Check for runaway runner loops.");
    expect(formatted).toContain("WARN token_misuse: slack:app_token count=1 threshold=1 last=2026-06-24T00:02:00.000Z");
    expect(formatted).toContain("A platform or relay token failed with a terminal authentication or configuration error.");
    expect(formatted).toContain("Next: Rotate or replace the affected token, then restart or re-pair the ingress or runner that owns it.");
    expect(formatted).not.toContain("xapp-");
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
    expect(formatRunStatus(summary)).toContain("Liveness:");
    expect(formatRunStatus(summary)).toContain("Provider: github (status_update)");
    expect(formatRunStatus(summary)).toContain("Human callbacks: 1; thread noise ratio: 0.5");
    expect(formatRunStatus(summary)).toContain("Progress delivery: source thread can receive concise status/progress callbacks.");
    expect(formatRunStatus(summary)).toContain("Callback Delivery:");
    expect(formatRunStatus(summary)).toContain("final: delivered=1");
    expect(formatRunStatus(summary)).toContain("callback.final.delivered - Delivered final receipt.");
  });

  it("formats callback delivery failures and duplicate-storm suppression in run status", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/v1/runs/run_callback_failed")) {
        return Response.json({
          run: {
            id: "run_callback_failed",
            eventId: "evt_status_run",
            status: "succeeded",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:01:00.000Z",
            result: { conclusion: "success", summary: "Done locally." }
          },
          event: runEvent
        });
      }
      if (href.endsWith("/v1/runs/run_callback_failed/events")) {
        return Response.json({
          events: [
            {
              type: "callback.acknowledgement.queued",
              visibility: "audit",
              importance: "normal",
              createdAt: "2026-06-24T00:00:01.000Z"
            },
            {
              type: "callback.acknowledgement.delivered",
              visibility: "human",
              importance: "normal",
              message: "OpenTag picked this up.",
              createdAt: "2026-06-24T00:00:02.000Z"
            },
            {
              type: "callback.progress.duplicate",
              visibility: "audit",
              importance: "normal",
              message: "Duplicate callback delivery suppressed.",
              createdAt: "2026-06-24T00:00:10.000Z"
            },
            {
              type: "callback.final.queued",
              visibility: "audit",
              importance: "normal",
              createdAt: "2026-06-24T00:01:00.000Z"
            },
            {
              type: "callback.final.failed",
              visibility: "audit",
              importance: "normal",
              createdAt: "2026-06-24T00:01:05.000Z"
            },
            {
              type: "callback.final.suppressed",
              visibility: "audit",
              importance: "high",
              message: "Callback delivery retry budget exhausted; further delivery attempts are suppressed to avoid duplicate storms.",
              createdAt: "2026-06-24T00:01:06.000Z"
            }
          ]
        });
      }
      if (href.endsWith("/v1/runs/run_callback_failed/metrics")) {
        return Response.json({
          metrics: {
            runId: "run_callback_failed",
            totalEventCount: 6,
            humanEventCount: 1,
            auditEventCount: 5,
            debugEventCount: 0,
            humanCallbackCount: 1,
            threadNoiseRatio: 0.17,
            suggestedChangesCount: 0,
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
      runId: "run_callback_failed",
      fetchImpl
    });

    const formatted = formatRunStatus(summary);
    expect(formatted).toContain("Callback Delivery:");
    expect(formatted).toContain("acknowledgement: queued=1, delivered=1");
    expect(formatted).toContain("progress: duplicate=1");
    expect(formatted).toContain("final: queued=1, failed=1, suppressed=1");
    expect(formatted).toContain(
      "Attention: final callback has failed=1, suppressed=1; inspect audit events before assuming the source thread saw the result."
    );
    expect(formatted).toContain("callback.final.suppressed - Callback delivery retry budget exhausted");
  });

  it("formats human stop semantics for cancelled runs", () => {
    const formatted = formatRunStatus({
      configPath: "/tmp/opentag/config.json",
      dispatcherUrl: "http://localhost:3030",
      run: {
        id: "run_cancelled_by_user",
        eventId: "evt_status_run",
        status: "cancelled",
        createdAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:01:00.000Z",
        result: { conclusion: "cancelled", summary: "Stop requested from Lark." }
      },
      event: runEvent,
      metrics: {
        runId: "run_cancelled_by_user",
        totalEventCount: 1,
        humanEventCount: 0,
        auditEventCount: 1,
        debugEventCount: 0,
        humanCallbackCount: 0,
        threadNoiseRatio: 0,
        suggestedChangesCount: 0,
        approvalDecisionCount: 0,
        applyPlanCount: 0,
        childRunCount: 0,
        applyOutcomeCounts: { applied: 0, skipped: 0, failed: 0, stale: 0, unsupported: 0 },
        staleIntentCount: 0
      },
      events: [
        {
          type: "run.cancel_requested",
          visibility: "audit",
          importance: "high",
          message: "Stop requested from Lark.",
          createdAt: "2026-06-24T00:01:00.000Z",
          payload: {
            terminalReason: "cancelled_by_user",
            terminalSemantics: "A human stop request is not a successful completion and does not auto-promote queued follow-ups."
          }
        }
      ]
    });

    expect(formatted).toContain("Status: cancelled (cancelled)");
    expect(formatted).toContain("Terminal reason: cancelled_by_user");
    expect(formatted).toContain(
      "Terminal semantics: A human stop request is not a successful completion and does not auto-promote queued follow-ups."
    );
  });

  it("formats run-specific timeout policy from running audit events", () => {
    const formatted = formatRunStatus({
      configPath: "/tmp/opentag/config.json",
      dispatcherUrl: "http://localhost:3030",
      run: {
        id: "run_timeout_visible",
        eventId: "evt_status_run",
        status: "running",
        createdAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:01:00.000Z"
      },
      event: runEvent,
      metrics: {
        runId: "run_timeout_visible",
        totalEventCount: 1,
        humanEventCount: 0,
        auditEventCount: 1,
        debugEventCount: 0,
        humanCallbackCount: 0,
        threadNoiseRatio: 0,
        suggestedChangesCount: 0,
        approvalDecisionCount: 0,
        applyPlanCount: 0,
        childRunCount: 0,
        applyOutcomeCounts: { applied: 0, skipped: 0, failed: 0, stale: 0, unsupported: 0 },
        staleIntentCount: 0
      },
      runTimeoutPolicy: "hard timeout after 30 second(s)",
      events: [
        {
          type: "run.running",
          visibility: "audit",
          importance: "normal",
          createdAt: "2026-06-24T00:00:30.000Z",
          payload: {
            executor: "echo",
            runTimeoutMs: 45_000
          }
        }
      ]
    });

    expect(formatted).toContain("Run Timeout: hard timeout after 45 second(s)");
    expect(formatted).not.toContain("Run Timeout: hard timeout after 30 second(s)");
  });

  it("formats run provenance from creation audit payloads", () => {
    const formatted = formatRunStatus({
      configPath: "/tmp/opentag/config.json",
      dispatcherUrl: "https://relay.example",
      run: {
        id: "run_provenance_visible",
        eventId: "evt_status_run",
        status: "succeeded",
        createdAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:01:00.000Z",
        result: { conclusion: "success", summary: "Done." }
      },
      event: {
        ...runEvent,
        metadata: {
          ...runEvent.metadata,
          sourceDeliveryId: "delivery_from_event",
          signatureState: "unverified"
        }
      },
      metrics: {
        runId: "run_provenance_visible",
        totalEventCount: 2,
        humanEventCount: 0,
        auditEventCount: 2,
        debugEventCount: 0,
        humanCallbackCount: 0,
        threadNoiseRatio: 0,
        suggestedChangesCount: 0,
        approvalDecisionCount: 0,
        applyPlanCount: 0,
        childRunCount: 0,
        applyOutcomeCounts: { applied: 0, skipped: 0, failed: 0, stale: 0, unsupported: 0 },
        staleIntentCount: 0
      },
      events: [
        {
          type: "run.created",
          visibility: "audit",
          importance: "low",
          createdAt: "2026-06-24T00:00:00.000Z",
          payload: {
            eventId: "evt_status_run",
            provenance: {
              source: "github",
              sourceEventId: "comment_status_run",
              sourceDeliveryId: "delivery_123",
              signatureState: "verified",
              projectTarget: { ref: "github:acme/demo", provider: "github", owner: "acme", repo: "demo" },
              admissionDecision: {
                action: "start",
                reasonCode: "new_event",
                eventId: "evt_status_run"
              },
              expectedRunnerId: "runner_1"
            }
          }
        },
        {
          type: "run.claimed",
          visibility: "audit",
          importance: "normal",
          createdAt: "2026-06-24T00:00:10.000Z",
          payload: {
            runnerId: "runner_1"
          }
        }
      ]
    });

    expect(formatted).toContain("Provenance:");
    expect(formatted).toContain("Source delivery: delivery_123");
    expect(formatted).toContain("Signature: verified");
    expect(formatted).toContain("Project Target: github:acme/demo");
    expect(formatted).toContain("Admission: start (new_event); event=evt_status_run");
    expect(formatted).toContain("Expected runner: runner_1");
    expect(formatted).toContain("Claimed runner: runner_1");
    expect(formatted).not.toContain("delivery_from_event");
    expect(formatted).not.toContain("checkoutPath");
    expect(formatted).not.toContain("localPath");
  });

  it("formats liveness suppression detail for quiet source-thread platforms", async () => {
    const larkEvent: OpenTagEvent = {
      ...runEvent,
      id: "evt_lark_status_run",
      source: "lark",
      sourceEventId: "msg_lark_status_run",
      actor: { provider: "lark", providerUserId: "ou_sender", handle: "ming", organizationId: "tenant_1" },
      context: [{ provider: "lark", kind: "message", uri: "lark://tenant/tenant_1/chat/oc_chat/message/om_msg", visibility: "organization" }],
      callback: {
        provider: "lark",
        uri: "lark://im/v1/messages",
        threadKey: "tenant_1|oc_chat|om_msg"
      },
      metadata: { tenantKey: "tenant_1", chatId: "oc_chat", repoProvider: "github", owner: "acme", repo: "demo" }
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/v1/runs/run_lark_quiet")) {
        return Response.json({
          run: {
            id: "run_lark_quiet",
            eventId: "evt_lark_status_run",
            status: "running",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:01:00.000Z"
          },
          event: larkEvent
        });
      }
      if (href.endsWith("/v1/runs/run_lark_quiet/events")) {
        return Response.json({
          events: [
            {
              type: "run.progress",
              visibility: "human",
              importance: "normal",
              message: "External runtime requested a human-visible progress update.",
              createdAt: "2026-06-24T00:00:30.000Z"
            },
            {
              type: "callback.progress.suppressed",
              visibility: "audit",
              importance: "low",
              message: "Progress callback suppressed by platform liveness strategy; use status or audit for details.",
              payload: {
                provider: "lark",
                requestedVisibility: "human",
                reason: "platform_liveness_strategy",
                livenessStrategy: "thread_reply"
              },
              createdAt: "2026-06-24T00:00:31.000Z"
            }
          ]
        });
      }
      if (href.endsWith("/v1/runs/run_lark_quiet/metrics")) {
        return Response.json({
          metrics: {
            runId: "run_lark_quiet",
            totalEventCount: 2,
            humanEventCount: 1,
            auditEventCount: 1,
            debugEventCount: 0,
            humanCallbackCount: 0,
            threadNoiseRatio: 0,
            suggestedChangesCount: 0,
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
      runId: "run_lark_quiet",
      fetchImpl
    });

    const formatted = formatRunStatus(summary);
    expect(formatted).toContain("Provider: lark (thread_reply)");
    expect(formatted).toContain("Human callbacks: 0; thread noise ratio: 0");
    expect(formatted).toContain("Progress delivery: source thread uses concise thread replies for liveness.");
    expect(formatted).toContain("Suppressed progress callbacks: 1 (platform_liveness_strategy)");
    expect(formatted).toContain("callback.progress.suppressed - Progress callback suppressed by platform liveness strategy");
  });

  it("formats source receipt liveness detail for receipt-based platforms", async () => {
    const slackEvent: OpenTagEvent = {
      ...runEvent,
      id: "evt_slack_status_run",
      source: "slack",
      sourceEventId: "EvSlackStatus",
      actor: { provider: "slack", providerUserId: "U123", handle: "alice", organizationId: "T123" },
      context: [{ provider: "slack", kind: "message", uri: "slack://team/T123/channel/C123/message/1710000000.000100", visibility: "organization" }],
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100"
      },
      metadata: { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" }
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/v1/runs/run_slack_receipt")) {
        return Response.json({
          run: {
            id: "run_slack_receipt",
            eventId: "evt_slack_status_run",
            status: "running",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:01:00.000Z"
          },
          event: slackEvent
        });
      }
      if (href.endsWith("/v1/runs/run_slack_receipt/events")) {
        return Response.json({
          events: [
            {
              type: "source_receipt.delivered",
              visibility: "audit",
              importance: "low",
              message: "Source received receipt delivered.",
              payload: { provider: "slack", state: "received" },
              createdAt: "2026-06-24T00:00:01.000Z"
            },
            {
              type: "source_receipt.delivered",
              visibility: "audit",
              importance: "low",
              message: "Source running receipt delivered.",
              payload: { provider: "slack", state: "running" },
              createdAt: "2026-06-24T00:00:30.000Z"
            },
            {
              type: "run.progress",
              visibility: "audit",
              importance: "normal",
              message: "Internal progress stays in audit.",
              createdAt: "2026-06-24T00:00:31.000Z"
            }
          ]
        });
      }
      if (href.endsWith("/v1/runs/run_slack_receipt/metrics")) {
        return Response.json({
          metrics: {
            runId: "run_slack_receipt",
            totalEventCount: 3,
            humanEventCount: 0,
            auditEventCount: 3,
            debugEventCount: 0,
            humanCallbackCount: 0,
            threadNoiseRatio: 0,
            suggestedChangesCount: 0,
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
      runId: "run_slack_receipt",
      fetchImpl
    });

    const formatted = formatRunStatus(summary);
    expect(formatted).toContain("Provider: slack (source_receipt)");
    expect(formatted).toContain("Progress delivery: source thread uses native receipts first; routine progress stays in audit/status.");
    expect(formatted).toContain("Source receipts: 2 delivered, 0 failed (received, running)");
    expect(formatted).toContain("Human callbacks: 0; thread noise ratio: 0");
    expect(formatted).toContain("source_receipt.delivered - Source running receipt delivered.");
  });

  it("formats one source container runtime summary from dispatcher status endpoints", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      requests.push(href);
      return Response.json({
        binding: {
          provider: "lark",
          accountId: "tenant_1",
          conversationId: "oc_chat",
          repoProvider: "github",
          owner: "acme",
          repo: "demo"
        },
        activeRun: {
          id: "run_active",
          eventId: "evt_status_run",
          status: "running",
          createdAt: "2026-06-24T00:00:00.000Z",
          updatedAt: "2026-06-24T00:02:00.000Z"
        },
        activeEvent: runEvent,
        runTimeoutPolicy: { hardTimeoutMs: 45_000 },
        queuedFollowUps: [
          {
            id: "follow_up_1",
            sourceEventId: "evt_follow_up",
            conversationKey: "lark:tenant_1|oc_chat|om_thread",
            activeRunId: "run_active",
            event: runEvent,
            decision: {
              action: "queue_follow_up",
              reason: "A run is already active for this thread.",
              reasonCode: "active_run_same_thread",
              decidedAt: "2026-06-24T00:02:10.000Z",
              activeRunId: "run_active",
              eventId: "evt_follow_up"
            },
            status: "queued",
            createdAt: "2026-06-24T00:02:10.000Z",
            updatedAt: "2026-06-24T00:02:10.000Z"
          }
        ]
      });
    }) as unknown as typeof fetch;

    const configured = config();
    configured.daemon.runTimeoutMs = 30_000;
    const summary = await channelStatusFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      channel: "lark:tenant_1/oc_chat",
      fetchImpl
    });

    expect(requests).toEqual(["http://localhost:3030/v1/channel-bindings/lark/tenant_1/oc_chat/status"]);
    expect(formatChannelStatus(summary)).toContain("Source container: lark:tenant_1/oc_chat");
    expect(formatChannelStatus(summary)).toContain("Project Target: github:acme/demo");
    expect(formatChannelStatus(summary)).toContain("Active run: run_active (running), updated 2026-06-24T00:02:00.000Z");
    expect(formatChannelStatus(summary)).toContain("Command: label this bug");
    expect(formatChannelStatus(summary)).toContain("Queued follow-ups: 1 (follow_up_1 (queued): label this bug)");
    expect(formatChannelStatus(summary)).toContain("opentag cancel --run run_active");
    expect(formatChannelStatus(summary)).toContain("Stop/timeout: cancellation is explicit and is not reported as successful completion; timeout policy: hard timeout after 45 second(s).");
  });

  it("rejects ambiguous run and channel status requests", async () => {
    await expect(runStatusCommand({ run: "run_1", channel: "lark:tenant_1/oc_chat" })).rejects.toThrow(
      "Use either --run or --channel, not both."
    );
  });
});
