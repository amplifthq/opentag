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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpExecutor, type ExecutorEventSink, type ExecutorRunInput } from "../../packages/runner/src/index.js";

const expectedVersion = process.env.OPENTAG_OPENCLAW_EXPECTED_VERSION?.trim() || "2026.7.1";
const openclawCommand = process.env.OPENTAG_OPENCLAW_COMMAND?.trim() || "openclaw";
const profile = process.env.OPENTAG_OPENCLAW_PROFILE?.trim() || "opentag-conformance";
const gatewayUrl = process.env.OPENTAG_OPENCLAW_GATEWAY_URL?.trim();
const reportPath = process.env.OPENTAG_OPENCLAW_CONFORMANCE_REPORT?.trim();
const keepFixtures = process.env.OPENTAG_OPENCLAW_KEEP_FIXTURES === "true";
const runTimeoutMs = Number(process.env.OPENTAG_OPENCLAW_RUN_TIMEOUT_MS || 180_000);
const cancelToolTimeoutMs = Number(process.env.OPENTAG_OPENCLAW_CANCEL_TOOL_TIMEOUT_MS || 120_000);
const commandTimeoutMs = 15_000;
const cancelSleepSeconds = 15;
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../..");

type CaseResult = {
  id: "worktree-cwd" | "scratch-cwd-session-isolation" | "cancel";
  status: "passed" | "failed";
  durationMs: number;
  error?: string;
};

type Marker = {
  nonce: string;
  pwd: string;
};

export type GatewaySession = {
  key: string;
  status?: string;
  hasActiveRun?: boolean;
  abortedLastRun?: boolean;
};

const results: CaseResult[] = [];

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function safeDiagnostic(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.replaceAll(homedir(), "~").replace(/\/var\/folders\/[^\s'"]+/gu, "<temp-path>");
}

export function parseOpenClawVersion(output: string): string | undefined {
  return /^OpenClaw\s+([^\s]+)/mu.exec(output.trim())?.[1];
}

export function newGatewaySessions(
  previous: Map<string, GatewaySession>,
  current: Map<string, GatewaySession>
): GatewaySession[] {
  return [...current.values()].filter((session) => !previous.has(session.key));
}

export function resolveConformanceReportPath(path: string): string {
  return resolve(repositoryRoot, path);
}

export function resolveDefaultWorkspacePath(workspace: string): string {
  try {
    return realpathSync(workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(workspace);
    throw error;
  }
}

export function runBoundedCommand(command: string, args: string[], timeoutMs: number, cwd?: string): string {
  return execFileSync(command, args, {
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL"
  }).trim();
}

function run(command: string, args: string[], cwd?: string): string {
  return runBoundedCommand(command, args, commandTimeoutMs, cwd);
}

function git(cwd: string, args: string[]): string {
  return run("git", args, cwd);
}

function initRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);
  git(path, ["config", "user.email", "opentag@example.test"]);
  git(path, ["config", "user.name", "OpenTag Conformance"]);
  writeFileSync(join(path, "README.md"), "# OpenClaw ACP conformance fixture\n");
  git(path, ["add", "README.md"]);
  git(path, ["commit", "-m", "Initialize conformance fixture"]);
}

function openClawArgs(...args: string[]): string[] {
  return ["--profile", profile, ...args];
}

function gatewayTargetArgs(): string[] {
  return gatewayUrl ? ["--url", gatewayUrl] : [];
}

function discoverDefaultWorkspace(): string {
  const configured = process.env.OPENTAG_OPENCLAW_DEFAULT_WORKSPACE?.trim();
  const workspace = configured || run(openclawCommand, openClawArgs("config", "get", "agents.defaults.workspace"));
  assert(isAbsolute(workspace), `OpenClaw default workspace must be absolute, received '${workspace}'.`);
  return resolveDefaultWorkspacePath(workspace);
}

function assertGatewayReady(): void {
  const status = JSON.parse(
    run(openclawCommand, openClawArgs("gateway", "status", "--json", ...gatewayTargetArgs()))
  ) as {
    gateway?: { version?: string };
    rpc?: { ok?: boolean; version?: string; server?: { version?: string } };
  };
  assert(status.rpc?.ok === true, `OpenClaw Gateway RPC is not ready for profile '${profile}'.`);
  const version = status.rpc.server?.version || status.rpc.version || status.gateway?.version;
  assert(version === expectedVersion, `Expected Gateway ${expectedVersion}, received '${version || "unknown"}'.`);
}

function gatewaySessions(): Map<string, GatewaySession> {
  const result = JSON.parse(
    run(
      openclawCommand,
      openClawArgs(
        "gateway",
        "call",
        "sessions.list",
        "--json",
        "--params",
        JSON.stringify({ limit: 100, includeDerivedTitles: false }),
        ...gatewayTargetArgs()
      )
    )
  ) as { sessions?: GatewaySession[] };
  assert(Array.isArray(result.sessions), "OpenClaw Gateway sessions.list did not return a sessions array.");
  return new Map(result.sessions.map((session) => [session.key, session]));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForNewGatewaySession(
  previous: Map<string, GatewaySession>,
  caseId: CaseResult["id"]
): Promise<{ current: Map<string, GatewaySession>; session: GatewaySession }> {
  const deadline = Date.now() + 10_000;
  do {
    const current = gatewaySessions();
    const added = newGatewaySessions(previous, current);
    assert(added.length <= 1, `${caseId} created ${added.length} Gateway sessions; expected exactly one disposable session.`);
    if (added.length === 1) {
      const session = added[0]!;
      assert(session.key.includes(":acp-bridge:"), `${caseId} did not create an isolated acp-bridge Gateway session.`);
      assert(session.hasActiveRun === false, `${caseId} left Gateway session '${session.key}' active.`);
      return { current, session };
    }
    await delay(250);
  } while (Date.now() < deadline);
  return fail(`${caseId} did not create a new observable Gateway session.`);
}

async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (existsSync(path)) return;
    await delay(100);
  } while (Date.now() < deadline);
  fail(`Timed out waiting for real tool marker ${path}.`);
}

function manifest() {
  return {
    protocol: "opentag.integration.v1" as const,
    id: "openclaw-acp",
    label: "OpenClaw ACP",
    bindings: {
      agent: {
        kind: "stdio" as const,
        command: openclawCommand,
        args: openClawArgs("acp", ...gatewayTargetArgs())
      }
    },
    roles: {
      agent: {
        protocol: "agent-client-protocol" as const,
        protocolVersion: 1 as const,
        binding: "agent",
        workspace: { sessionCwd: "required" as const }
      }
    },
    resources: {}
  };
}

function input(runId: string, workspace: ExecutorRunInput["workspace"], rawText: string): ExecutorRunInput {
  return {
    runId,
    workspace,
    command: { rawText, intent: "run", args: {} },
    context: [],
    baseBranch: "main"
  };
}

function parseMarker(path: string): Marker {
  assert(existsSync(path), `Expected the real agent tool to create ${path}.`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Marker>;
  assert(typeof parsed.nonce === "string", `Marker ${path} is missing a string nonce.`);
  assert(typeof parsed.pwd === "string", `Marker ${path} is missing a string pwd.`);
  return parsed as Marker;
}

export function defaultMarkersSafeToClean(markers: string[]): Set<string> {
  for (const marker of markers) {
    assert(!existsSync(marker), `Refusing to overwrite pre-existing marker ${marker}.`);
  }
  return new Set(markers);
}

function assertMarker(marker: Marker, expectedNonce: string, expectedCwd: string): void {
  assert(marker.nonce === expectedNonce, `Marker nonce mismatch: expected '${expectedNonce}', received '${marker.nonce}'.`);
  assert(realpathSync(marker.pwd) === realpathSync(expectedCwd), `Agent tool used '${marker.pwd}' instead of '${expectedCwd}'.`);
}

function progressSink(onMessage?: (message: string) => void): ExecutorEventSink {
  return {
    async emit(event) {
      process.stdout.write(`[${event.type}] ${event.message}\n`);
      onMessage?.(event.message);
    }
  };
}

async function boundedRun(
  executor: ReturnType<typeof createAcpExecutor>,
  runInput: ExecutorRunInput,
  sink: ExecutorEventSink
) {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void executor.cancel(runInput.runId, runInput.attemptId).catch(() => undefined);
  }, runTimeoutMs);
  try {
    const result = await executor.run(runInput, sink);
    assert(!timedOut, `OpenClaw ACP run '${runInput.runId}' exceeded ${runTimeoutMs}ms.`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function runCase<T extends CaseResult["id"]>(id: T, test: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  process.stdout.write(`\n== ${id} ==\n`);
  try {
    await test();
    const result: CaseResult = { id, status: "passed", durationMs: Date.now() - startedAt };
    results.push(result);
    process.stdout.write(`PASS ${id} (${result.durationMs}ms)\n`);
  } catch (error) {
    results.push({ id, status: "failed", durationMs: Date.now() - startedAt, error: safeDiagnostic(error) });
    throw error;
  }
}

export function writePrivateReport(path: string, content: string): void {
  const descriptor = openSync(path, "w", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}

function writeReport(ok: boolean, error?: string): void {
  if (!reportPath) return;
  const absolute = resolveConformanceReportPath(reportPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writePrivateReport(
    absolute,
    `${JSON.stringify(
      {
        ok,
        openclawVersion: expectedVersion,
        profile,
        gateway: gatewayUrl ? "explicit-target" : "profile-target",
        results,
        ...(error ? { error } : {})
      },
      null,
      2
    )}\n`
  );
}

async function main(): Promise<void> {
  results.length = 0;
  assert(Number.isFinite(runTimeoutMs) && runTimeoutMs > 0, "OPENTAG_OPENCLAW_RUN_TIMEOUT_MS must be positive.");
  assert(
    Number.isFinite(cancelToolTimeoutMs) && cancelToolTimeoutMs > 0,
    "OPENTAG_OPENCLAW_CANCEL_TOOL_TIMEOUT_MS must be positive."
  );

  const versionOutput = run(openclawCommand, ["--version"]);
  const version = parseOpenClawVersion(versionOutput);
  assert(version === expectedVersion, `Expected OpenClaw ${expectedVersion}, received '${version || versionOutput}'.`);
  assertGatewayReady();

  const defaultWorkspace = discoverDefaultWorkspace();
  const root = mkdtempSync(join(tmpdir(), "opentag-openclaw-conformance-"));
  const repository = join(root, "repository");
  const worktreeRoot = join(root, "worktrees");
  const scratch = join(root, "scratch");
  const cancelScratch = join(root, "cancel");
  const nonce = root.split("-").at(-1) || String(Date.now());
  const worktreeRunId = `openclaw-worktree-${nonce}`;
  const worktree = join(worktreeRoot, worktreeRunId);
  const worktreeMarkerName = `opentag-openclaw-worktree-${nonce}.json`;
  const scratchMarkerName = `opentag-openclaw-scratch-${nonce}.json`;
  const cancelStartedMarkerName = `opentag-openclaw-cancel-started-${nonce}`;
  const cancelCompletedMarkerName = `opentag-openclaw-cancel-completed-${nonce}`;
  const defaultMarker = (name: string) => join(defaultWorkspace, name);
  const defaultMarkers = [
    worktreeMarkerName,
    scratchMarkerName,
    cancelStartedMarkerName,
    cancelCompletedMarkerName
  ].map(defaultMarker);
  let defaultMarkersToClean = new Set<string>();
  try {
    let previousGatewaySessions = gatewaySessions();

    initRepository(repository);
    mkdirSync(scratch, { recursive: true });
    mkdirSync(cancelScratch, { recursive: true });
    defaultMarkersToClean = defaultMarkersSafeToClean(defaultMarkers);

    await runCase("worktree-cwd", async () => {
      const executor = createAcpExecutor({ manifest: manifest(), cancelGraceMs: 3_000 });
      const prompt = [
        `Use real shell and file-writing tools to create ${worktreeMarkerName} in the current working directory.`,
        `Write one-line valid JSON with exactly these keys: nonce set to '${nonce}', and pwd set to the exact absolute output of pwd.`,
        "Do not change directories and do not use an absolute destination path.",
        "Verify the file exists, then reply with exactly OPENTAG_OPENCLAW_WORKTREE_OK."
      ].join(" ");
      const runInput = {
        ...input(worktreeRunId, { kind: "repository", path: repository }, prompt),
        worktreeRoot,
        keepWorktree: "always" as const
      };
      const result = await boundedRun(executor, runInput, progressSink());

      assert(result.conclusion === "success", `Worktree run concluded '${result.conclusion}'.`);
      assertMarker(parseMarker(join(worktree, worktreeMarkerName)), nonce, worktree);
      assert(!existsSync(join(repository, worktreeMarkerName)), "Worktree marker leaked into the source checkout.");
      assert(git(repository, ["status", "--short"]) === "", "Source checkout changed during the worktree run.");
      assert(
        git(repository, ["show", `opentag/${worktreeRunId}:${worktreeMarkerName}`]).includes(nonce),
        "OpenTag did not commit the worktree marker on the isolated run branch."
      );
      assert(
        !existsSync(defaultMarker(worktreeMarkerName)),
        "OpenClaw wrote the worktree marker into its configured default workspace."
      );
      const observed = await waitForNewGatewaySession(previousGatewaySessions, "worktree-cwd");
      assert(
        observed.session.status === "done",
        `Worktree Gateway session stopped with '${observed.session.status || "unknown"}'.`
      );
      previousGatewaySessions = observed.current;
    });

    await runCase("scratch-cwd-session-isolation", async () => {
      const executor = createAcpExecutor({ manifest: manifest(), cancelGraceMs: 3_000 });
      const prompt = [
        `Use real shell and file-writing tools to create ${scratchMarkerName} in the current working directory.`,
        `Write one-line valid JSON with exactly these keys: nonce set to '${nonce}-scratch', and pwd set to the exact absolute output of pwd.`,
        "Do not change directories and do not use an absolute destination path.",
        "Verify the file exists, then reply with exactly OPENTAG_OPENCLAW_SCRATCH_OK."
      ].join(" ");
      const result = await boundedRun(
        executor,
        input(`openclaw-scratch-${nonce}`, { kind: "scratch", path: scratch }, prompt),
        progressSink()
      );
      const marker = parseMarker(join(scratch, scratchMarkerName));

      assert(result.conclusion === "success", `Scratch run concluded '${result.conclusion}'.`);
      assertMarker(marker, `${nonce}-scratch`, scratch);
      assert(
        !existsSync(defaultMarker(scratchMarkerName)),
        "OpenClaw wrote the scratch marker into its configured default workspace."
      );
      const observed = await waitForNewGatewaySession(previousGatewaySessions, "scratch-cwd-session-isolation");
      assert(
        observed.session.status === "done",
        `Scratch Gateway session stopped with '${observed.session.status || "unknown"}'.`
      );
      previousGatewaySessions = observed.current;
    });

    await runCase("cancel", async () => {
      const executor = createAcpExecutor({ manifest: manifest(), cancelGraceMs: 3_000 });
      const prompt = [
        "Immediately use a real shell tool in the current working directory to run exactly this command:",
        `touch ${cancelStartedMarkerName} && sleep ${cancelSleepSeconds} && touch ${cancelCompletedMarkerName}`,
        "Do not change directories and do not run the command in the background."
      ].join(" ");
      const runId = `openclaw-cancel-${nonce}`;
      const running = executor.run(input(runId, { kind: "scratch", path: cancelScratch }, prompt), progressSink());
      let runSettled = false;
      try {
        const observation = await Promise.race([
          waitForPath(join(cancelScratch, cancelStartedMarkerName), cancelToolTimeoutMs).then(
            () => ({ kind: "started" }) as const
          ),
          running.then((result) => ({ kind: "completed", result }) as const)
        ]);
        if (observation.kind === "completed") {
          fail(`OpenClaw cancellation run concluded '${observation.result.conclusion}' before its shell start marker appeared.`);
        }
        await executor.cancel(runId);
        const result = await running;
        runSettled = true;

        assert(result.conclusion === "cancelled", `Cancelled run concluded '${result.conclusion}'.`);
        const observed = await waitForNewGatewaySession(previousGatewaySessions, "cancel");
        assert(
          observed.session.status === "killed",
          `Cancelled Gateway session stopped with '${observed.session.status || "unknown"}'.`
        );
        assert(observed.session.abortedLastRun === true, "Cancelled Gateway session did not record an aborted run.");
        previousGatewaySessions = observed.current;
        await delay((cancelSleepSeconds + 2) * 1_000);
        assert(
          !existsSync(join(cancelScratch, cancelCompletedMarkerName)),
          "Cancelled OpenClaw tool continued through its completion marker."
        );
        assert(
          !existsSync(defaultMarker(cancelStartedMarkerName)),
          "Cancelled OpenClaw run started in its configured default workspace."
        );
        assert(
          !existsSync(defaultMarker(cancelCompletedMarkerName)),
          "Cancelled OpenClaw run completed in its configured default workspace."
        );
      } finally {
        if (!runSettled) {
          await executor.cancel(runId).catch(() => undefined);
          await running.catch(() => undefined);
        }
      }
    });

    writeReport(true);
    process.stdout.write(`\nOpenClaw ACP conformance passed ${results.length}/${results.length} cases.\n`);
  } finally {
    for (const marker of defaultMarkersToClean) rmSync(marker, { force: true });
    if (!keepFixtures) {
      if (existsSync(worktree)) {
        try {
          git(repository, ["worktree", "remove", "--force", worktree]);
        } catch {
          // The temporary root removal below is still bounded to this fixture.
        }
      }
      rmSync(root, { recursive: true, force: true });
    } else {
      process.stdout.write(`Fixtures retained under ${root}\n`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    const redacted = safeDiagnostic(error);
    writeReport(false, redacted);
    process.stderr.write(`OpenClaw ACP conformance failed: ${redacted}\n`);
    process.exitCode = 1;
  });
}
