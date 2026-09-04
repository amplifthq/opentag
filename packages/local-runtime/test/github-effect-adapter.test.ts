import {
  computeEffectPermitDigestV1,
  computeEffectTargetDigestV1,
  type EffectExecutePermitV1,
} from "@opentag/control-protocol";
import type { CommandRunner } from "@opentag/runner";
import { describe, expect, it, vi } from "vitest";
import { createGitHubDraftPullRequestEffectAdapter } from "../src/effects/github-draft-pr.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const observedAt = "2026-09-05T01:02:00.000Z";

const binding = {
  projectTargetId: "target_1",
  provider: "github" as const,
  owner: "acme",
  repo: "demo",
  checkoutPath: "/private/local/demo",
  defaultExecutor: "codex",
  baseBranch: "main",
  pushRemote: "origin",
  keepWorktree: "on_failure" as const,
};

async function permit(): Promise<EffectExecutePermitV1> {
  const target = {
    projectTargetId: "target_1",
    targetBindingDigest: digest("a"),
    targetBindingGeneration: 4,
    provider: "github" as const,
    owner: "acme",
    repo: "demo",
    remote: "origin",
    baseBranch: "main",
    branch: "opentag/run_1",
    frozenBaseRevision: "b".repeat(40),
    workspaceTreeDigest: "c".repeat(40),
    expectedHeadSha: "d".repeat(40),
  };
  const input = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.effect-authority.v1"] as ["relay.effect-authority.v1"],
    permitId: "permit_1",
    permitKind: "execute" as const,
    effectId: "effect_1",
    effectAttemptNumber: 1,
    organizationId: "org_1",
    runnerId: "runner_1",
    runnerGeneration: 2,
    acquireRequestId: "acquire_1",
    acquireJournalDigest: digest("8"),
    runId: "run_1",
    runAttemptId: "attempt_1",
    runAttemptNumber: 3,
    fencingTokenDigest: digest("e"),
    effectKind: "github.create_draft_pull_request" as const,
    requestDigest: digest("1"),
    targetDigest: await computeEffectTargetDigestV1(target),
    approvalDigest: digest("3"),
    candidate: { candidateId: "candidate_1", candidateDigest: digest("f") },
    target,
    issuedAt: "2026-09-05T01:00:00.000Z",
    expiresAt: "2026-09-05T01:05:00.000Z",
  };
  return { ...input, permitDigest: await computeEffectPermitDigestV1(input) };
}

function pullRequest(effectPermit: EffectExecutePermitV1) {
  return {
    number: 7,
    state: "open",
    merged: false,
    draft: true,
    html_url: "https://github.com/acme/demo/pull/7",
    head: {
      sha: effectPermit.target.expectedHeadSha,
      ref: effectPermit.target.branch,
      repo: { full_name: "AcMe/DeMo" },
    },
    base: {
      ref: effectPermit.target.baseBranch,
      sha: "9".repeat(40),
      repo: { full_name: "acme/demo" },
    },
  };
}

function githubFetch(effectPermit: EffectExecutePermitV1) {
  const request = pullRequest(effectPermit);
  return vi.fn<typeof fetch>(async (url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer github_local_secret");
    const path = String(url);
    if (init?.method === "POST" && path.endsWith("/repos/acme/demo/pulls")) {
      expect(JSON.parse(String(init.body))).toMatchObject({
        head: "opentag/run_1",
        base: "main",
        draft: true,
      });
      return Response.json({ html_url: request.html_url });
    }
    if (path.includes(`/commits/${effectPermit.target.expectedHeadSha}/pulls`)) {
      return Response.json([{ number: 7 }]);
    }
    if (path.endsWith("/repos/acme/demo/pulls/7")) return Response.json(request);
    if (path.includes("/check-runs")) {
      return Response.json({ total_count: 1, check_runs: [{
        name: "ci", status: "completed", conclusion: "success",
        head_sha: effectPermit.target.expectedHeadSha,
      }] });
    }
    if (path.includes("/status?")) {
      return Response.json({ sha: effectPermit.target.expectedHeadSha,
        total_count: 1, statuses: [{ context: "review", state: "pending",
          sha: effectPermit.target.expectedHeadSha }] });
    }
    return new Response("not found", { status: 404 });
  });
}

function gitRunner(effectPermit: EffectExecutePermitV1, pushExitCode = 0) {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const runner: CommandRunner = {
    async run(command, args, options) {
      calls.push({ command, args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${effectPermit.target.expectedHeadSha}\n`, stderr: "" };
      }
      if (args[0] === "push") {
        return { exitCode: pushExitCode, stdout: "", stderr: pushExitCode ? "response lost" : "" };
      }
      if (args[0] === "ls-remote") {
        return { exitCode: 0,
          stdout: `${effectPermit.target.expectedHeadSha}\trefs/heads/${effectPermit.target.branch}\n`,
          stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    },
  };
  return { runner, calls };
}

describe("GitHub draft-PR Effect adapter", () => {
  it("pushes the owned branch, creates a draft PR, and returns full check evidence", async () => {
    const effectPermit = await permit();
    const git = gitRunner(effectPermit);
    const fetchImpl = githubFetch(effectPermit);
    const adapter = createGitHubDraftPullRequestEffectAdapter({
      repositories: [binding],
      githubToken: "github_local_secret",
      runner: git.runner,
      fetchImpl,
      now: () => new Date(observedAt),
    });
    const evidence = await adapter.createDraftPullRequest(effectPermit, new AbortController().signal);
    expect(evidence).toEqual({
      kind: "present",
      observation: {
        provider: "github",
        repository: { owner: "acme", repo: "demo" },
        remote: "origin",
        branch: "opentag/run_1",
        baseBranch: "main",
        pullRequestNumber: 7,
        pullRequestResourceRef: "github_pr_7",
        pullRequestUrl: "https://github.com/acme/demo/pull/7",
        draft: true,
        state: "open",
        headSha: effectPermit.target.expectedHeadSha,
        headBranch: "opentag/run_1",
        headRepository: { owner: "AcMe", repo: "DeMo" },
        baseSha: "9".repeat(40),
        checks: { ci: "passed", review: "pending" },
        checksComplete: true,
        observedAt,
      },
    });
    expect(git.calls.map(({ args }) => args[0])).toEqual(["rev-parse", "push", "ls-remote"]);
    expect(git.calls[1]?.args).toEqual([
      "push",
      "origin",
      `${effectPermit.target.expectedHeadSha}:refs/heads/opentag/run_1`,
    ]);
    expect(git.calls[1]?.args).not.toContain("opentag/run_1");
    expect(JSON.stringify(git.calls)).not.toContain("github_local_secret");
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("reconciles a lost push response before creating the PR", async () => {
    const effectPermit = await permit();
    const git = gitRunner(effectPermit, 1);
    const fetchImpl = githubFetch(effectPermit);
    const adapter = createGitHubDraftPullRequestEffectAdapter({
      repositories: [binding], githubToken: "github_local_secret",
      runner: git.runner, fetchImpl, now: () => new Date(observedAt),
    });
    await expect(adapter.createDraftPullRequest(effectPermit, new AbortController().signal))
      .resolves.toMatchObject({ kind: "present" });
    expect(git.calls.map(({ args }) => args[0])).toEqual(["rev-parse", "push", "ls-remote"]);
  });

  it("observes exact absence without any local mutation", async () => {
    const effectPermit = await permit();
    const runner = { run: vi.fn() } as unknown as CommandRunner;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("authorization"))
        .toBe("Bearer github_local_secret");
      expect(String(url)).toContain(`/commits/${effectPermit.target.expectedHeadSha}/pulls`);
      return Response.json([]);
    });
    const adapter = createGitHubDraftPullRequestEffectAdapter({
      repositories: [binding], githubToken: "github_local_secret",
      runner, fetchImpl, now: () => new Date(observedAt),
    });
    await expect(adapter.observeDraftPullRequest(effectPermit, new AbortController().signal))
      .resolves.toEqual({
        kind: "absent",
        observationScope: {
          provider: "github",
          repository: { owner: "acme", repo: "demo" },
          baseBranch: "main",
          headBranch: "opentag/run_1",
          expectedHeadSha: effectPermit.target.expectedHeadSha,
          bindingGeneration: 4,
          targetBindingDigest: digest("a"),
          observationPolicy: "github.exact_draft_pr.v1",
          observedAt,
        },
      });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects a PR converted out of draft state during check collection", async () => {
    const effectPermit = await permit();
    const canonical = pullRequest(effectPermit);
    let pullRequestReads = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.includes(`/commits/${effectPermit.target.expectedHeadSha}/pulls`)) {
        return Response.json([{ number: 7 }]);
      }
      if (path.endsWith("/repos/acme/demo/pulls/7")) {
        pullRequestReads += 1;
        return Response.json(pullRequestReads === 3
          ? { ...canonical, draft: false }
          : canonical);
      }
      if (path.includes("/check-runs")) {
        return Response.json({ total_count: 0, check_runs: [] });
      }
      if (path.includes("/status?")) {
        return Response.json({ sha: effectPermit.target.expectedHeadSha,
          total_count: 0, statuses: [] });
      }
      return new Response("not found", { status: 404 });
    });
    const adapter = createGitHubDraftPullRequestEffectAdapter({
      repositories: [binding], githubToken: "github_local_secret",
      fetchImpl, now: () => new Date(observedAt),
    });
    await expect(adapter.observeDraftPullRequest(effectPermit, new AbortController().signal))
      .resolves.toEqual({ kind: "ambiguous", errorCode: "malformed_response" });
    expect(pullRequestReads).toBe(3);
  });

  it("fails closed before provider work when the local target is unavailable", async () => {
    const effectPermit = await permit();
    const runner = { run: vi.fn() } as unknown as CommandRunner;
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createGitHubDraftPullRequestEffectAdapter({
      repositories: [], githubToken: "github_local_secret", runner, fetchImpl,
    });
    await expect(adapter.createDraftPullRequest(effectPermit, new AbortController().signal))
      .resolves.toEqual({ kind: "attention", reasonCode: "local.effect-target-unavailable" });
    expect(runner.run).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces a missing local GitHub credential as attention without mutation", async () => {
    const effectPermit = await permit();
    const runner = { run: vi.fn() } as unknown as CommandRunner;
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createGitHubDraftPullRequestEffectAdapter({
      repositories: [binding], runner, fetchImpl,
    });
    await expect(adapter.createDraftPullRequest(effectPermit, new AbortController().signal))
      .resolves.toEqual({
        kind: "attention",
        reasonCode: "local.github-credential-unavailable",
      });
    expect(runner.run).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
