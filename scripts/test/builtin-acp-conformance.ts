#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AcpAgentDefinition,
  builtInAcpAgentDefinitions,
  createAcpAgentExecutor,
  type ExecutorEventSink,
  type ExecutorRunInput
} from "../../packages/runner/src/index.js";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../..");
const hermesCommand = process.env.OPENTAG_HERMES_COMMAND?.trim() || "hermes";
const hermesProfile = process.env.OPENTAG_HERMES_PROFILE?.trim() || "opentag";
const openclawCommand = process.env.OPENTAG_OPENCLAW_COMMAND?.trim() || "openclaw";
const openclawProfile = process.env.OPENTAG_OPENCLAW_PROFILE?.trim();
const openclawGatewayUrl = process.env.OPENTAG_OPENCLAW_GATEWAY_URL?.trim();
const reportPath = process.env.OPENTAG_BUILTIN_ACP_CONFORMANCE_REPORT?.trim();
const keepFixtures = process.env.OPENTAG_BUILTIN_ACP_KEEP_FIXTURES === "true";
const quiet = process.env.OPENTAG_ACP_CONFORMANCE_QUIET === "true";
const runTimeoutMs = Number(process.env.OPENTAG_BUILTIN_ACP_RUN_TIMEOUT_MS || 180_000);
const cancelStartTimeoutMs = Number(process.env.OPENTAG_BUILTIN_ACP_CANCEL_START_TIMEOUT_MS || 120_000);
const cancelCleanupTimeoutMs = Number(process.env.OPENTAG_BUILTIN_ACP_CANCEL_CLEANUP_TIMEOUT_MS || 10_000);
const cancelSleepSeconds = 30;

type CaseId = "readiness" | "scratch-cwd" | "worktree-cwd" | "cancel-process-tree";

type CaseResult = {
  agent: string;
  case: CaseId;
  status: AcpConformanceStatus;
  durationMs: number;
  error?: string;
};

type Marker = {
  nonce: string;
  pwd: string;
};

const allCaseIds: CaseId[] = ["readiness", "scratch-cwd", "worktree-cwd", "cancel-process-tree"];
const selectedCaseIds = (process.env.OPENTAG_BUILTIN_ACP_CASES?.split(",") ?? allCaseIds)
  .map((value) => value.trim())
  .filter(Boolean);
const results: CaseResult[] = [];

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function selectedCases(): CaseId[] {
  for (const id of selectedCaseIds) {
    assert(allCaseIds.includes(id as CaseId), `Unknown built-in ACP conformance case '${id}'.`);
  }
  return selectedCaseIds as CaseId[];
}

function safeDiagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replaceAll(homedir(), "~")
    .replace(/\/var\/folders\/[^\s'"]+/gu, "<temp-path>");
}

const providerStatusPatterns = [
  /auth(?:entication|orization)? (?:is )?required/iu,
  /not (?:authenticated|logged in)/iu,
  /api[_ -]?key/iu,
  /credential/iu,
  /insufficient (?:credits|quota)/iu,
  /rate.?limit/iu,
  /billing/iu,
  /\bECONNREFUSED\b/u,
  /gateway .*?(?:not ready|unavailable|connection failed)/iu,
  /inference provider/iu,
  /error calling (?:the )?llm api/iu,
  /model .*?(?:not found|unavailable|unsupported)/iu,
  /profile .*?(?:does not exist|not found|not ready)/iu
];

export type AcpConformanceStatus = "passed" | "needs_setup" | "failed_conformance" | "not_applicable";

export function cancellationConformanceApplies(definition: {
  capabilities?: { supportsCancel?: boolean };
}): boolean {
  return definition.capabilities?.supportsCancel === true;
}

export function propagatedConformanceStatus(
  definition: { capabilities?: { supportsCancel?: boolean } },
  caseId: CaseId,
  status: Extract<AcpConformanceStatus, "needs_setup" | "failed_conformance">
): AcpConformanceStatus {
  if (caseId === "cancel-process-tree" && !cancellationConformanceApplies(definition)) {
    return "not_applicable";
  }
  return status;
}

export function classifyAcpConformanceFailure(
  error: unknown,
  executorDiagnostics: readonly string[] = []
): Extract<AcpConformanceStatus, "needs_setup" | "failed_conformance"> {
  const diagnostic = [error instanceof Error ? error.message : String(error), ...executorDiagnostics].join("\n");
  return providerStatusPatterns.some((pattern) => pattern.test(diagnostic)) ? "needs_setup" : "failed_conformance";
}

/** @deprecated Use classifyAcpConformanceFailure. */
export function classifyBuiltInAcpFailure(error: unknown): "provider_status" | "conformance" {
  return classifyAcpConformanceFailure(error) === "needs_setup" ? "provider_status" : "conformance";
}

function allConformanceTargets(): AcpAgentDefinition[] {
  return Object.values(builtInAcpAgentDefinitions({
    hermes: { command: hermesCommand, profile: hermesProfile },
    openclaw: {
      command: openclawCommand,
      ...(openclawProfile ? { profile: openclawProfile } : {}),
      ...(openclawGatewayUrl ? { gatewayUrl: openclawGatewayUrl } : {})
    }
  }));
}

function selectedTargets(): AcpAgentDefinition[] {
  const available = allConformanceTargets();
  const byId = new Map(available.map((target) => [target.id, target]));
  const requested = (process.env.OPENTAG_BUILTIN_ACP_AGENTS?.split(",") ?? available.map((target) => target.id))
    .map((value) => value.trim())
    .filter(Boolean);
  for (const id of requested) assert(byId.has(id), `Unknown ACP conformance agent '${id}'.`);
  return requested.map((id) => byId.get(id)!);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    killSignal: "SIGKILL"
  }).trim();
}

function initRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);
  git(path, ["config", "user.email", "opentag@example.test"]);
  git(path, ["config", "user.name", "OpenTag ACP Conformance"]);
  writeFileSync(join(path, "README.md"), "# Built-in ACP conformance fixture\n");
  git(path, ["add", "README.md"]);
  git(path, ["commit", "-m", "Initialize conformance fixture"]);
}

function runInput(runId: string, workspace: ExecutorRunInput["workspace"], rawText: string): ExecutorRunInput {
  return {
    runId,
    workspace,
    command: { rawText, intent: "run", args: {} },
    context: [],
    baseBranch: "main"
  };
}

function sink(agent: string, failureDiagnostics: string[] = []): ExecutorEventSink {
  return {
    async emit(event) {
      if (event.type === "executor.failed") failureDiagnostics.push(event.message);
      if (quiet && event.type === "executor.progress") return;
      process.stdout.write(`[${agent}] [${event.type}] ${event.message}\n`);
    }
  };
}

class ConformanceDeadlineError extends Error {}

export async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ConformanceDeadlineError(message)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedRun(
  agent: string,
  executor: ReturnType<typeof createAcpAgentExecutor>,
  input: ExecutorRunInput,
  failureDiagnostics: string[]
) {
  const running = executor.run(input, sink(agent, failureDiagnostics));
  try {
    return await withDeadline(running, runTimeoutMs, `${agent} run '${input.runId}' exceeded ${runTimeoutMs}ms.`);
  } catch (error) {
    if (!(error instanceof ConformanceDeadlineError)) throw error;
    void running.catch(() => undefined);
    await withDeadline(
      Promise.allSettled([executor.cancel(input.runId, input.attemptId), running]),
      cancelCleanupTimeoutMs,
      `${agent} run '${input.runId}' did not settle after cancellation.`
    ).catch(() => undefined);
    throw error;
  }
}

async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) fail(`Timed out waiting for tool marker ${path}.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) fail(`Cancelled tool process ${pid} is still alive.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function parseMarker(path: string): Marker {
  assert(existsSync(path), `Expected tool marker ${path}.`);
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Marker>;
  assert(typeof value.nonce === "string", `Marker ${path} has no string nonce.`);
  assert(typeof value.pwd === "string", `Marker ${path} has no string pwd.`);
  return value as Marker;
}

function assertMarker(path: string, nonce: string, expectedCwd: string): void {
  const marker = parseMarker(path);
  assert(marker.nonce === nonce, `Expected marker nonce '${nonce}', received '${marker.nonce}'.`);
  assert(realpathSync(marker.pwd) === realpathSync(expectedCwd), `Tool ran in '${marker.pwd}', expected '${expectedCwd}'.`);
}

async function runCase(
  agent: string,
  caseId: CaseId,
  test: (failureDiagnostics: string[]) => Promise<void>
): Promise<AcpConformanceStatus> {
  const startedAt = Date.now();
  const failureDiagnostics: string[] = [];
  process.stdout.write(`\n== ${agent}: ${caseId} ==\n`);
  try {
    await test(failureDiagnostics);
    const result: CaseResult = { agent, case: caseId, status: "passed", durationMs: Date.now() - startedAt };
    results.push(result);
    process.stdout.write(`PASS ${agent}: ${caseId} (${result.durationMs}ms)\n`);
    return "passed";
  } catch (error) {
    const status = classifyAcpConformanceFailure(error, failureDiagnostics);
    const result: CaseResult = {
      agent,
      case: caseId,
      status,
      durationMs: Date.now() - startedAt,
      error: safeDiagnostic(error)
    };
    results.push(result);
    process.stderr.write(`FAIL ${agent}: ${caseId} [${result.status}]: ${result.error}\n`);
    return status;
  }
}

function recordRemainingCases(
  agent: string,
  status: Extract<AcpConformanceStatus, "needs_setup" | "failed_conformance">,
  reason: string,
  definition?: AcpAgentDefinition
): void {
  for (const caseId of selectedCases().filter((id) => id !== "readiness")) {
    const propagatedStatus = definition ? propagatedConformanceStatus(definition, caseId, status) : status;
    results.push({
      agent,
      case: caseId,
      status: propagatedStatus,
      durationMs: 0,
      error: propagatedStatus === "not_applicable"
        ? "Agent declares best-effort cancellation; process-tree termination is not claimed."
        : reason
    });
  }
}

function writePrivateReport(path: string, content: string): void {
  const descriptor = openSync(path, "w", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}

function writeReport(ok: boolean): void {
  if (!reportPath) return;
  const absolute = resolve(repositoryRoot, reportPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writePrivateReport(
    absolute,
    `${JSON.stringify({
      ok,
      hermesProfile,
      summary: {
        passed: results.filter((result) => result.status === "passed").length,
        needsSetup: results.filter((result) => result.status === "needs_setup").length,
        conformanceFailures: results.filter((result) => result.status === "failed_conformance").length,
        notApplicable: results.filter((result) => result.status === "not_applicable").length
      },
      results
    }, null, 2)}\n`
  );
}

async function testAgent(definition: AcpAgentDefinition, root: string): Promise<void> {
  const agent = definition.id;
  const cases = selectedCases();
  const executor = () => createAcpAgentExecutor(definition, {
    cancelGraceMs: 3_000,
    permissionResolver: async () => ({ decision: "allow_once" })
  });
  const scratch = join(root, agent, "scratch");
  mkdirSync(scratch, { recursive: true });

  const ready = await runCase(agent, "readiness", async () => {
    const readiness = await executor().canRun(runInput(`conformance-readiness-${agent}`, { kind: "scratch", path: scratch }, "readiness"));
    assert(readiness.ready, readiness.reason || `${agent} did not pass ACP readiness.`);
  });
  if (ready !== "passed") {
    recordRemainingCases(agent, ready, "ACP readiness failed.", definition);
    return;
  }

  const scratchStatus = !cases.includes("scratch-cwd") ? "passed" : await runCase(agent, "scratch-cwd", async (failureDiagnostics) => {
    const nonce = `${agent}-${Date.now()}`;
    const markerName = `opentag-${agent}-scratch.json`;
    const sentinel = `OPENTAG_${agent.toUpperCase().replaceAll("-", "_")}_ACP_SCRATCH_OK`;
    const prompt = [
      `Use a real shell or file-writing tool to create ${markerName} in the current working directory.`,
      `Write valid JSON with exactly the keys nonce set to '${nonce}' and pwd set to the exact absolute output of pwd.`,
      "Do not change directories and do not use an absolute destination path.",
      `Verify the file, then include exactly ${sentinel} in the final response.`
    ].join(" ");
    const result = await boundedRun(
      agent,
      executor(),
      runInput(`conformance-${agent}-scratch`, { kind: "scratch", path: scratch }, prompt),
      failureDiagnostics
    );
    assert(result.conclusion === "success", `${agent} scratch run concluded '${result.conclusion}'.`);
    assert(result.summary.includes(sentinel), `${agent} scratch response omitted ${sentinel}.`);
    assertMarker(join(scratch, markerName), nonce, scratch);
  });
  if (scratchStatus !== "passed") {
    for (const caseId of cases.filter((id) => id === "worktree-cwd" || id === "cancel-process-tree")) {
      const propagatedStatus = propagatedConformanceStatus(definition, caseId, scratchStatus);
      results.push({
        agent,
        case: caseId,
        status: propagatedStatus,
        durationMs: 0,
        error: propagatedStatus === "not_applicable"
          ? "Agent declares best-effort cancellation; process-tree termination is not claimed."
          : "Scratch session failed."
      });
    }
    return;
  }

  if (cases.includes("worktree-cwd")) await runCase(agent, "worktree-cwd", async (failureDiagnostics) => {
    const repository = join(root, agent, "repository");
    const worktreeRoot = join(root, agent, "worktrees");
    const runId = `conformance-${agent}-worktree`;
    const worktree = join(worktreeRoot, runId);
    const markerName = `opentag-${agent}-worktree.json`;
    const nonce = `${agent}-worktree-${Date.now()}`;
    initRepository(repository);
    const prompt = [
      `Use a real shell or file-writing tool to create ${markerName} in the current working directory.`,
      `Write valid JSON with exactly the keys nonce set to '${nonce}' and pwd set to the exact absolute output of pwd.`,
      "Do not change directories and do not use an absolute destination path.",
      "Verify the file before completing."
    ].join(" ");
    const result = await boundedRun(
      agent,
      executor(),
      {
        ...runInput(runId, { kind: "repository", path: repository }, prompt),
        worktreeRoot,
        keepWorktree: "always"
      },
      failureDiagnostics
    );
    assert(result.conclusion === "success", `${agent} worktree run concluded '${result.conclusion}'.`);
    assertMarker(join(worktree, markerName), nonce, worktree);
    assert(!existsSync(join(repository, markerName)), `${agent} wrote the marker into the source checkout.`);
    assert(git(repository, ["status", "--short"]) === "", `${agent} changed the source checkout.`);
    assert(git(repository, ["show", `opentag/${runId}:${markerName}`]).includes(nonce), `${agent} worktree change was not committed.`);
  });

  if (cases.includes("cancel-process-tree") && process.platform === "win32") {
    results.push({
      agent,
      case: "cancel-process-tree",
      status: "not_applicable",
      durationMs: 0,
      error: "The process-tree conformance case currently requires POSIX process groups."
    });
  } else if (cases.includes("cancel-process-tree") && !cancellationConformanceApplies(definition)) {
    results.push({
      agent,
      case: "cancel-process-tree",
      status: "not_applicable",
      durationMs: 0,
      error: "Agent declares best-effort cancellation; process-tree termination is not claimed."
    });
  } else if (cases.includes("cancel-process-tree")) await runCase(agent, "cancel-process-tree", async (failureDiagnostics) => {
    const cancelScratch = join(root, agent, "cancel");
    mkdirSync(cancelScratch, { recursive: true });
    const shellPidName = "acp-shell.pid";
    const sleepPidName = "acp-sleep.pid";
    const startedName = "acp-cancel-started";
    const completedName = "acp-cancel-completed";
    const command = `sh -c 'echo $$ > ${shellPidName}; sleep ${cancelSleepSeconds} & child=$!; echo $child > ${sleepPidName}; touch ${startedName}; wait $child; touch ${completedName}'`;
    const prompt = [
      "Immediately use a real shell tool in the current working directory to run exactly this foreground command:",
      command,
      "Do not change directories, alter the command, or run it in the background."
    ].join(" ");
    const runId = `conformance-${agent}-cancel`;
    const runningExecutor = executor();
    const running = runningExecutor.run(
      runInput(runId, { kind: "scratch", path: cancelScratch }, prompt),
      sink(agent, failureDiagnostics)
    );
    let settled = false;
    try {
      const observation = await Promise.race([
        waitForPath(join(cancelScratch, startedName), cancelStartTimeoutMs).then(() => ({ kind: "started" }) as const),
        withDeadline(
          running,
          runTimeoutMs,
          `${agent} cancellation run '${runId}' exceeded ${runTimeoutMs}ms.`
        ).then((result) => ({ kind: "completed", result }) as const)
      ]);
      if (observation.kind === "completed") {
        fail(`${agent} cancellation run concluded '${observation.result.conclusion}' before the tool started.`);
      }
      const shellPid = Number(readFileSync(join(cancelScratch, shellPidName), "utf8").trim());
      const sleepPid = Number(readFileSync(join(cancelScratch, sleepPidName), "utf8").trim());
      assert(Number.isInteger(shellPid) && shellPid > 0, `${agent} did not record a valid shell pid.`);
      assert(Number.isInteger(sleepPid) && sleepPid > 0, `${agent} did not record a valid sleep pid.`);
      assert(processIsAlive(shellPid), `${agent} shell process exited before cancellation.`);
      assert(processIsAlive(sleepPid), `${agent} sleep process exited before cancellation.`);

      await withDeadline(
        runningExecutor.cancel(runId),
        cancelCleanupTimeoutMs,
        `${agent} cancellation request for '${runId}' did not settle.`
      );
      const result = await withDeadline(
        running,
        cancelCleanupTimeoutMs,
        `${agent} cancellation run '${runId}' did not settle after cancellation.`
      );
      settled = true;
      assert(result.conclusion === "cancelled", `${agent} cancelled run concluded '${result.conclusion}'.`);
      await Promise.all([waitForProcessExit(shellPid), waitForProcessExit(sleepPid)]);
      assert(!existsSync(join(cancelScratch, completedName)), `${agent} cancelled tool reached its completion marker.`);
    } finally {
      if (!settled) {
        void running.catch(() => undefined);
        await withDeadline(
          Promise.allSettled([runningExecutor.cancel(runId), running]),
          cancelCleanupTimeoutMs,
          `${agent} cancellation cleanup for '${runId}' did not settle.`
        ).catch(() => undefined);
      }
    }
  });
}

async function main(): Promise<void> {
  assert(Number.isFinite(runTimeoutMs) && runTimeoutMs > 0, "OPENTAG_BUILTIN_ACP_RUN_TIMEOUT_MS must be positive.");
  assert(Number.isFinite(cancelStartTimeoutMs) && cancelStartTimeoutMs > 0, "OPENTAG_BUILTIN_ACP_CANCEL_START_TIMEOUT_MS must be positive.");
  assert(Number.isFinite(cancelCleanupTimeoutMs) && cancelCleanupTimeoutMs > 0, "OPENTAG_BUILTIN_ACP_CANCEL_CLEANUP_TIMEOUT_MS must be positive.");
  const root = mkdtempSync(join(tmpdir(), "opentag-builtin-acp-conformance-"));
  try {
    for (const target of selectedTargets()) {
      await testAgent(target, root);
    }
    const ok = results.length > 0 && results.every((result) => result.status === "passed" || result.status === "not_applicable");
    writeReport(ok);
    assert(ok, `Built-in ACP conformance failed (${results.filter((result) => result.status === "passed").length}/${results.length} cases passed).`);
    process.stdout.write(`\nBuilt-in ACP conformance passed ${results.length}/${results.length} cases.\n`);
  } finally {
    if (keepFixtures) process.stdout.write(`Fixtures retained under ${root}\n`);
    else rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`Built-in ACP conformance failed: ${safeDiagnostic(error)}\n`);
    process.exitCode = 1;
  });
}
