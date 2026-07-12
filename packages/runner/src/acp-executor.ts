import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  containsCredentialLikeData,
  contextPointerLabel,
  isCredentialFieldName,
  isCredentialSafeText,
  OpenTagIntegrationManifestSchema,
  redactCredentialLikeData,
  type OpenTagIntegrationManifestInput,
  type OpenTagStdioBinding
} from "@opentag/core";
import { nodeCommandRunner, type CommandRunner } from "./command.js";
import {
  type ExecutorAdapter,
  type ExecutorEventSink,
  type ExecutorPermissionResolution,
  type ExecutorRunInput,
  type ExecutorWorkspace
} from "./executor.js";
import {
  branchNameForRun,
  changedFiles,
  cleanupInternalArtifacts,
  commitRunChanges,
  createRunWorktree,
  deleteRunBranch,
  executionPathForAttempt,
  removeRunWorktree
} from "./git.js";
import { createExecutorRunResult } from "./result.js";
import { scrubEnvironment } from "./security.js";

const DEFAULT_CANCEL_GRACE_MS = 1_000;
const CHILD_EXIT_GRACE_MS = 500;
const MAX_ACP_DIAGNOSTIC_BYTES = 16 * 1024;

class AcpPublicFailure extends Error {}

function safeDiagnosticFragment(value: string): string {
  return redactCredentialLikeData(value.replace(CONTROL_CHARACTER_PATTERN, " ").trim()).slice(0, 2_000);
}

export type AcpPermissionOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
};

export type AcpPermissionRequest = {
  runId: string;
  toolCall: {
    toolCallId: string;
    title: string;
    kind?: string | null;
    status?: string | null;
    targetFingerprint?: string;
  };
  options: AcpPermissionOption[];
  permissionScopes: string[];
};

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/gu;
const SAFE_RESOURCE_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:", "git+http:", "git+https:", "git+ssh:"]);
const REUSABLE_QUERY_KEYS = new Set(["branch", "dry_run", "environment", "force", "mode", "ref", "region", "stage", "tag", "version", "visibility"]);

function safeLabel(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(CONTROL_CHARACTER_PATTERN, "").trim().slice(0, maximumLength);
  if (!normalized || !isCredentialSafeText(normalized)) return undefined;
  return normalized;
}

function safeProvider(value: unknown): string | undefined {
  const normalized = safeLabel(value, 64)?.toLowerCase();
  return normalized && /^[a-z0-9][a-z0-9._-]*$/u.test(normalized) ? normalized : undefined;
}

function safeResourceIdentity(value: unknown): { resource?: string; constraints?: Record<string, unknown> } {
  if (typeof value !== "string") return {};
  const normalized = value.replace(CONTROL_CHARACTER_PATTERN, "").trim().slice(0, 512);
  if (!normalized) return {};
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(normalized)) {
    return containsCredentialLikeData(normalized)
      ? { constraints: { resourceMode: "credential_path", resourceFingerprint: canonicalTargetFingerprint(normalized), reuse: "deny" } }
      : { resource: normalized };
  }
  try {
    const url = new URL(normalized);
    if (!SAFE_RESOURCE_PROTOCOLS.has(url.protocol)) {
      return { constraints: { resourceMode: "unsupported_scheme", resourceFingerprint: canonicalTargetFingerprint(normalized), reuse: "deny" } };
    }
    const hadUserInfo = Boolean(url.username || url.password);
    const hadCredentialFragment = Boolean(url.hash && containsCredentialLikeData(url.hash));
    const queryEntries = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    const disclosedQuery: Record<string, string | string[]> = {};
    let denyReuse = hadUserInfo || hadCredentialFragment;
    let strippedCredentials = false;
    let hasUnclassifiedQuery = false;
    for (const [key, queryValue] of queryEntries) {
      if (isCredentialFieldName(key) || containsCredentialLikeData(queryValue)) {
        strippedCredentials = true;
        denyReuse = true;
        continue;
      }
      if (!isCredentialSafeText(key) || !isCredentialSafeText(queryValue)) {
        denyReuse = true;
        continue;
      }
      if (!REUSABLE_QUERY_KEYS.has(key.toLowerCase())) {
        hasUnclassifiedQuery = true;
        denyReuse = true;
      }
      const existing = disclosedQuery[key];
      disclosedQuery[key] = existing === undefined ? queryValue : Array.isArray(existing) ? [...existing, queryValue] : [existing, queryValue];
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return { constraints: { resourceMode: "invalid_encoding", resourceFingerprint: canonicalTargetFingerprint(normalized), reuse: "deny" } };
    }
    if (containsCredentialLikeData(decodedPath)) {
      return { constraints: { resourceMode: "credential_path", resourceFingerprint: canonicalTargetFingerprint(normalized), reuse: "deny" } };
    }
    const resource = url.toString().replace(/\/$/u, url.pathname === "/" ? "/" : "");
    const constraints = queryEntries.length > 0 || hadUserInfo || hadCredentialFragment
      ? {
          ...(hadUserInfo || hadCredentialFragment
            ? { resourceMode: "credential_stripped", resourceFingerprint: canonicalTargetFingerprint(normalized) }
            : {}),
          ...(Object.keys(disclosedQuery).length > 0 ? { urlQuery: disclosedQuery } : {}),
          ...(queryEntries.length > 0
            ? {
                queryMode: strippedCredentials ? "credential_stripped" : hasUnclassifiedQuery ? "unclassified_exact" : "canonical",
                ...(strippedCredentials || hasUnclassifiedQuery
                  ? { queryFingerprint: canonicalTargetFingerprint(queryEntries) }
                  : {})
              }
            : {}),
          reuse: denyReuse ? "deny" : "exact"
        }
      : undefined;
    return { resource, ...(constraints ? { constraints } : {}) };
  } catch {
    return containsCredentialLikeData(normalized)
      ? { constraints: { resourceMode: "credential_path", resourceFingerprint: canonicalTargetFingerprint(normalized), reuse: "deny" } }
      : { constraints: { resourceMode: "invalid_url", resourceFingerprint: canonicalTargetFingerprint(normalized), reuse: "deny" } };
  }
}

function safeToolTitle(value: unknown): string {
  return safeLabel(value, 160) ?? "Sensitive tool action";
}

function credentialSafeTarget(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(credentialSafeTarget).filter((child) => child !== undefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isCredentialFieldName(key))
      .map(([key, child]) => [key, credentialSafeTarget(child)])
      .filter((entry): entry is [string, unknown] => entry[1] !== undefined));
  }
  if (typeof value === "string" && containsCredentialLikeData(value)) return undefined;
  return value;
}

function canonicalTargetFingerprint(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const canonical = (child: unknown): string => {
    if (Array.isArray(child)) return `[${child.map(canonical).join(",")}]`;
    if (child && typeof child === "object") {
      return `{${Object.entries(child as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
        .join(",")}}`;
    }
    return JSON.stringify(child) ?? "null";
  };
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function structuredPermissionTarget(rawInput: unknown, kind: string | null | undefined): {
  provider: string;
  connectionId: string;
  operation: string;
  resource?: string;
  resourceVersion?: string;
  targetConstraints?: Record<string, unknown>;
  targetFingerprint?: string;
} {
  const rawRecord = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? rawInput as Record<string, unknown>
    : {};
  const safeTarget = credentialSafeTarget(rawRecord);
  const record = safeTarget && typeof safeTarget === "object" && !Array.isArray(safeTarget)
    ? safeTarget as Record<string, unknown>
    : {};
  const firstString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  const provider = safeProvider(record["provider"]) ?? "acp";
  const connectionId = safeLabel(record["connectionId"], 128) ?? `${provider}:agent-managed`;
  const operation = safeLabel(record["operation"], 64)?.toLowerCase()
    ?? safeLabel(kind, 64)?.toLowerCase()
    ?? "tool";
  const rawResource = ["resource", "package", "repository", "repo", "path", "url", "id"]
    .map((key) => rawRecord[key])
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  const resourceIdentity = safeResourceIdentity(rawResource);
  const resource = resourceIdentity.resource;
  const resourceVersion = safeLabel(firstString("resourceVersion", "version", "tag", "ref"), 128);
  const fingerprintTarget: Record<string, unknown> = { ...record };
  for (const key of ["resource", "package", "repository", "repo", "path", "url", "id"]) delete fingerprintTarget[key];
  for (const key of ["resourceVersion", "version", "tag", "ref"]) delete fingerprintTarget[key];
  Object.assign(fingerprintTarget, {
    provider,
    connectionId,
    operation,
    ...(resource ? { resource } : {}),
    ...(resourceVersion ? { resourceVersion } : {}),
    ...(resourceIdentity.constraints ? { targetConstraints: resourceIdentity.constraints } : {})
  });
  return {
    provider,
    connectionId,
    operation,
    ...(resource ? { resource } : {}),
    ...(resourceVersion ? { resourceVersion } : {}),
    ...(resourceIdentity.constraints ? { targetConstraints: resourceIdentity.constraints } : {}),
    ...(rawInput === undefined ? {} : { targetFingerprint: canonicalTargetFingerprint(fingerprintTarget)! })
  };
}

export type AcpPermissionDecision =
  | { decision: "allow_once" }
  | { decision: "allow_run" }
  | { decision: "deny" };

export type AcpPermissionResolver = (request: AcpPermissionRequest) => Promise<AcpPermissionDecision>;

export type AcpExecutorOptions = {
  manifest: OpenTagIntegrationManifestInput;
  permissionResolver?: AcpPermissionResolver;
  runner?: CommandRunner;
  cancelGraceMs?: number;
};

type NormalizedAcpManifest = {
  id: string;
  label: string;
  binding: OpenTagStdioBinding;
};

type ActiveRun = {
  runId: string;
  attemptId?: string;
  child?: ChildProcessWithoutNullStreams;
  client?: acp.ClientContext;
  sessionId?: string;
  cancelRequested: boolean;
};

function activeRunKey(runId: string, attemptId?: string): string {
  return `${runId}\u0000${attemptId ?? "legacy"}`;
}

function normalizeManifest(input: OpenTagIntegrationManifestInput): NormalizedAcpManifest {
  const manifest = OpenTagIntegrationManifestSchema.parse(input);
  const role = manifest.roles.agent;
  if (!role) throw new Error("ACP executor manifest must declare roles.agent.");
  const binding = manifest.bindings[role.binding];
  if (!binding) throw new Error(`ACP agent role references missing binding '${role.binding}'.`);
  return { id: manifest.id, label: manifest.label, binding };
}

function assertExplicitWorkspace(input: ExecutorRunInput): ExecutorWorkspace {
  if (!input.workspace) {
    throw new Error("ACP execution requires an explicit repository or scratch workspace.");
  }
  if (!isAbsolute(input.workspace.path)) {
    throw new Error(`ACP workspace must be absolute: ${input.workspace.path}`);
  }
  return input.workspace;
}

function promptForRun(input: ExecutorRunInput): string {
  const lines = [
    `OpenTag run: ${input.runId}`,
    "",
    "Command:",
    input.command.rawText,
    "",
    "Selected context:"
  ];
  if (input.context.length === 0) lines.push("- none");
  for (const pointer of input.context) {
    lines.push(`- ${contextPointerLabel(pointer)}: ${pointer.uri}`);
  }
  if (input.contextPacket) {
    lines.push("", "Context summary:", input.contextPacket.summary);
    if (input.contextPacket.exclusions?.length) {
      lines.push("", "Exclusions:", ...input.contextPacket.exclusions.map((exclusion) => `- ${exclusion}`));
    }
  }
  lines.push("", "Permission scope labels:");
  if (!input.permissions?.length) lines.push("- none");
  else lines.push(...input.permissions.map((permission) => `- ${permission.scope}`));
  lines.push(
    "",
    "OpenTag owns source-control publication and external material actions. Work only inside the supplied session cwd and request permission through ACP when required."
  );
  return lines.join("\n");
}

function permissionResponseForDecision(
  decision: AcpPermissionDecision,
  options: AcpPermissionOption[]
): { outcome: { outcome: "selected"; optionId: string } } | { outcome: { outcome: "cancelled" } } {
  const desiredKinds =
    decision.decision === "allow_once"
      ? ["allow_once"]
      : decision.decision === "allow_run"
        ? ["allow_always", "allow_once"]
        : ["reject_once", "reject_always"];
  const selected = desiredKinds
    .map((kind) => options.find((option) => option.kind === kind))
    .find((option) => option !== undefined);
  return selected
    ? { outcome: { outcome: "selected", optionId: selected.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function strictAcpOutput(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";

  function validate(line: string): void {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    } catch {
      throw new Error("ACP agent emitted an invalid NDJSON frame.");
    }
  }

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) validate(line.replace(/\r$/u, ""));
        controller.enqueue(chunk);
      },
      flush() {
        pending += decoder.decode();
        validate(pending.replace(/\r$/u, ""));
      }
    })
  );
}

async function safeAcpCwd(workspacePath: string, configuredCwd?: string): Promise<string> {
  const workspaceRealPath = await realpath(workspacePath);
  if (!configuredCwd) return workspaceRealPath;
  if (isAbsolute(configuredCwd)) {
    throw new Error("ACP binding cwd must be relative to the attempt workspace.");
  }
  const candidate = await realpath(resolve(workspaceRealPath, configuredCwd));
  const relation = relative(workspaceRealPath, candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error("ACP binding cwd must stay inside the attempt workspace.");
  }
  if (!(await stat(candidate)).isDirectory()) {
    throw new Error("ACP binding cwd must resolve to a directory.");
  }
  return candidate;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

async function terminateChild(child: ChildProcessWithoutNullStreams, graceMs = CHILD_EXIT_GRACE_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  if (await waitForExit(child, graceMs)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, graceMs)) return;
  child.kill("SIGKILL");
  await waitForExit(child, graceMs);
}

async function emitSessionUpdate(
  sink: ExecutorEventSink,
  update: acp.SessionUpdate,
  output: string[]
): Promise<void> {
  const at = new Date().toISOString();
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text" && update.content.text.trim()) {
        output.push(update.content.text);
        await sink.emit({ type: "executor.progress", message: update.content.text, at });
      }
      return;
    case "tool_call":
      await sink.emit({
        type: "executor.progress",
        message: `Tool: ${safeToolTitle(update.title)}${update.status ? ` (${update.status})` : ""}`,
        at
      });
      return;
    case "tool_call_update":
      await sink.emit({
        type: "executor.progress",
        message: `Tool ${update.toolCallId} updated${update.status ? ` (${update.status})` : ""}`,
        at
      });
      return;
    case "plan": {
      const summary = update.entries.map((entry) => entry.content).join("; ");
      if (summary) await sink.emit({ type: "executor.progress", message: `Plan: ${summary}`, at });
      return;
    }
    default:
      return;
  }
}

function stopResult(input: {
  stopReason: acp.StopReason;
  manifest: NormalizedAcpManifest;
  run: ExecutorRunInput;
  branchName: string;
  baseBranch: string;
  output: string;
  files: string[];
}) {
  if (input.stopReason === "end_turn") {
    return createExecutorRunResult({
      executorName: input.manifest.label,
      runId: input.run.runId,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      output: input.output || `${input.manifest.label} completed without textual output.`,
      changedFiles: input.files
    });
  }
  if (input.stopReason === "cancelled") {
    return {
      conclusion: "cancelled" as const,
      summary: `${input.manifest.label} cancelled the ACP attempt.`,
      changedFiles: input.files,
      nextAction: "The durable Run may be resumed with a new Attempt."
    };
  }
  if (input.stopReason === "refusal") {
    return {
      conclusion: "needs_human" as const,
      summary: input.output || `${input.manifest.label} refused the ACP prompt.`,
      changedFiles: input.files,
      nextAction: "Review the request, policy, and available agent capabilities before retrying."
    };
  }
  return {
    conclusion: "interrupted" as const,
    summary: `${input.manifest.label} stopped the ACP attempt with reason ${input.stopReason}.`,
    changedFiles: input.files,
    nextAction: "Retry with a new Attempt if the Run still requires completion."
  };
}

export function createAcpExecutor(options: AcpExecutorOptions): ExecutorAdapter {
  const manifest = normalizeManifest(options.manifest);
  const runner = options.runner ?? nodeCommandRunner;
  const activeRuns = new Map<string, ActiveRun>();
  const cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;

  return {
    id: manifest.id,
    displayName: manifest.label,
    capability: {
      id: manifest.id,
      invocation: "spawn",
      supportsProfile: false,
      supportsStreaming: true,
      supportsCancel: true,
      supportsHookCompletion: false,
      progressEvents: "audit",
      approvalMode: "opentag_policy",
      contextAccess: ["context_packet", "context_pointers", "workspace"],
      promptAssembly: "opentag",
      writeAccess: "workspace",
      conversationAccess: "request",
      promptMutation: "none",
      rawContextAccess: false,
      writeActionAccess: "propose",
      workspaceIsolation: "worktree",
      sourceControl: "self_committing",
      requiredSecrets: [],
      completionSignals: [{ type: "stream_event", required: true, description: "ACP session/prompt stop response." }]
    },
    async canRun(input) {
      let workspace: ExecutorWorkspace;
      try {
        workspace = assertExplicitWorkspace(input);
      } catch (error) {
        return { ready: false, reason: error instanceof Error ? error.message : String(error) };
      }
      if (workspace.kind === "scratch") return { ready: true };
      const gitRepo = await runner.run("git", ["rev-parse", "--show-toplevel"], { cwd: workspace.path });
      if (gitRepo.exitCode !== 0) return { ready: false, reason: `Workspace is not a git checkout: ${gitRepo.stderr || gitRepo.stdout}` };
      const baseBranch = input.baseBranch ?? "main";
      const baseRef = await runner.run("git", ["rev-parse", "--verify", `${baseBranch}^{commit}`], { cwd: workspace.path });
      return baseRef.exitCode === 0
        ? { ready: true }
        : { ready: false, reason: `Base branch '${baseBranch}' is not available: ${baseRef.stderr || baseRef.stdout}` };
    },
    async run(input, sink) {
      const workspace = assertExplicitWorkspace(input);
      const activeKey = activeRunKey(input.runId, input.attemptId);
      if (activeRuns.has(activeKey)) throw new Error(`ACP attempt ${input.attemptId ?? input.runId} is already active.`);
      const active: ActiveRun = { runId: input.runId, ...(input.attemptId ? { attemptId: input.attemptId } : {}), cancelRequested: false };
      activeRuns.set(activeKey, active);
      const baseBranch = input.baseBranch ?? "main";
      const executionId = input.attemptId ? `${input.runId}-${input.attemptId}` : input.runId;
      const branchName = branchNameForRun(executionId);
      let executionPath = workspace.path;
      let repositoryCompleted = false;
      let worktreeCreated = false;
      let changedFileCount: number | undefined;
      try {
        if (workspace.kind === "repository") {
          executionPath = executionPathForAttempt({
            workspace,
            runId: input.runId,
            attemptId: input.attemptId ?? input.runId,
            ...(input.worktreeRoot ? { worktreeRoot: input.worktreeRoot } : {})
          });
          await sink.emit({
            type: "executor.started",
            message: `Creating isolated ACP worktree ${executionPath} on ${branchName}`,
            at: new Date().toISOString()
          });
          if (active.cancelRequested) {
            return stopResult({ stopReason: "cancelled", manifest, run: input, branchName, baseBranch, output: "", files: [] });
          }
          await createRunWorktree({ runner, workspacePath: workspace.path, worktreePath: executionPath, branchName, baseBranch });
          worktreeCreated = true;
        } else {
          await sink.emit({
            type: "executor.started",
            message: `Starting ACP agent ${manifest.id} in scratch workspace`,
            at: new Date().toISOString()
          });
        }

        if (active.cancelRequested) {
          return stopResult({ stopReason: "cancelled", manifest, run: input, branchName, baseBranch, output: "", files: [] });
        }
        const childCwd = await safeAcpCwd(executionPath, manifest.binding.cwd);
        if (active.cancelRequested) {
          return stopResult({ stopReason: "cancelled", manifest, run: input, branchName, baseBranch, output: "", files: [] });
        }
        const child = spawn(manifest.binding.command, manifest.binding.args, {
          cwd: childCwd,
          env: scrubEnvironment(),
          stdio: ["pipe", "pipe", "pipe"]
        });
        active.child = child;
        const stderrChunks: Buffer[] = [];
        let stderrBytes = 0;
        let spawnErrorCode: string | undefined;
        child.stderr.on("data", (chunk: Buffer | string) => {
          if (stderrBytes >= MAX_ACP_DIAGNOSTIC_BYTES) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const bounded = buffer.subarray(0, MAX_ACP_DIAGNOSTIC_BYTES - stderrBytes);
          stderrChunks.push(bounded);
          stderrBytes += bounded.length;
        });
        child.once("error", (error: NodeJS.ErrnoException) => {
          spawnErrorCode = error.code ?? "spawn_error";
        });
        if (active.cancelRequested) {
          await terminateChild(child, cancelGraceMs);
          return stopResult({ stopReason: "cancelled", manifest, run: input, branchName, baseBranch, output: "", files: [] });
        }

        const output: string[] = [];
        const governedActions = new Map<string, { resolution: ExecutorPermissionResolution; reported: boolean }>();
        const childOutput = strictAcpOutput(Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
        const stream = acp.ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          childOutput
        );
        let stopReason: acp.StopReason;
        try {
          stopReason = await acp
            .client({ name: "opentag" })
            .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
              const requestOptions = ctx.params.options.map((option) => ({
                optionId: option.optionId,
                name: option.name,
                kind: option.kind
              }));
              const governedResolver = input.permissionResolver;
              const target = structuredPermissionTarget(ctx.params.toolCall.rawInput, ctx.params.toolCall.kind);
              const request = {
                runId: input.runId,
                toolCall: {
                  toolCallId: ctx.params.toolCall.toolCallId,
                  title: safeToolTitle(ctx.params.toolCall.title ?? "Untitled tool call"),
                  ...(ctx.params.toolCall.kind ? { kind: ctx.params.toolCall.kind } : {}),
                  ...(ctx.params.toolCall.status ? { status: ctx.params.toolCall.status } : {}),
                  ...(target.targetFingerprint ? { targetFingerprint: target.targetFingerprint } : {})
                },
                options: requestOptions,
                permissionScopes: input.permissions?.map((permission) => permission.scope) ?? []
              };
              if (governedResolver) {
                const resolution = await governedResolver({
                  toolCallId: request.toolCall.toolCallId,
                  title: request.toolCall.title,
                  ...(request.toolCall.kind ? { kind: request.toolCall.kind } : {}),
                  provider: target.provider,
                  connectionId: target.connectionId,
                  operation: target.operation,
                  ...(target.resource ? { resource: target.resource } : {}),
                  ...(target.resourceVersion ? { resourceVersion: target.resourceVersion } : {}),
                  ...(target.targetConstraints ? { targetConstraints: target.targetConstraints } : {}),
                  ...(request.toolCall.targetFingerprint ? { targetFingerprint: request.toolCall.targetFingerprint } : {}),
                  permissionScopes: request.permissionScopes
                });
                if (resolution.decision !== "deny" && !resolution.reconciled && resolution.material) {
                  governedActions.set(request.toolCall.toolCallId, { resolution, reported: false });
                }
                if (resolution.reconciled) {
                  await sink.emit({
                    type: "executor.progress",
                    message: `Material action ${resolution.actionId} already has a durable receipt; skipping duplicate execution.`,
                    at: new Date().toISOString()
                  });
                }
                return permissionResponseForDecision({ decision: resolution.decision }, requestOptions);
              }
              if (!options.permissionResolver) return { outcome: { outcome: "cancelled" as const } };
              const decision = await options.permissionResolver(request);
              return permissionResponseForDecision(decision, requestOptions);
            })
            .connectWith(stream, async (client) => {
              active.client = client;
              const initialized = await client.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {}
              });
              if (initialized.protocolVersion !== 1) {
                throw new Error(`Agent negotiated unsupported ACP protocol version ${initialized.protocolVersion}.`);
              }
              return client.buildSession({ cwd: childCwd, mcpServers: [] }).withSession(async (session) => {
                active.sessionId = session.sessionId;
                if (active.cancelRequested) {
                  try {
                    await client.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
                  } catch {
                    // The cancellation path below still terminates the child.
                  }
                  return "cancelled";
                }
                void session.prompt(promptForRun(input));
                for (;;) {
                  const message = await session.nextUpdate();
                  if (message.kind === "stop") return message.stopReason;
                  await emitSessionUpdate(sink, message.update, output);
                  if (message.update.sessionUpdate === "tool_call_update") {
                    const governed = governedActions.get(message.update.toolCallId);
                    if (governed && !governed.reported && (message.update.status === "completed" || message.update.status === "failed")) {
                      try {
                        await input.materialActionReporter?.({
                          actionId: governed.resolution.actionId,
                          toolCallId: message.update.toolCallId,
                          provider: "acp",
                          receiptRef: `acp:${session.sessionId}:${message.update.toolCallId}`,
                          outcome: "unknown",
                          reportedOutcome: message.update.status
                        });
                        governed.reported = true;
                      } catch {
                        await sink.emit({
                          type: "executor.progress",
                          message: `Could not durably correlate material action ${governed.resolution.actionId}; retrying as unknown before session cleanup.`,
                          at: new Date().toISOString()
                        });
                      }
                    }
                  }
                }
              });
            });
        } catch (error) {
          if (active.cancelRequested) stopReason = "cancelled";
          else {
            await waitForExit(child, 100);
            const rawCause = error instanceof Error ? error.message : String(error);
            const reason = spawnErrorCode
              ? "spawn"
              : /invalid NDJSON|unsupported ACP protocol/iu.test(rawCause)
                ? "protocol"
                : child.exitCode !== null && child.exitCode !== 0
                  ? "exit"
                  : "transport";
            const stderr = safeDiagnosticFragment(Buffer.concat(stderrChunks).toString("utf8"));
            const cause = safeDiagnosticFragment(rawCause);
            await sink.emit({
              type: "executor.failed",
              message: [
                `ACP diagnostic (${reason})`,
                `command=${basename(manifest.binding.command)}`,
                ...(spawnErrorCode ? [`spawnCode=${spawnErrorCode}`] : []),
                ...(child.exitCode !== null ? [`exitCode=${child.exitCode}`] : []),
                ...(cause ? [`detail=${cause}`] : []),
                ...(stderr ? [`stderr=${stderr}`] : [])
              ].join("; "),
              at: new Date().toISOString()
            });
            throw new AcpPublicFailure(`ACP agent ${manifest.id} protocol or exit failure.`);
          }
        }

        await terminateChild(child);
        for (const [toolCallId, governed] of governedActions) {
          if (governed.reported) continue;
          governed.reported = true;
          await input.materialActionReporter?.({
            actionId: governed.resolution.actionId,
            toolCallId,
            provider: "acp",
            receiptRef: `acp:${active.sessionId ?? "unknown"}:${toolCallId}`,
            outcome: "unknown"
          });
        }

        if (workspace.kind === "repository" && stopReason === "end_turn") {
          const cleaned = await cleanupInternalArtifacts({ runner, workspacePath: executionPath });
          if (cleaned.length) {
            await sink.emit({
              type: "executor.progress",
              message: `Cleaned internal artifacts: ${cleaned.join(", ")}`,
              at: new Date().toISOString()
            });
          }
        }

        const files = workspace.kind === "repository" ? await changedFiles({ runner, workspacePath: executionPath }) : [];
        changedFileCount = files.length;
        if (workspace.kind === "repository" && stopReason === "end_turn" && files.length > 0) {
          await commitRunChanges({ runner, workspacePath: executionPath, message: `OpenTag run ${input.runId}` });
        }
        repositoryCompleted = stopReason === "end_turn";
        const result = stopResult({
          stopReason,
          manifest,
          run: input,
          branchName,
          baseBranch,
          output: output.join("\n").trim(),
          files
        });
        await sink.emit({
          type: result.conclusion === "success" ? "executor.completed" : "executor.failed",
          message: `${manifest.label} stopped with ${stopReason}`,
          at: new Date().toISOString()
        });
        return result;
      } catch (error) {
        if (!(error instanceof AcpPublicFailure)) {
          await sink.emit({
            type: "executor.failed",
            message: `ACP agent ${manifest.id} failed`,
            at: new Date().toISOString()
          });
        }
        throw error;
      } finally {
        activeRuns.delete(activeKey);
        if (active.child) await terminateChild(active.child);
        if (workspace.kind === "repository" && worktreeCreated) {
          const keepWorktree = input.keepWorktree ?? "on_failure";
          const shouldRemove = repositoryCompleted && keepWorktree !== "always";
          if (shouldRemove) {
            try {
              await removeRunWorktree({ runner, workspacePath: workspace.path, worktreePath: executionPath });
              if (repositoryCompleted && changedFileCount === 0) {
                await deleteRunBranch({ runner, workspacePath: workspace.path, branchName });
              }
            } catch (cleanupError) {
              await sink.emit({
                type: "executor.progress",
                message: `Could not clean up ACP worktree ${executionPath}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
                at: new Date().toISOString()
              });
            }
          }
        }
      }
    },
    async cancel(runId, attemptId) {
      const active = attemptId
        ? activeRuns.get(activeRunKey(runId, attemptId))
        : [...activeRuns.values()].find((candidate) => candidate.runId === runId);
      if (!active) return;
      active.cancelRequested = true;
      const child = active.child;
      if (!child) return;
      try {
        if (active.client && active.sessionId) {
          await active.client.notify(acp.methods.agent.session.cancel, { sessionId: active.sessionId });
        }
      } catch {
        // A broken ACP connection must not prevent forced child termination.
      } finally {
        if (!(await waitForExit(child, cancelGraceMs))) {
          await terminateChild(child, cancelGraceMs);
        }
      }
    }
  };
}
