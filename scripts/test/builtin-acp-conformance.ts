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
  builtInAcpAgentManifests,
  createAcpExecutor,
  type BuiltInAcpAgentId,
  type ExecutorEventSink,
  type ExecutorRunInput
} from "../../packages/runner/src/index.js";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../..");
const hermesCommand = process.env.OPENTAG_HERMES_COMMAND?.trim() || "hermes";
const hermesProfile = process.env.OPENTAG_HERMES_PROFILE?.trim() || "opentag";
const reportPath = process.env.OPENTAG_BUILTIN_ACP_CONFORMANCE_REPORT?.trim();
const keepFixtures = process.env.OPENTAG_BUILTIN_ACP_KEEP_FIXTURES === "true";
const runTimeoutMs = Number(process.env.OPENTAG_BUILTIN_ACP_RUN_TIMEOUT_MS || 180_000);
const cancelStartTimeoutMs = Number(process.env.OPENTAG_BUILTIN_ACP_CANCEL_START_TIMEOUT_MS || 120_000);
const cancelSleepSeconds = 30;

type CaseId = "readiness" | "scratch-cwd" | "worktree-cwd" | "cancel-process-tree";

type CaseResult = {
  agent: BuiltInAcpAgentId;
  case: CaseId;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  failureKind?: "provider_status" | "conformance";
  error?: string;
};

type Marker = {
  nonce: string;
  pwd: string;
};

const allAgentIds: BuiltInAcpAgentId[] = ["codex", "claude-code", "hermes"];
const selectedAgentIds = (process.env.OPENTAG_BUILTIN_ACP_AGENTS?.split(",") ?? allAgentIds)
  .map((value) => value.trim())
  .filter(Boolean);
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

function selectedAgents(): BuiltInAcpAgentId[] {
  for (const id of selectedAgentIds) {
    assert(allAgentIds.includes(id as BuiltInAcpAgentId), `Unknown built-in ACP agent '${id}'.`);
  }
  return selectedAgentIds as BuiltInAcpAgentId[];
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
  /inference provider/iu,
  /error calling (?:the )?llm api/iu,
  /model .*?(?:not found|unavailable|unsupported)/iu
];

export function classifyBuiltInAcpFailure(error: unknown): "provider_status" | "conformance" {
  const diagnostic = error instanceof Error ? error.message : String(error);
  return providerStatusPatterns.some((pattern) => pattern.test(diagnostic)) ? "provider_status" : "conformance";
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

function sink(agent: BuiltInAcpAgentId): ExecutorEventSink {
  return {
    async emit(event) {
      process.stdout.write(`[${agent}] [${event.type}] ${event.message}\n`);
    }
  };
}

async function boundedRun(
  agent: BuiltInAcpAgentId,
  executor: ReturnType<typeof createAcpExecutor>,
  input: ExecutorRunInput
) {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void executor.cancel(input.runId, input.attemptId).catch(() => undefined);
  }, runTimeoutMs);
  try {
    const result = await executor.run(input, sink(agent));
    assert(!timedOut, `${agent} run '${input.runId}' exceeded ${runTimeoutMs}ms.`);
    return result;
  } finally {
    clearTimeout(timer);
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

async function runCase(agent: BuiltInAcpAgentId, caseId: CaseId, test: () => Promise<void>): Promise<boolean> {
  const startedAt = Date.now();
  process.stdout.write(`\n== ${agent}: ${caseId} ==\n`);
  try {
    await test();
    const result: CaseResult = { agent, case: caseId, status: "passed", durationMs: Date.now() - startedAt };
    results.push(result);
    process.stdout.write(`PASS ${agent}: ${caseId} (${result.durationMs}ms)\n`);
    return true;
  } catch (error) {
    const result: CaseResult = {
      agent,
      case: caseId,
      status: "failed",
      durationMs: Date.now() - startedAt,
      failureKind: classifyBuiltInAcpFailure(error),
      error: safeDiagnostic(error)
    };
    results.push(result);
    process.stderr.write(`FAIL ${agent}: ${caseId} [${result.failureKind}]: ${result.error}\n`);
    return false;
  }
}

function skipRemainingCases(agent: BuiltInAcpAgentId, reason: string): void {
  for (const caseId of selectedCases().filter((id) => id !== "readiness")) {
    results.push({ agent, case: caseId, status: "skipped", durationMs: 0, error: reason });
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
        providerStatusFailures: results.filter((result) => result.failureKind === "provider_status").length,
        conformanceFailures: results.filter((result) => result.failureKind === "conformance").length,
        skipped: results.filter((result) => result.status === "skipped").length
      },
      results
    }, null, 2)}\n`
  );
}

async function testAgent(agent: BuiltInAcpAgentId, root: string): Promise<void> {
  const cases = selectedCases();
  const manifests = builtInAcpAgentManifests({ hermes: { command: hermesCommand, profile: hermesProfile } });
  const executor = () => createAcpExecutor({
    manifest: manifests[agent],
    cancelGraceMs: 3_000,
    ...(agent === "claude-code" ? { sessionModeId: "default" } : {}),
    permissionResolver: async () => ({ decision: "allow_once" })
  });
  const scratch = join(root, agent, "scratch");
  mkdirSync(scratch, { recursive: true });

  const ready = await runCase(agent, "readiness", async () => {
    const readiness = await executor().canRun(runInput(`conformance-readiness-${agent}`, { kind: "scratch", path: scratch }, "readiness"));
    assert(readiness.ready, readiness.reason || `${agent} did not pass ACP readiness.`);
  });
  if (!ready) {
    skipRemainingCases(agent, "ACP readiness failed.");
    return;
  }

  const scratchPassed = !cases.includes("scratch-cwd") || await runCase(agent, "scratch-cwd", async () => {
    const nonce = `${agent}-${Date.now()}`;
    const markerName = `opentag-${agent}-scratch.json`;
    const sentinel = `OPENTAG_${agent.toUpperCase().replaceAll("-", "_")}_ACP_SCRATCH_OK`;
    const prompt = [
      `Use a real shell or file-writing tool to create ${markerName} in the current working directory.`,
      `Write valid JSON with exactly the keys nonce set to '${nonce}' and pwd set to the exact absolute output of pwd.`,
      "Do not change directories and do not use an absolute destination path.",
      `Verify the file, then include exactly ${sentinel} in the final response.`
    ].join(" ");
    const result = await boundedRun(agent, executor(), runInput(`conformance-${agent}-scratch`, { kind: "scratch", path: scratch }, prompt));
    assert(result.conclusion === "success", `${agent} scratch run concluded '${result.conclusion}'.`);
    assert(result.summary.includes(sentinel), `${agent} scratch response omitted ${sentinel}.`);
    assertMarker(join(scratch, markerName), nonce, scratch);
  });
  if (!scratchPassed) {
    for (const caseId of cases.filter((id) => id === "worktree-cwd" || id === "cancel-process-tree")) {
      results.push({ agent, case: caseId, status: "skipped", durationMs: 0, error: "Scratch session failed." });
    }
    return;
  }

  if (cases.includes("worktree-cwd")) await runCase(agent, "worktree-cwd", async () => {
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
    const result = await boundedRun(agent, executor(), {
      ...runInput(runId, { kind: "repository", path: repository }, prompt),
      worktreeRoot,
      keepWorktree: "always"
    });
    assert(result.conclusion === "success", `${agent} worktree run concluded '${result.conclusion}'.`);
    assertMarker(join(worktree, markerName), nonce, worktree);
    assert(!existsSync(join(repository, markerName)), `${agent} wrote the marker into the source checkout.`);
    assert(git(repository, ["status", "--short"]) === "", `${agent} changed the source checkout.`);
    assert(git(repository, ["show", `opentag/${runId}:${markerName}`]).includes(nonce), `${agent} worktree change was not committed.`);
  });

  if (cases.includes("cancel-process-tree")) await runCase(agent, "cancel-process-tree", async () => {
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
    const running = runningExecutor.run(runInput(runId, { kind: "scratch", path: cancelScratch }, prompt), sink(agent));
    let settled = false;
    const safetyTimer = setTimeout(() => void runningExecutor.cancel(runId).catch(() => undefined), runTimeoutMs);
    try {
      const observation = await Promise.race([
        waitForPath(join(cancelScratch, startedName), cancelStartTimeoutMs).then(() => ({ kind: "started" }) as const),
        running.then((result) => ({ kind: "completed", result }) as const)
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

      await runningExecutor.cancel(runId);
      const result = await running;
      settled = true;
      assert(result.conclusion === "cancelled", `${agent} cancelled run concluded '${result.conclusion}'.`);
      await Promise.all([waitForProcessExit(shellPid), waitForProcessExit(sleepPid)]);
      assert(!existsSync(join(cancelScratch, completedName)), `${agent} cancelled tool reached its completion marker.`);
    } finally {
      clearTimeout(safetyTimer);
      if (!settled) {
        await runningExecutor.cancel(runId).catch(() => undefined);
        await running.catch(() => undefined);
      }
    }
  });
}

async function main(): Promise<void> {
  assert(Number.isFinite(runTimeoutMs) && runTimeoutMs > 0, "OPENTAG_BUILTIN_ACP_RUN_TIMEOUT_MS must be positive.");
  assert(Number.isFinite(cancelStartTimeoutMs) && cancelStartTimeoutMs > 0, "OPENTAG_BUILTIN_ACP_CANCEL_START_TIMEOUT_MS must be positive.");
  const root = mkdtempSync(join(tmpdir(), "opentag-builtin-acp-conformance-"));
  try {
    for (const agent of selectedAgents()) await testAgent(agent, root);
    const ok = results.length > 0 && results.every((result) => result.status === "passed");
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
