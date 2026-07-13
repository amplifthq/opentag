import { createDispatcherClient, type AttemptLease, type DispatcherRunnerClient } from "@opentag/client";
import { OpenTagRunResultSchema, type OpenTagRunResult } from "@opentag/core";
import { defaultConfigPath, readCliConfig, runnerDispatcherToken } from "./config.js";

export type IngestCommandOptions = {
  config?: string;
  run?: string;
  event?: string;
  source?: string;
  message?: string;
  type?: string;
  idempotencyKey?: string;
  resultJson?: string;
  conclusion?: string;
  summary?: string;
};

export type IngestTemplateCommandOptions = {
  source?: string;
  command?: string;
  format?: string;
};

export type IngestDependencies = {
  client?: Pick<DispatcherRunnerClient, "progress" | "complete">;
  lease?: AttemptLease;
  env?: NodeJS.ProcessEnv;
  now?(): Date;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "log">;
};

function ingestAttemptLease(dependencies: IngestDependencies): AttemptLease {
  if (dependencies.lease) return dependencies.lease;
  const env = dependencies.env ?? process.env;
  return {
    attemptId: nonEmpty(env.OPENTAG_ATTEMPT_ID, "OPENTAG_ATTEMPT_ID"),
    fencingToken: nonEmpty(env.OPENTAG_FENCING_TOKEN, "OPENTAG_FENCING_TOKEN")
  };
}

type NormalizedIngestEvent = "progress" | "completed" | "failed" | "cancelled" | "interrupted" | "timed_out";
type IngestTemplateFormat = "shell" | "manifest";

export type IngestHookManifestEvent = {
  externalEvent: string;
  openTagEvent: NormalizedIngestEvent;
  idempotencySuffix: string;
  terminal: boolean;
  visibility: "audit";
  conclusion?: OpenTagRunResult["conclusion"];
  description: string;
};

export type IngestHookManifest = {
  version: 1;
  kind: "opentag_hook_ingest_manifest";
  source: string;
  command: string;
  requiredEnv: string[];
  optionalEnv: string[];
  permissions: {
    conversationAccess: "none";
    promptMutation: "none";
    rawContextAccess: false;
    writeActionAccess: "none";
    sourceThreadProgress: "audit_only";
    sourceThreadFinal: "concise_open_tag_summary";
  };
  lifecycle: {
    progressVisibility: "audit";
    finalAnswerGate: "before_agent_finalize_is_progress";
    terminalEventPolicy: "exactly_one_terminal_event_per_run";
  };
  events: IngestHookManifestEvent[];
  constraints: string[];
};

const INGEST_SOURCE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function nonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function normalizeIngestSource(value: string | undefined): string {
  const source = (value?.trim() || "external").toLowerCase();
  if (!INGEST_SOURCE_PATTERN.test(source)) {
    throw new Error("--source must be a safe label using lowercase letters, numbers, underscores, or hyphens.");
  }
  return source;
}

function normalizeIngestEventName(value: string | undefined): string {
  return nonEmpty(value, "--event").toLowerCase().replace(/[-.]/g, "_");
}

function normalizeIngestTemplateFormat(value: string | undefined): IngestTemplateFormat {
  const format = (value?.trim() || "shell").toLowerCase();
  if (format === "shell" || format === "manifest") return format;
  throw new Error("--format must be shell or manifest.");
}

function normalizeIngestEvent(value: string | undefined): NormalizedIngestEvent {
  const event = normalizeIngestEventName(value);
  if (
    event === "progress" ||
    event === "agent_progress" ||
    event === "post_llm_call" ||
    event === "before_agent_finalize" ||
    event === "tool_start" ||
    event === "tool_end"
  ) {
    return "progress";
  }
  if (event === "agent_end" || event === "completed" || event === "complete" || event === "final") return "completed";
  if (event === "agent_failed" || event === "failed" || event === "failure" || event === "agent_error" || event === "error") return "failed";
  if (event === "agent_cancelled" || event === "cancelled" || event === "canceled" || event === "stop" || event === "stopped") {
    return "cancelled";
  }
  if (event === "timed_out" || event === "timeout" || event === "agent_timeout") return "timed_out";
  if (event === "agent_interrupted" || event === "interrupted" || event === "session_end" || event === "on_session_end") return "interrupted";
  throw new Error(
    "--event must be progress, post_llm_call, before_agent_finalize, agent_end, failed, cancelled, timed_out, or interrupted."
  );
}

function clientFromConfig(configPath: string, dependencies: IngestDependencies): Pick<DispatcherRunnerClient, "progress" | "complete"> {
  if (dependencies.client) return dependencies.client;
  const config = readCliConfig(configPath);
  const token = runnerDispatcherToken(config.daemon);
  return createDispatcherClient({
    dispatcherUrl: config.daemon.dispatcherUrl,
    runnerId: config.daemon.runnerId,
    ...(token ? { pairingToken: token } : {}),
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {})
  });
}

function parseResultJson(value: string): OpenTagRunResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`--result-json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return OpenTagRunResultSchema.parse(parsed);
}

function resultFromOptions(options: IngestCommandOptions, event: NormalizedIngestEvent): OpenTagRunResult {
  if (options.resultJson) return parseResultJson(options.resultJson);

  const summary = nonEmpty(options.summary ?? options.message, event === "completed" ? "--summary or --message" : "--message");
  if (event === "completed") {
    const conclusion = options.conclusion?.trim() || "success";
    return OpenTagRunResultSchema.parse({ conclusion, summary });
  }
  if (event === "cancelled") {
    return { conclusion: "cancelled", summary };
  }
  if (event === "interrupted") {
    return { conclusion: "interrupted", summary };
  }
  if (event === "timed_out") {
    return { conclusion: "timed_out", summary };
  }
  return { conclusion: "failure", summary };
}

function shellParameterDefault(value: string): string {
  return value.replace(/["\\$`]/g, "\\$&");
}

function ingestCommandLine(input: {
  commandVariable?: string;
  event: string;
  idempotencySuffix: string;
  message?: string;
  summary?: string;
  commented?: boolean;
}): string {
  const prefix = input.commented ? "# " : "";
  const commandVariable = input.commandVariable ?? "$OPENTAG_INGEST_COMMAND";
  const textFlag = input.summary ? `--summary "${input.summary}"` : `--message "${input.message ?? ""}"`;
  return `${prefix}"${commandVariable}" ingest --run "$OPENTAG_RUN_ID" --source "$OPENTAG_INGEST_SOURCE" --event ${input.event} --idempotency-key "$OPENTAG_INGEST_IDEMPOTENCY_PREFIX:${input.idempotencySuffix}" ${textFlag}`;
}

function genericIngestTemplateBody(): string[] {
  return [
    ingestCommandLine({ event: "progress", idempotencySuffix: "progress:started", message: "External runtime started." }),
    ingestCommandLine({ event: "post_llm_call", idempotencySuffix: "progress:post_llm_call", message: "LLM call completed." }),
    ingestCommandLine({ event: "before_agent_finalize", idempotencySuffix: "progress:before_agent_finalize", message: "Final answer is being prepared." }),
    "",
    "# Choose exactly one terminal event:",
    ingestCommandLine({ event: "agent_end", idempotencySuffix: "complete:agent_end", summary: "External runtime completed." }),
    ingestCommandLine({
      event: "failed",
      idempotencySuffix: "complete:failed",
      message: "External runtime failed before finalization.",
      commented: true
    }),
    ingestCommandLine({
      event: "on_session_end",
      idempotencySuffix: "complete:on_session_end",
      message: "External runtime ended before finalization.",
      commented: true
    }),
    ingestCommandLine({
      event: "timed_out",
      idempotencySuffix: "complete:timed_out",
      message: "External runtime exceeded its timeout policy.",
      commented: true
    })
  ];
}

function hermesIngestTemplateBody(): string[] {
  return [
    "# Hermes hook placement:",
    "# - post_llm_call: audit-visible progress after a successful model call.",
    "# - before_agent_finalize: final-answer gate, still progress rather than completion.",
    "# - agent_end: natural completion. Use on_session_end for interrupted sessions.",
    ingestCommandLine({ event: "progress", idempotencySuffix: "progress:started", message: "Hermes runtime started." }),
    ingestCommandLine({ event: "post_llm_call", idempotencySuffix: "progress:post_llm_call", message: "Hermes post_llm_call completed." }),
    ingestCommandLine({
      event: "before_agent_finalize",
      idempotencySuffix: "progress:before_agent_finalize",
      message: "Hermes finalization gate reached."
    }),
    "",
    "# Choose exactly one terminal event:",
    ingestCommandLine({ event: "agent_end", idempotencySuffix: "complete:agent_end", summary: "Hermes session completed." }),
    ingestCommandLine({
      event: "on_session_end",
      idempotencySuffix: "complete:on_session_end",
      message: "Hermes session ended before a final answer.",
      commented: true
    }),
    ingestCommandLine({
      event: "agent_failed",
      idempotencySuffix: "complete:agent_failed",
      message: "Hermes session failed.",
      commented: true
    }),
    ingestCommandLine({
      event: "agent_timeout",
      idempotencySuffix: "complete:agent_timeout",
      message: "Hermes session exceeded its timeout policy.",
      commented: true
    })
  ];
}

function openClawIngestTemplateBody(): string[] {
  return [
    "# OpenClaw hook placement:",
    "# - before_agent_finalize: final answer is about to be produced, but the run is not complete yet.",
    "# - agent_end: natural completion observation.",
    "# - agent_cancelled / agent_interrupted: explicit non-success terminal states.",
    ingestCommandLine({ event: "progress", idempotencySuffix: "progress:started", message: "OpenClaw runtime started." }),
    ingestCommandLine({
      event: "before_agent_finalize",
      idempotencySuffix: "progress:before_agent_finalize",
      message: "OpenClaw finalization gate reached."
    }),
    "",
    "# Choose exactly one terminal event:",
    ingestCommandLine({ event: "agent_end", idempotencySuffix: "complete:agent_end", summary: "OpenClaw agent completed." }),
    ingestCommandLine({
      event: "agent_cancelled",
      idempotencySuffix: "complete:agent_cancelled",
      message: "OpenClaw agent was cancelled by user request.",
      commented: true
    }),
    ingestCommandLine({
      event: "agent_interrupted",
      idempotencySuffix: "complete:agent_interrupted",
      message: "OpenClaw agent was interrupted before finalization.",
      commented: true
    }),
    ingestCommandLine({
      event: "agent_timeout",
      idempotencySuffix: "complete:agent_timeout",
      message: "OpenClaw agent exceeded its timeout policy.",
      commented: true
    })
  ];
}

function sourceSpecificIngestTemplateBody(source: string): string[] {
  if (source === "hermes") return hermesIngestTemplateBody();
  if (source === "openclaw") return openClawIngestTemplateBody();
  return genericIngestTemplateBody();
}

function genericIngestManifestEvents(): IngestHookManifestEvent[] {
  return [
    {
      externalEvent: "progress",
      openTagEvent: "progress",
      idempotencySuffix: "progress:started",
      terminal: false,
      visibility: "audit",
      description: "External runtime started."
    },
    {
      externalEvent: "post_llm_call",
      openTagEvent: "progress",
      idempotencySuffix: "progress:post_llm_call",
      terminal: false,
      visibility: "audit",
      description: "Model call completed; this stays in audit/status by default."
    },
    {
      externalEvent: "before_agent_finalize",
      openTagEvent: "progress",
      idempotencySuffix: "progress:before_agent_finalize",
      terminal: false,
      visibility: "audit",
      description: "Final answer gate reached; this is not a successful completion signal."
    },
    {
      externalEvent: "agent_end",
      openTagEvent: "completed",
      idempotencySuffix: "complete:agent_end",
      terminal: true,
      visibility: "audit",
      conclusion: "success",
      description: "Natural external runtime completion."
    },
    {
      externalEvent: "failed",
      openTagEvent: "failed",
      idempotencySuffix: "complete:failed",
      terminal: true,
      visibility: "audit",
      conclusion: "failure",
      description: "External runtime failed before finalization."
    },
    {
      externalEvent: "on_session_end",
      openTagEvent: "interrupted",
      idempotencySuffix: "complete:on_session_end",
      terminal: true,
      visibility: "audit",
      conclusion: "interrupted",
      description: "External runtime ended without a normal final answer."
    },
    {
      externalEvent: "timed_out",
      openTagEvent: "timed_out",
      idempotencySuffix: "complete:timed_out",
      terminal: true,
      visibility: "audit",
      conclusion: "timed_out",
      description: "External runtime exceeded its timeout policy."
    }
  ];
}

function hermesIngestManifestEvents(): IngestHookManifestEvent[] {
  return genericIngestManifestEvents().map((event) => {
    if (event.externalEvent === "progress") return { ...event, description: "Hermes runtime started." };
    if (event.externalEvent === "post_llm_call") return { ...event, description: "Hermes post_llm_call completed." };
    if (event.externalEvent === "before_agent_finalize") return { ...event, description: "Hermes finalization gate reached; still progress." };
    if (event.externalEvent === "agent_end") return { ...event, description: "Hermes session completed." };
    if (event.externalEvent === "failed") return { ...event, externalEvent: "agent_failed", idempotencySuffix: "complete:agent_failed", description: "Hermes session failed." };
    if (event.externalEvent === "on_session_end") return { ...event, description: "Hermes session ended before a final answer." };
    if (event.externalEvent === "timed_out") return { ...event, externalEvent: "agent_timeout", idempotencySuffix: "complete:agent_timeout", description: "Hermes session exceeded its timeout policy." };
    return event;
  });
}

function openClawIngestManifestEvents(): IngestHookManifestEvent[] {
  return [
    {
      externalEvent: "progress",
      openTagEvent: "progress",
      idempotencySuffix: "progress:started",
      terminal: false,
      visibility: "audit",
      description: "OpenClaw runtime started."
    },
    {
      externalEvent: "before_agent_finalize",
      openTagEvent: "progress",
      idempotencySuffix: "progress:before_agent_finalize",
      terminal: false,
      visibility: "audit",
      description: "OpenClaw finalization gate reached; this is not a completion signal."
    },
    {
      externalEvent: "agent_end",
      openTagEvent: "completed",
      idempotencySuffix: "complete:agent_end",
      terminal: true,
      visibility: "audit",
      conclusion: "success",
      description: "OpenClaw agent completed naturally."
    },
    {
      externalEvent: "agent_cancelled",
      openTagEvent: "cancelled",
      idempotencySuffix: "complete:agent_cancelled",
      terminal: true,
      visibility: "audit",
      conclusion: "cancelled",
      description: "OpenClaw agent was cancelled by user request."
    },
    {
      externalEvent: "agent_interrupted",
      openTagEvent: "interrupted",
      idempotencySuffix: "complete:agent_interrupted",
      terminal: true,
      visibility: "audit",
      conclusion: "interrupted",
      description: "OpenClaw agent was interrupted before finalization."
    },
    {
      externalEvent: "agent_timeout",
      openTagEvent: "timed_out",
      idempotencySuffix: "complete:agent_timeout",
      terminal: true,
      visibility: "audit",
      conclusion: "timed_out",
      description: "OpenClaw agent exceeded its timeout policy."
    }
  ];
}

function sourceSpecificIngestManifestEvents(source: string): IngestHookManifestEvent[] {
  if (source === "hermes") return hermesIngestManifestEvents();
  if (source === "openclaw") return openClawIngestManifestEvents();
  return genericIngestManifestEvents();
}

export function createIngestHookManifest(options: IngestTemplateCommandOptions = {}): IngestHookManifest {
  const source = normalizeIngestSource(options.source);
  const command = options.command?.trim() || "opentag";
  return {
    version: 1,
    kind: "opentag_hook_ingest_manifest",
    source,
    command,
    requiredEnv: ["OPENTAG_RUN_ID", "OPENTAG_ATTEMPT_ID", "OPENTAG_FENCING_TOKEN"],
    optionalEnv: ["OPENTAG_INGEST_SOURCE", "OPENTAG_INGEST_COMMAND", "OPENTAG_INGEST_IDEMPOTENCY_PREFIX"],
    permissions: {
      conversationAccess: "none",
      promptMutation: "none",
      rawContextAccess: false,
      writeActionAccess: "none",
      sourceThreadProgress: "audit_only",
      sourceThreadFinal: "concise_open_tag_summary"
    },
    lifecycle: {
      progressVisibility: "audit",
      finalAnswerGate: "before_agent_finalize_is_progress",
      terminalEventPolicy: "exactly_one_terminal_event_per_run"
    },
    events: sourceSpecificIngestManifestEvents(source),
    constraints: [
      "Do not paste dispatcher tokens, local checkout paths, raw provider payloads, or raw tool logs into source threads.",
      "Use stable idempotency keys when retrying the same hook delivery.",
      "Report exactly one terminal event per OpenTag run.",
      "Keep progress audit-visible by default; source-thread callbacks should remain concise and provider-rendered from OpenTag state."
    ]
  };
}

export function renderIngestShellTemplate(options: IngestTemplateCommandOptions = {}): string {
  const source = normalizeIngestSource(options.source);
  const command = options.command?.trim() || "opentag";
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    "",
    "# OpenTag local hook ingest template.",
    "# Requires a paired local config with runnerId, dispatcherUrl, and runnerToken or legacy pairingToken.",
    "# Do not paste dispatcher tokens, local checkout paths, or raw tool logs into source threads.",
    ": \"${OPENTAG_RUN_ID:?Set OPENTAG_RUN_ID to the OpenTag run id}\"",
    ": \"${OPENTAG_ATTEMPT_ID:?Set OPENTAG_ATTEMPT_ID to the active OpenTag attempt id}\"",
    ": \"${OPENTAG_FENCING_TOKEN:?Set OPENTAG_FENCING_TOKEN to the active OpenTag fencing token}\"",
    `OPENTAG_INGEST_SOURCE="\${OPENTAG_INGEST_SOURCE:-${source}}"`,
    `OPENTAG_INGEST_COMMAND="\${OPENTAG_INGEST_COMMAND:-${shellParameterDefault(command)}}"`,
    'OPENTAG_INGEST_IDEMPOTENCY_PREFIX="${OPENTAG_INGEST_IDEMPOTENCY_PREFIX:-$OPENTAG_INGEST_SOURCE:$OPENTAG_RUN_ID}"',
    "",
    ...sourceSpecificIngestTemplateBody(source)
  ].join("\n");
}

export function renderIngestTemplate(options: IngestTemplateCommandOptions = {}): string {
  const format = normalizeIngestTemplateFormat(options.format);
  if (format === "manifest") {
    return JSON.stringify(createIngestHookManifest(options), null, 2);
  }
  return renderIngestShellTemplate(options);
}

export async function runIngestCommand(options: IngestCommandOptions, dependencies: IngestDependencies = {}): Promise<void> {
  const configPath = options.config ?? defaultConfigPath();
  const runId = nonEmpty(options.run, "--run");
  const source = normalizeIngestSource(options.source);
  const rawEventName = normalizeIngestEventName(options.event);
  const event = normalizeIngestEvent(options.event);
  const client = clientFromConfig(configPath, dependencies);
  const lease = ingestAttemptLease(dependencies);
  const logger = dependencies.logger ?? console;

  if (event === "progress") {
    const message = nonEmpty(options.message, "--message");
    await client.progress(runId, lease, {
      type: options.type?.trim() || `ingest.${source}.${rawEventName}`,
      message,
      at: (dependencies.now?.() ?? new Date()).toISOString(),
      visibility: "audit",
      ...(options.idempotencyKey?.trim() ? { idempotencyKey: options.idempotencyKey.trim() } : {})
    });
    logger.log(`Ingested progress for ${runId}.`);
    return;
  }

  const result = resultFromOptions(options, event);
  const idempotencyKey = options.idempotencyKey?.trim();
  if (idempotencyKey) {
    await client.complete(runId, lease, result, { idempotencyKey });
  } else {
    await client.complete(runId, lease, result);
  }
  logger.log(`Ingested ${event} result for ${runId}.`);
}

export async function runIngestTemplateCommand(
  options: IngestTemplateCommandOptions,
  dependencies: Pick<IngestDependencies, "logger"> = {}
): Promise<void> {
  const logger = dependencies.logger ?? console;
  logger.log(renderIngestTemplate(options));
}
