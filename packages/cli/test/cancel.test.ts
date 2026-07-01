import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenTagRun } from "@opentag/core";
import { cancelFromConfig, formatCancelSummary } from "../src/cancel.js";
import { createSetupConfig } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function config() {
  const built = createSetupConfig({
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
  built.daemon.dispatcherUrl = "http://dispatcher.test";
  built.daemon.pairingToken = "pairing_token";
  return built;
}

function cancelledRun(id: string): OpenTagRun {
  return {
    id,
    eventId: `evt_${id}`,
    status: "cancelled",
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:01:00.000Z",
    result: { conclusion: "cancelled", summary: "Stop requested." }
  };
}

describe("OpenTag CLI cancel", () => {
  it("cancels a run by id through the dispatcher API", async () => {
    const requests: Array<{ url: string; method?: string; authorization?: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method,
        authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
        body: JSON.parse(String(init?.body))
      });
      return Response.json({ outcome: "cancelled", run: cancelledRun("run_1") });
    }) as unknown as typeof fetch;

    const summary = await cancelFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      options: { run: "run_1", reason: "Stop from CLI.", requestedBy: "lark:ou_sender" },
      fetchImpl
    });

    expect(requests).toEqual([
      {
        url: "http://dispatcher.test/v1/runs/run_1/cancel",
        method: "POST",
        authorization: "Bearer pairing_token",
        body: { reason: "Stop from CLI.", requestedBy: "lark:ou_sender" }
      }
    ]);
    expect(summary.scope).toBe("run_1");
    expect(formatCancelSummary(summary)).toContain("Run: run_1");
    expect(formatCancelSummary(summary)).toContain("Status: cancelled (cancelled)");
    expect(formatCancelSummary(summary)).toContain("Stop is not treated as successful completion.");
    expect(formatCancelSummary(summary)).toContain("opentag status --run run_1");
  });

  it("uses runnerToken before the legacy pairing token for dispatcher runtime calls", async () => {
    const configured = config();
    configured.daemon.runnerToken = "runner_token";
    const authorizations: Array<string | undefined> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      authorizations.push((init?.headers as Record<string, string> | undefined)?.authorization);
      return Response.json({ outcome: "cancelled", run: cancelledRun("run_1") });
    }) as unknown as typeof fetch;

    await cancelFromConfig({
      config: configured,
      configPath: "/tmp/opentag/config.json",
      options: { run: "run_1" },
      fetchImpl
    });

    expect(authorizations).toEqual(["Bearer runner_token"]);
  });


  it("cancels the active source-container run through the dispatcher API", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body))
      });
      return Response.json({ outcome: "cancelled", run: cancelledRun("run_channel") });
    }) as unknown as typeof fetch;

    const summary = await cancelFromConfig({
      config: config(),
      configPath: "/tmp/opentag/config.json",
      options: { channel: "lark:tenant 1/oc/chat" },
      fetchImpl
    });

    expect(requests).toEqual([
      {
        url: "http://dispatcher.test/v1/channel-bindings/lark/tenant%201/oc%2Fchat/cancel-active-run",
        body: {
          reason: "Cancellation requested from opentag CLI.",
          requestedBy: "cli:opentag"
        }
      }
    ]);
    expect(summary.scope).toBe("lark:tenant 1/oc/chat");
    expect(summary.run.id).toBe("run_channel");
  });

  it("requires exactly one cancel target", async () => {
    await expect(
      cancelFromConfig({
        config: config(),
        configPath: "/tmp/opentag/config.json",
        options: {}
      })
    ).rejects.toThrow("Provide --run <run_id> or --channel provider:account/conversation.");

    await expect(
      cancelFromConfig({
        config: config(),
        configPath: "/tmp/opentag/config.json",
        options: { run: "run_1", channel: "lark:tenant_1/oc_chat" }
      })
    ).rejects.toThrow("Use either --run or --channel, not both.");
  });
});
