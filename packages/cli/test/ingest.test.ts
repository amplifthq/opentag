import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderIngestShellTemplate, renderIngestTemplate, runIngestCommand, runIngestTemplateCommand } from "../src/ingest.js";
import { createSetupConfig } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-ingest-test-"));
}

function writeIngestConfig(): string {
  const path = join(tempDir(), "config.json");
  const config = createSetupConfig({
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
  config.daemon.dispatcherUrl = "http://dispatcher.test";
  config.daemon.pairingToken = "pairing_token";
  config.daemon.runnerToken = "runner_token";
  writeFileSync(path, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  return path;
}

describe("OpenTag CLI ingest", () => {
  const lease = { attemptId: "attempt_1", fencingToken: "fence_1" };

  beforeEach(() => {
    vi.stubEnv("OPENTAG_ATTEMPT_ID", lease.attemptId);
    vi.stubEnv("OPENTAG_FENCING_TOKEN", lease.fencingToken);
  });

  it("reports external progress through the runner-scoped client", async () => {
    const client = {
      progress: vi.fn(async () => {}),
      complete: vi.fn(async () => {})
    };
    const output: string[] = [];

    await runIngestCommand(
      {
        run: "run_1",
        event: "progress",
        source: "hermes",
        message: "post_llm_call completed",
        idempotencyKey: "hermes:run_1:post_llm_call:1"
      },
      {
        client,
        now: () => new Date("2026-06-30T00:00:00.000Z"),
        logger: { log: (message) => output.push(message) }
      }
    );

    expect(client.progress).toHaveBeenCalledWith("run_1", lease, {
      type: "ingest.hermes.progress",
      message: "post_llm_call completed",
      at: "2026-06-30T00:00:00.000Z",
      visibility: "audit",
      idempotencyKey: "hermes:run_1:post_llm_call:1"
    });
    expect(client.complete).not.toHaveBeenCalled();
    expect(output).toEqual(["Ingested progress for run_1."]);
  });

  it("maps agent_end to a completed OpenTag result", async () => {
    const client = {
      progress: vi.fn(async () => {}),
      complete: vi.fn(async () => {})
    };

    await runIngestCommand(
      {
        run: "run_1",
        event: "agent_end",
        resultJson: JSON.stringify({
          conclusion: "success",
          summary: "External runtime completed.",
          verification: [{ command: "external-check", outcome: "passed" }]
        }),
        idempotencyKey: "hermes:run_1:complete:agent_end"
      },
      { client, logger: { log: vi.fn() } }
    );

    expect(client.complete).toHaveBeenCalledWith(
      "run_1",
      lease,
      {
        conclusion: "success",
        summary: "External runtime completed.",
        verification: [{ command: "external-check", outcome: "passed" }]
      },
      { idempotencyKey: "hermes:run_1:complete:agent_end" }
    );
    expect(client.progress).not.toHaveBeenCalled();
  });

  it("maps common hook progress aliases to audit-visible progress events", async () => {
    const client = {
      progress: vi.fn(async () => {}),
      complete: vi.fn(async () => {})
    };

    await runIngestCommand(
      {
        run: "run_1",
        event: "post_llm_call",
        source: "hermes",
        message: "LLM call completed."
      },
      {
        client,
        now: () => new Date("2026-06-30T00:00:00.000Z"),
        logger: { log: vi.fn() }
      }
    );

    expect(client.progress).toHaveBeenCalledWith("run_1", lease, {
      type: "ingest.hermes.post_llm_call",
      message: "LLM call completed.",
      at: "2026-06-30T00:00:00.000Z",
      visibility: "audit"
    });
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("uses runnerToken from config before the legacy pairing token", async () => {
    const authorizations: Array<string | null> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      expect(String(url)).toBe("http://dispatcher.test/v1/runners/runner_local/runs/run_1/progress");
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    await runIngestCommand(
      {
        config: writeIngestConfig(),
        run: "run_1",
        event: "progress",
        source: "hermes",
        message: "started"
      },
      {
        fetchImpl,
        now: () => new Date("2026-06-30T00:00:00.000Z"),
        logger: { log: vi.fn() }
      }
    );

    expect(authorizations).toEqual(["Bearer runner_token"]);
  });


  it("maps failed external events to failed OpenTag results", async () => {
    const client = {
      progress: vi.fn(async () => {}),
      complete: vi.fn(async () => {})
    };

    await runIngestCommand(
      {
        run: "run_1",
        event: "failed",
        message: "External runtime failed before finalization."
      },
      { client, logger: { log: vi.fn() } }
    );

    expect(client.complete).toHaveBeenCalledWith("run_1", lease, {
      conclusion: "failure",
      summary: "External runtime failed before finalization."
    });
  });

  it("maps external session-end interruption events to interrupted OpenTag results", async () => {
    const client = {
      progress: vi.fn(async () => {}),
      complete: vi.fn(async () => {})
    };
    const output: string[] = [];

    await runIngestCommand(
      {
        run: "run_1",
        event: "on_session_end",
        message: "External runtime ended before finalization."
      },
      { client, logger: { log: (message) => output.push(message) } }
    );

    expect(client.complete).toHaveBeenCalledWith("run_1", lease, {
      conclusion: "interrupted",
      summary: "External runtime ended before finalization."
    });
    expect(output).toEqual(["Ingested interrupted result for run_1."]);
  });

  it("maps external timeout events to timed_out OpenTag results", async () => {
    const client = {
      progress: vi.fn(async () => {}),
      complete: vi.fn(async () => {})
    };

    await runIngestCommand(
      {
        run: "run_1",
        event: "agent_timeout",
        message: "External runtime exceeded its timeout policy."
      },
      { client, logger: { log: vi.fn() } }
    );

    expect(client.complete).toHaveBeenCalledWith("run_1", lease, {
      conclusion: "timed_out",
      summary: "External runtime exceeded its timeout policy."
    });
    expect(client.progress).not.toHaveBeenCalled();
  });

  it("prints a local hook ingest shell template without local secrets or paths", async () => {
    const output: string[] = [];

    await runIngestTemplateCommand(
      {
        source: "hermes"
      },
      {
        logger: { log: (message) => output.push(message) }
      }
    );

    const template = output.join("\n");
    expect(template).toContain("# Hermes hook placement:");
    expect(template).toContain(
      "\"$OPENTAG_INGEST_COMMAND\" ingest --run \"$OPENTAG_RUN_ID\" --source \"$OPENTAG_INGEST_SOURCE\" --event post_llm_call"
    );
    expect(template).toContain("--event before_agent_finalize");
    expect(template).toContain("--event agent_end");
    expect(template).toContain("--event on_session_end");
    expect(template).toContain("--event agent_failed");
    expect(template).toContain("--event agent_timeout");
    expect(template).toContain("OPENTAG_INGEST_IDEMPOTENCY_PREFIX");
    expect(template).toContain("OPENTAG_ATTEMPT_ID");
    expect(template).toContain("OPENTAG_FENCING_TOKEN");
    expect(template).toContain('--idempotency-key "$OPENTAG_INGEST_IDEMPOTENCY_PREFIX:progress:post_llm_call"');
    expect(template).toContain('--idempotency-key "$OPENTAG_INGEST_IDEMPOTENCY_PREFIX:complete:agent_end"');
    expect(template).toContain("Do not paste dispatcher tokens");
    expect(template).not.toContain("Bearer ");
    expect(template).not.toContain("dev_pairing_token");
    expect(template).not.toContain("checkoutPath");
  });

  it("renders a source-specific hook ingest template", () => {
    const template = renderIngestShellTemplate({ source: "OpenClaw", command: "opentag-dev" });

    expect(template).toContain('OPENTAG_INGEST_SOURCE="${OPENTAG_INGEST_SOURCE:-openclaw}"');
    expect(template).toContain('OPENTAG_INGEST_COMMAND="${OPENTAG_INGEST_COMMAND:-opentag-dev}"');
    expect(template).toContain("# OpenClaw hook placement:");
    expect(template).toContain("--event before_agent_finalize");
    expect(template).toContain("--event agent_end");
    expect(template).toContain("--event agent_cancelled");
    expect(template).toContain("--event agent_interrupted");
    expect(template).not.toContain("post_llm_call");
  });

  it("renders a machine-readable hook manifest with explicit permission boundaries", () => {
    const manifest = JSON.parse(renderIngestTemplate({ source: "hermes", format: "manifest" })) as {
      kind: string;
      source: string;
      command: string;
      requiredEnv: string[];
      permissions: {
        conversationAccess: string;
        promptMutation: string;
        rawContextAccess: boolean;
        writeActionAccess: string;
        sourceThreadProgress: string;
      };
      lifecycle: {
        finalAnswerGate: string;
        terminalEventPolicy: string;
      };
      events: Array<{
        externalEvent: string;
        openTagEvent: string;
        terminal: boolean;
        visibility: string;
        conclusion?: string;
      }>;
    };

    expect(manifest).toMatchObject({
      kind: "opentag_hook_ingest_manifest",
      source: "hermes",
      command: "opentag",
      requiredEnv: ["OPENTAG_RUN_ID", "OPENTAG_ATTEMPT_ID", "OPENTAG_FENCING_TOKEN"],
      permissions: {
        conversationAccess: "none",
        promptMutation: "none",
        rawContextAccess: false,
        writeActionAccess: "none",
        sourceThreadProgress: "audit_only"
      },
      lifecycle: {
        finalAnswerGate: "before_agent_finalize_is_progress",
        terminalEventPolicy: "exactly_one_terminal_event_per_run"
      }
    });
    expect(manifest.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalEvent: "before_agent_finalize",
          openTagEvent: "progress",
          terminal: false,
          visibility: "audit"
        }),
        expect.objectContaining({
          externalEvent: "agent_end",
          openTagEvent: "completed",
          terminal: true,
          conclusion: "success"
        }),
        expect.objectContaining({
          externalEvent: "agent_timeout",
          openTagEvent: "timed_out",
          terminal: true,
          conclusion: "timed_out"
        })
      ])
    );
    expect(JSON.stringify(manifest)).not.toContain("Bearer ");
    expect(JSON.stringify(manifest)).not.toContain("checkoutPath");
  });

  it("renders source-specific terminal lifecycle events in the hook manifest", () => {
    const manifest = JSON.parse(renderIngestTemplate({ source: "openclaw", command: "opentag-dev", format: "manifest" })) as {
      command: string;
      events: Array<{ externalEvent: string; openTagEvent: string; terminal: boolean; conclusion?: string }>;
    };

    expect(manifest.command).toBe("opentag-dev");
    expect(manifest.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalEvent: "agent_cancelled",
          openTagEvent: "cancelled",
          terminal: true,
          conclusion: "cancelled"
        }),
        expect.objectContaining({
          externalEvent: "agent_interrupted",
          openTagEvent: "interrupted",
          terminal: true,
          conclusion: "interrupted"
        })
      ])
    );
    expect(manifest.events.some((event) => event.externalEvent === "post_llm_call")).toBe(false);
  });

  it("falls back to the generic external-runtime hook template for unknown sources", () => {
    const template = renderIngestShellTemplate({ source: "custom-agent" });

    expect(template).toContain('OPENTAG_INGEST_SOURCE="${OPENTAG_INGEST_SOURCE:-custom-agent}"');
    expect(template).toContain("--event post_llm_call");
    expect(template).toContain("--event before_agent_finalize");
    expect(template).toContain("--event agent_end");
    expect(template).toContain("External runtime completed.");
  });

  it("rejects unsafe source labels before rendering shell templates", () => {
    expect(() => renderIngestShellTemplate({ source: 'hermes"; rm -rf "$HOME"' })).toThrow(
      "--source must be a safe label"
    );
    expect(() => renderIngestShellTemplate({ source: "/Users/alice/agent" })).toThrow("--source must be a safe label");
  });

  it("rejects unknown ingest template formats", () => {
    expect(() => renderIngestTemplate({ source: "hermes", format: "html" })).toThrow("--format must be shell or manifest");
  });

  it("rejects unsafe source labels before sending audit events", async () => {
    await expect(
      runIngestCommand(
        {
          run: "run_1",
          event: "progress",
          source: "agent runtime",
          message: "started"
        },
        {
          client: {
            progress: vi.fn(async () => {}),
            complete: vi.fn(async () => {})
          }
        }
      )
    ).rejects.toThrow("--source must be a safe label");
  });

  it("requires the active attempt lease before ingesting runner events", async () => {
    await expect(
      runIngestCommand(
        { run: "run_1", event: "progress", message: "started" },
        {
          env: {},
          client: {
            progress: vi.fn(async () => {}),
            complete: vi.fn(async () => {})
          }
        }
      )
    ).rejects.toThrow("OPENTAG_ATTEMPT_ID is required");
  });

  it("requires progress messages", async () => {
    await expect(
      runIngestCommand(
        {
          run: "run_1",
          event: "progress"
        },
        {
          client: {
            progress: vi.fn(async () => {}),
            complete: vi.fn(async () => {})
          }
        }
      )
    ).rejects.toThrow("--message is required");
  });
});
