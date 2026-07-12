import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpExecutor, type AcpPermissionResolver } from "../src/acp-executor.js";

const fixture = fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url));
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `opentag-acp-${name}-`));
  tempRoots.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(): string {
  const repo = tempDir("repo");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "opentag@example.test"]);
  git(repo, ["config", "user.name", "OpenTag Test"]);
  writeFileSync(join(repo, "README.md"), "# ACP test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function manifest(mode = "success") {
  return {
    protocol: "opentag.integration.v1" as const,
    id: "fixture-agent",
    label: "Fixture ACP Agent",
    bindings: {
      agent: {
        kind: "stdio" as const,
        command: process.execPath,
        args: [fixture],
        env: { OPENTAG_ACP_TEST_MODE: mode }
      }
    },
    roles: {
      agent: {
        protocol: "agent-client-protocol" as const,
        protocolVersion: 1 as const,
        binding: "agent"
      }
    },
    resources: {}
  };
}

function manifestWithCwd(cwd: string, mode = "success") {
  const configured = manifest(mode);
  return {
    ...configured,
    bindings: {
      agent: {
        ...configured.bindings.agent,
        cwd
      }
    }
  };
}

function permissionManifest(env: Record<string, string>) {
  const configured = manifest("permission");
  return {
    ...configured,
    bindings: {
      agent: {
        ...configured.bindings.agent,
        env: { ...configured.bindings.agent.env, ...env }
      }
    }
  };
}

function input(workspace: { kind: "repository" | "scratch"; path: string }, runId = "run_acp") {
  return {
    runId,
    workspace,
    command: { rawText: "prepare the report", intent: "run" as const, args: {} },
    context: [{ kind: "file", uri: "README.md", visibility: "private" as const, title: "Readme" }],
    contextPacket: {
      summary: "Only the selected readme is relevant.",
      sources: [
        {
          pointer: { kind: "file", uri: "README.md", visibility: "private" as const },
          role: "primary" as const,
          reason: "Explicitly selected"
        }
      ],
      exclusions: ["Do not inspect .env files"]
    },
    permissions: [{ scope: "github.repository.read", reason: "Read the selected repository" }],
    baseBranch: "main",
    keepWorktree: "never" as const
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("ACP executor", () => {
  it("streams normalized plan, tool, and message updates and commits repository changes", async () => {
    const repo = initRepo();
    const executor = createAcpExecutor({ manifest: manifest() });
    const events: string[] = [];

    const result = await executor.run(input({ kind: "repository", path: repo }), {
      emit: async (event) => void events.push(`${event.type}:${event.message}`)
    });

    expect(events.some((event) => event.includes("Plan: Complete the OpenTag run"))).toBe(true);
    expect(events.some((event) => event.includes("Tool: Write ACP output"))).toBe(true);
    expect(events.some((event) => event.includes("ACP fixture completed"))).toBe(true);
    expect(events.every((event) => !event.includes('"jsonrpc"'))).toBe(true);
    expect(result.conclusion).toBe("success");
    expect(result.changedFiles).toEqual(["acp-output.txt", "acp-prompt.json", "acp-session.json"]);
    expect(git(repo, ["show", "opentag/run_acp:acp-output.txt"])).toContain("ACP fixture");
    const prompt = JSON.parse(git(repo, ["show", "opentag/run_acp:acp-prompt.json"]));
    expect(prompt.text).toContain("prepare the report");
    expect(prompt.text).toContain("Do not inspect .env files");
    expect(prompt.text).toContain("github.repository.read");
    expect(prompt.text).not.toContain("Read the selected repository");
  }, 15_000);

  it("maps allow-once approval to the matching ACP option", async () => {
    const scratch = tempDir("allow");
    const resolver: AcpPermissionResolver = async (request) => {
      expect(request.toolCall.title).toBe("Publish report");
      expect(request.options.map((option) => option.kind)).toContain("allow_once");
      return { decision: "allow_once" };
    };
    const executor = createAcpExecutor({ manifest: manifest("permission"), permissionResolver: resolver });

    await executor.run(input({ kind: "scratch", path: scratch }, "run_allow"), { emit: async () => undefined });

    expect(JSON.parse(readFileSync(join(scratch, "acp-permission.json"), "utf8"))).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" }
    });
  }, 15_000);

  it("never selects an allow option when OpenTag denies permission", async () => {
    const scratch = tempDir("deny");
    const executor = createAcpExecutor({
      manifest: manifest("permission"),
      permissionResolver: async () => ({ decision: "deny" })
    });

    await executor.run(input({ kind: "scratch", path: scratch }, "run_deny"), { emit: async () => undefined });

    expect(JSON.parse(readFileSync(join(scratch, "acp-permission.json"), "utf8"))).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" }
    });
  }, 15_000);

  it("pauses on the governed resolver and records an unverified ACP material outcome as unknown", async () => {
    const scratch = tempDir("governed");
    const reports: Array<{ actionId: string; outcome: string; receiptRef: string }> = [];
    const executor = createAcpExecutor({ manifest: manifest("permission") });

    await executor.run({
      ...input({ kind: "scratch", path: scratch }, "run_governed"),
      permissionResolver: async (request) => {
        expect(request).toMatchObject({
          toolCallId: "material-1",
          title: "Publish report",
          provider: "npm",
          targetFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
        });
        expect(JSON.stringify(request)).not.toContain("fixture-secret-token");
        return { actionId: "action_publish", decision: "allow_once", material: true };
      },
      materialActionReporter: async (report) => void reports.push(report)
    }, { emit: async () => undefined });

    expect(JSON.parse(readFileSync(join(scratch, "acp-permission.json"), "utf8"))).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" }
    });
    expect(reports).toEqual([
      expect.objectContaining({ actionId: "action_publish", outcome: "unknown", receiptRef: expect.stringContaining("material-1") })
    ]);
  }, 15_000);

  it("removes credential values from ACP target identity while retaining structured resource changes", async () => {
    const requests: Array<{ provider?: string; targetFingerprint?: string; connectionId?: string; operation?: string; resource?: string; resourceVersion?: string }> = [];
    for (const [index, env] of [
      { OPENTAG_ACP_TEST_SECRET: "secret-one", OPENTAG_ACP_TEST_RESOURCE: "@acme/report" },
      { OPENTAG_ACP_TEST_SECRET: "secret-two", OPENTAG_ACP_TEST_RESOURCE: "@acme/report" },
      { OPENTAG_ACP_TEST_SECRET: "secret-two", OPENTAG_ACP_TEST_RESOURCE: "@acme/other" }
    ].entries()) {
      const executor = createAcpExecutor({ manifest: permissionManifest(env) });
      await executor.run({
        ...input({ kind: "scratch", path: tempDir(`safe-target-${index}`) }, `run_safe_target_${index}`),
        permissionResolver: async (request) => {
          requests.push(request);
          return { actionId: `action_${index}`, decision: "allow_once", material: true };
        }
      }, { emit: async () => undefined });
    }

    expect(requests[0]).toMatchObject({
      provider: "npm",
      connectionId: "npm:team",
      operation: "execute",
      resource: "@acme/report",
      resourceVersion: "next"
    });
    expect(requests[0]?.targetFingerprint).toBe(requests[1]?.targetFingerprint);
    expect(requests[2]?.targetFingerprint).not.toBe(requests[1]?.targetFingerprint);
    expect(JSON.stringify(requests)).not.toContain("secret-one");
    expect(JSON.stringify(requests)).not.toContain("secret-two");
  }, 15_000);

  it("fingerprints generic ACP version, environment, force, visibility, and provider constraints exactly", async () => {
    const fingerprints: string[] = [];
    const variants: Array<Record<string, string>> = [
      {},
      { OPENTAG_ACP_TEST_VERSION: "stable" },
      { OPENTAG_ACP_TEST_ENVIRONMENT: "production" },
      { OPENTAG_ACP_TEST_FORCE: "true" },
      { OPENTAG_ACP_TEST_VISIBILITY: "public" },
      { OPENTAG_ACP_TEST_PROVIDER: "registry" }
    ];
    for (const [index, env] of variants.entries()) {
      const executor = createAcpExecutor({ manifest: permissionManifest(env) });
      await executor.run({
        ...input({ kind: "scratch", path: tempDir(`exact-generic-scope-${index}`) }, `run_exact_generic_scope_${index}`),
        permissionResolver: async (request) => {
          fingerprints.push(request.targetFingerprint!);
          return { actionId: `action_exact_${index}`, decision: "allow_once", material: true };
        }
      }, { emit: async () => undefined });
    }
    expect(new Set(fingerprints)).toHaveLength(variants.length);
  }, 20_000);

  it("normalizes URL resources and bounds structured target labels before policy or presentation", async () => {
    let captured: Record<string, unknown> | undefined;
    const executor = createAcpExecutor({ manifest: permissionManifest({
      OPENTAG_ACP_TEST_RESOURCE: `https://user:password@example.test/reports/latest?access_token=secret#credential=${"x".repeat(600)}`,
      OPENTAG_ACP_TEST_CONNECTION: `npm:team\n${"x".repeat(300)}`,
      OPENTAG_ACP_TEST_VERSION: `next\t${"y".repeat(300)}`
    }) });
    await executor.run({
      ...input({ kind: "scratch", path: tempDir("safe-url-target") }, "run_safe_url_target"),
      permissionResolver: async (request) => {
        captured = request;
        return { actionId: "action_safe_url", decision: "allow_once", material: true };
      }
    }, { emit: async () => undefined });

    expect(captured).toMatchObject({ provider: "npm", resource: "https://example.test/reports/latest" });
    expect(String(captured?.["connectionId"])).not.toMatch(/[\r\n]/u);
    expect(String(captured?.["connectionId"]).length).toBeLessThanOrEqual(128);
    expect(String(captured?.["resourceVersion"])).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(String(captured?.["resourceVersion"]).length).toBeLessThanOrEqual(128);
    expect(JSON.stringify(captured)).not.toContain("access_token");
    expect(JSON.stringify(captured)).not.toContain("password");
    expect(JSON.stringify(captured)).not.toContain("credential=");
  }, 15_000);

  it.each([
    ["ssh", "ssh://git:password@example.test/acme/report.git?token=secret#credential", "ssh://example.test/acme/report.git"],
    ["git+https", "git+https://user:password@example.test/acme/report.git?signature=secret#token", "git+https://example.test/acme/report.git"],
    ["signed https", "https://example.test/acme/report.git?X-Amz-Signature=secret&X-Amz-Credential=private", "https://example.test/acme/report.git"],
    ["ftp", "ftp://user:password@example.test/acme/report.git?token=secret", undefined],
    ["token path", "https://example.test/acme/token=secret/report.git", undefined]
  ])("sanitizes or rejects %s resource URLs before identity and presentation", async (_label, resource, expected) => {
    let captured: Record<string, unknown> | undefined;
    const executor = createAcpExecutor({ manifest: permissionManifest({ OPENTAG_ACP_TEST_RESOURCE: resource }) });
    await executor.run({
      ...input({ kind: "scratch", path: tempDir(`safe-scheme-${_label}`) }, `run_safe_scheme_${_label}`),
      permissionResolver: async (request) => {
        captured = request;
        return { actionId: `action_${_label}`, decision: "allow_once", material: true };
      }
    }, { emit: async () => undefined });
    expect(captured?.["resource"]).toBe(expected);
    expect(captured?.["targetFingerprint"]).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(captured)).not.toMatch(/password|token=|signature=|credential=|secret/iu);
  }, 15_000);

  it("redacts credential-like tool titles before progress or durable permission paths", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const progress: string[] = [];
    const executor = createAcpExecutor({ manifest: permissionManifest({
      OPENTAG_ACP_TEST_TOOL_TITLE: "Write with password=hunter2",
      OPENTAG_ACP_TEST_PERMISSION_TITLE: "Publish with token=fixture-secret"
    }) });
    await executor.run({
      ...input({ kind: "scratch", path: tempDir("safe-title") }, "run_safe_title"),
      permissionResolver: async (request) => {
        requests.push(request);
        return { actionId: "action_safe_title", decision: "allow_once", material: true };
      }
    }, { emit: async (update) => void progress.push(update.message) });
    expect(requests[0]?.["title"]).toBe("Sensitive tool action");
    expect(JSON.stringify({ requests, progress })).not.toMatch(/hunter2|fixture-secret|password=|token=/iu);
  }, 15_000);

  it("fails the Attempt after both durable unknown-report attempts fail", async () => {
    let reportAttempts = 0;
    const executor = createAcpExecutor({ manifest: manifest("permission") });
    await expect(executor.run({
      ...input({ kind: "scratch", path: tempDir("report-failure") }, "run_report_failure"),
      permissionResolver: async () => ({ actionId: "action_report_failure", decision: "allow_once", material: true }),
      materialActionReporter: async () => {
        reportAttempts += 1;
        throw new Error("dispatcher unavailable");
      }
    }, { emit: async () => undefined })).rejects.toThrow("dispatcher unavailable");
    expect(reportAttempts).toBe(2);
  }, 15_000);

  it("rejects a reconciled known-success permission so the ACP tool cannot execute twice", async () => {
    const scratch = tempDir("reconciled");
    const reports: unknown[] = [];
    const executor = createAcpExecutor({ manifest: manifest("permission") });

    await executor.run({
      ...input({ kind: "scratch", path: scratch }, "run_reconciled"),
      permissionResolver: async () => ({
        actionId: "action_publish",
        decision: "deny",
        reconciled: true,
        material: true,
        receipt: { receiptRef: "npm:publish:pkg@1", outcome: "succeeded" }
      }),
      materialActionReporter: async (report) => void reports.push(report)
    }, { emit: async () => undefined });

    expect(JSON.parse(readFileSync(join(scratch, "acp-permission.json"), "utf8"))).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" }
    });
    expect(reports).toEqual([]);
  }, 15_000);

  it("sends ACP cancellation and terminates a bounded child run", async () => {
    const scratch = tempDir("cancel");
    const executor = createAcpExecutor({ manifest: manifest("cancel"), cancelGraceMs: 500 });
    const running = executor.run(input({ kind: "scratch", path: scratch }, "run_cancel"), { emit: async () => undefined });
    await waitForFile(join(scratch, "acp-waiting.json"));

    await executor.cancel("run_cancel");
    const result = await running;

    expect(result.conclusion).toBe("cancelled");
    expect(existsSync(join(scratch, "acp-cancelled.json"))).toBe(true);
  }, 15_000);

  it("returns cancelled without spawning when cancellation wins the startup race", async () => {
    const scratch = tempDir("immediate-cancel");
    const executor = createAcpExecutor({ manifest: manifest(), cancelGraceMs: 100 });
    const running = executor.run(input({ kind: "scratch", path: scratch }, "run_immediate_cancel"), {
      emit: async () => undefined
    });

    await executor.cancel("run_immediate_cancel");
    const result = await running;

    expect(result.conclusion).toBe("cancelled");
    expect(existsSync(join(scratch, "acp-session.json"))).toBe(false);
    expect(existsSync(join(scratch, "acp-prompt.json"))).toBe(false);
  }, 15_000);

  it("cancels a delayed session/new without ever submitting a prompt", async () => {
    const scratch = tempDir("delayed-session");
    const executor = createAcpExecutor({ manifest: manifest("delay-session"), cancelGraceMs: 100 });
    const running = executor.run(input({ kind: "scratch", path: scratch }, "run_delayed_session"), {
      emit: async () => undefined
    });
    await waitForFile(join(scratch, "acp-session-new-started.json"));

    await executor.cancel("run_delayed_session");
    const result = await running;

    expect(result.conclusion).toBe("cancelled");
    expect(existsSync(join(scratch, "acp-prompt.json"))).toBe(false);
  }, 15_000);

  it("kills the child even when the ACP cancellation notification is rejected", async () => {
    const scratch = tempDir("cancel-notify-failure");
    const executor = createAcpExecutor({ manifest: manifest("cancel-notify-failure"), cancelGraceMs: 100 });
    const running = executor.run(input({ kind: "scratch", path: scratch }, "run_cancel_notify_failure"), {
      emit: async () => undefined
    });
    await waitForFile(join(scratch, "acp-waiting.json"));
    const { pid } = JSON.parse(readFileSync(join(scratch, "acp-session.json"), "utf8"));

    await executor.cancel("run_cancel_notify_failure");
    const result = await running;

    expect(result.conclusion).toBe("cancelled");
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it("strictly rejects malformed NDJSON and kills a child that stays alive", async () => {
    const scratch = tempDir("malformed");
    const executor = createAcpExecutor({ manifest: manifest("malformed-live"), cancelGraceMs: 100 });

    await expect(
      executor.run(input({ kind: "scratch", path: scratch }, "run_malformed"), { emit: async () => undefined })
    ).rejects.toThrow(/ACP agent fixture-agent.*(?:protocol|exit)/i);
    const pid = Number(readFileSync(join(scratch, "acp-child-pid.txt"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it("does not leak child stderr through errors or normalized events", async () => {
    const scratch = tempDir("child-exit");
    const executor = createAcpExecutor({ manifest: manifest("child-exit"), cancelGraceMs: 100 });
    const events: string[] = [];
    let thrown = "";
    try {
      await executor.run(input({ kind: "scratch", path: scratch }, "run_child_exit"), {
        emit: async (event) => void events.push(event.message)
      });
    } catch (error) {
      thrown = String(error);
    }

    expect(thrown).toMatch(/ACP agent fixture-agent.*(?:protocol|exit)/i);
    expect(thrown).not.toContain("SENTINEL_CHILD_STDERR_SECRET");
    expect(events.join("\n")).not.toContain("SENTINEL_CHILD_STDERR_SECRET");
  }, 15_000);

  it("uses an absolute scratch cwd without invoking repository isolation", async () => {
    const scratch = tempDir("scratch");
    const executor = createAcpExecutor({ manifest: manifest() });

    const result = await executor.run(input({ kind: "scratch", path: scratch }, "run_scratch"), { emit: async () => undefined });

    const session = JSON.parse(readFileSync(join(scratch, "acp-session.json"), "utf8"));
    expect(session).toMatchObject({ cwd: realpathSync(scratch), mcpServers: [], inheritedSecret: null, explicitValue: null });
    expect(result.conclusion).toBe("success");
    expect(result.changedFiles).toEqual([]);
    expect(existsSync(join(scratch, ".git"))).toBe(false);
  }, 15_000);

  it("uses an isolated absolute worktree cwd for repository runs", async () => {
    const repo = initRepo();
    const executor = createAcpExecutor({ manifest: manifest() });

    await executor.run(input({ kind: "repository", path: repo }, "run_repo_cwd"), { emit: async () => undefined });

    const session = JSON.parse(git(repo, ["show", "opentag/run_repo_cwd:acp-session.json"]));
    expect(session.cwd).toContain("/.worktrees/opentag/run_repo_cwd");
    expect(session.cwd.startsWith("/")).toBe(true);
  }, 15_000);

  it("uses a real contained binding cwd for both the child and ACP session", async () => {
    const scratch = tempDir("contained-cwd");
    const nested = join(scratch, "nested");
    mkdirSync(nested);
    const executor = createAcpExecutor({ manifest: manifestWithCwd("nested") });

    await executor.run(input({ kind: "scratch", path: scratch }, "run_contained_cwd"), { emit: async () => undefined });

    const session = JSON.parse(readFileSync(join(nested, "acp-session.json"), "utf8"));
    expect(session.cwd).toBe(realpathSync(nested));
    expect(existsSync(join(nested, "acp-output.txt"))).toBe(true);
  }, 15_000);

  it.each([
    ["scratch traversal", "scratch" as const, ".."],
    ["scratch absolute", "scratch" as const, "/tmp"],
    ["repository traversal", "repository" as const, ".."]
  ])("rejects an escaping binding cwd: %s", async (_label, kind, cwd) => {
    const workspace = kind === "repository" ? initRepo() : tempDir("unsafe-cwd");
    const executor = createAcpExecutor({ manifest: manifestWithCwd(cwd) });

    await expect(
      executor.run(input({ kind, path: workspace }, `run_${kind}_unsafe_cwd`), { emit: async () => undefined })
    ).rejects.toThrow(/binding cwd/i);
  }, 15_000);

  it("rejects a binding cwd symlink that escapes the attempt workspace", async () => {
    const scratch = tempDir("symlink-cwd");
    const outside = tempDir("symlink-outside");
    symlinkSync(outside, join(scratch, "escape"));
    const executor = createAcpExecutor({ manifest: manifestWithCwd("escape") });

    await expect(
      executor.run(input({ kind: "scratch", path: scratch }, "run_symlink_cwd"), { emit: async () => undefined })
    ).rejects.toThrow(/binding cwd/i);
  }, 15_000);

  it("scrubs inherited secrets while preserving explicitly configured binding environment", async () => {
    const scratch = tempDir("environment");
    const previous = process.env.OPENTAG_ACP_HOST_SECRET;
    process.env.OPENTAG_ACP_HOST_SECRET = "must-not-reach-agent";
    const configured = manifest();
    configured.bindings.agent.env = {
      ...configured.bindings.agent.env,
      OPENTAG_ACP_EXPLICIT: "configured-value"
    };
    try {
      const executor = createAcpExecutor({ manifest: configured });
      await executor.run(input({ kind: "scratch", path: scratch }, "run_env"), { emit: async () => undefined });
      const session = JSON.parse(readFileSync(join(scratch, "acp-session.json"), "utf8"));
      expect(session.inheritedSecret).toBeNull();
      expect(session.explicitValue).toBe("configured-value");
    } finally {
      if (previous === undefined) delete process.env.OPENTAG_ACP_HOST_SECRET;
      else process.env.OPENTAG_ACP_HOST_SECRET = previous;
    }
  }, 15_000);

  it("does not commit or discard repository changes when an ACP attempt refuses", async () => {
    const repo = initRepo();
    const executor = createAcpExecutor({ manifest: manifest("refusal") });

    const result = await executor.run(input({ kind: "repository", path: repo }, "run_refusal"), { emit: async () => undefined });

    expect(result.conclusion).toBe("needs_human");
    expect(() => git(repo, ["show", "opentag/run_refusal:acp-output.txt"])).toThrow();
    expect(existsSync(join(repo, ".worktrees", "opentag", "run_refusal", "acp-output.txt"))).toBe(true);
  }, 15_000);

  it("retains a cancelled repository delta even when keepWorktree is never", async () => {
    const repo = initRepo();
    const worktree = join(repo, ".worktrees", "opentag", "run_cancel_recovery");
    const executor = createAcpExecutor({ manifest: manifest("cancel"), cancelGraceMs: 100 });
    const running = executor.run(input({ kind: "repository", path: repo }, "run_cancel_recovery"), {
      emit: async () => undefined
    });
    await waitForFile(join(worktree, "acp-waiting.json"));

    await executor.cancel("run_cancel_recovery");
    const result = await running;

    expect(result.conclusion).toBe("cancelled");
    expect(readFileSync(join(worktree, "acp-output.txt"), "utf8")).toContain("recoverable cancellation delta");
    expect(() => git(repo, ["show", "opentag/run_cancel_recovery:acp-output.txt"])).toThrow();
  }, 15_000);
});
