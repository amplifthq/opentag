import { projectTargetRefFromEvent, type OpenTagEvent, type OpenTagRun, type OpenTagRunResult } from "@opentag/core";
import {
  assessRunnerSecurity,
  formatSecurityAssessment,
  type ExecutorAdapter,
  type RunnerSecurityPolicy,
  worktreePathForRun
} from "@opentag/runner";
import type { RepositoryBindingConfig } from "./config.js";
import { maybeCreatePullRequest, type PullRequestOptions } from "./pr.js";

export type ClaimedRun = {
  run: OpenTagRun;
  event: OpenTagEvent;
};

export type DaemonClient = {
  claim(): Promise<ClaimedRun | null>;
  markRunning(runId: string, executor: string): Promise<void>;
  heartbeat(runId: string): Promise<void>;
  progress(runId: string, input: { type: string; message: string; at: string }): Promise<void>;
  complete(runId: string, result: OpenTagRunResult): Promise<void>;
};

export function resolveRepositoryBinding(event: OpenTagEvent, repositories: RepositoryBindingConfig[]): RepositoryBindingConfig | null {
  const projectTargetRef = projectTargetRefFromEvent(event);
  if (!projectTargetRef) return null;

  return (
    repositories.find(
      (candidate) =>
        candidate.provider === projectTargetRef.provider &&
        candidate.owner === projectTargetRef.owner &&
        candidate.repo === projectTargetRef.repo
    ) ?? null
  );
}

export function resolveWorkspacePath(event: OpenTagEvent, repositories: RepositoryBindingConfig[]): string | null {
  return resolveRepositoryBinding(event, repositories)?.checkoutPath ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedRunResult(stage: string, error: unknown): OpenTagRunResult {
  return {
    conclusion: "failure",
    summary: `${stage} failed: ${errorMessage(error)}`
  };
}

function pullRequestPreparationFailureResult(result: OpenTagRunResult, error: unknown): OpenTagRunResult {
  return {
    conclusion: "needs_human",
    summary: `Executor completed, but OpenTag could not prepare the pull request action: ${errorMessage(error)}`,
    ...(result.changedFiles ? { changedFiles: result.changedFiles } : {}),
    ...(result.artifacts ? { artifacts: result.artifacts } : {}),
    ...(result.verification ? { verification: result.verification } : {}),
    nextAction: "Fix branch push or pull request credentials, then retry the run before applying the PR action."
  };
}

export async function runOneDaemonIteration(input: {
  runnerId: string;
  repositories: RepositoryBindingConfig[];
  executors: Record<string, ExecutorAdapter>;
  security?: RunnerSecurityPolicy;
  pullRequestOptions?: PullRequestOptions;
  heartbeatIntervalMs?: number;
  client: DaemonClient;
}): Promise<boolean> {
  const claimed = await input.client.claim();
  if (!claimed) return false;

  const binding = resolveRepositoryBinding(claimed.event, input.repositories);
  if (!binding) {
    await input.client.complete(claimed.run.id, {
      conclusion: "needs_human",
      summary: "No local workspace mapping is configured for this run's repository."
    });
    return true;
  }
  const executorId = binding.defaultExecutor ?? claimed.event.target.executorHint ?? "echo";
  const executor = input.executors[executorId];
  if (!executor) {
    await input.client.complete(claimed.run.id, {
      conclusion: "needs_human",
      summary: `No local executor is configured for '${executorId}'.`
    });
    return true;
  }

  const executionPath =
    executorId === "codex"
      ? worktreePathForRun({
          workspacePath: binding.checkoutPath,
          runId: claimed.run.id,
          ...(binding.worktreeRoot ? { worktreeRoot: binding.worktreeRoot } : {})
        })
      : binding.checkoutPath;

  const securityAssessment = assessRunnerSecurity({
    executorId,
    workspacePath: binding.checkoutPath,
    executionPath,
    command: claimed.event.command,
    context: claimed.event.context,
    permissions: claimed.event.permissions,
    ...(input.security ? { policy: input.security } : {})
  });
  if (securityAssessment.findings.length > 0) {
    await input.client.progress(claimed.run.id, {
      type: securityAssessment.allowed ? "security.audit" : "security.blocked",
      message: formatSecurityAssessment(securityAssessment),
      at: new Date().toISOString()
    });
  }
  if (!securityAssessment.allowed) {
    await input.client.complete(claimed.run.id, {
      conclusion: "needs_human",
      summary: formatSecurityAssessment(securityAssessment),
      nextAction: "Review the request and rerun with a narrower prompt or an explicit local policy override if appropriate."
    });
    return true;
  }

  let readiness: Awaited<ReturnType<ExecutorAdapter["canRun"]>>;
  try {
    readiness = await executor.canRun({
      runId: claimed.run.id,
      workspacePath: binding.checkoutPath,
      command: claimed.event.command,
      context: claimed.event.context,
      ...(claimed.run.contextPacket ? { contextPacket: claimed.run.contextPacket } : {}),
      permissions: claimed.event.permissions,
      ...(binding.baseBranch ? { baseBranch: binding.baseBranch } : {}),
      ...(binding.worktreeRoot ? { worktreeRoot: binding.worktreeRoot } : {}),
      ...(binding.keepWorktree !== undefined ? { keepWorktree: binding.keepWorktree } : {})
    });
  } catch (error) {
    await input.client.complete(claimed.run.id, failedRunResult(`${executor.displayName} readiness check`, error));
    return true;
  }

  if (!readiness.ready) {
    await input.client.complete(claimed.run.id, {
      conclusion: "needs_human",
      summary: readiness.reason ?? `${executor.displayName} is not ready`
    });
    return true;
  }

  await input.client.markRunning(claimed.run.id, executor.id);
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 15_000;
  let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
  if (heartbeatIntervalMs > 0) {
    heartbeatHandle = setInterval(() => {
      void input.client.heartbeat(claimed.run.id).catch((error: unknown) => {
        console.warn(`OpenTag heartbeat failed for ${claimed.run.id}:`, error);
      });
    }, heartbeatIntervalMs);
  }

  let executorResult: OpenTagRunResult;
  try {
    executorResult = await executor.run(
      {
        runId: claimed.run.id,
        workspacePath: binding.checkoutPath,
        command: claimed.event.command,
        context: claimed.event.context,
        ...(claimed.run.contextPacket ? { contextPacket: claimed.run.contextPacket } : {}),
        permissions: claimed.event.permissions,
        ...(binding.baseBranch ? { baseBranch: binding.baseBranch } : {}),
        ...(binding.worktreeRoot ? { worktreeRoot: binding.worktreeRoot } : {}),
        ...(binding.keepWorktree !== undefined ? { keepWorktree: binding.keepWorktree } : {})
      },
      {
        emit: async (event) => {
          console.log(`[${event.type}] ${event.message}`);
          await input.client.progress(claimed.run.id, {
            type: event.type,
            message: event.message,
            at: event.at
          });
        }
      }
    );
  } catch (error) {
    await input.client.complete(claimed.run.id, failedRunResult(executor.displayName, error));
    return true;
  } finally {
    if (heartbeatHandle) clearInterval(heartbeatHandle);
  }

  let result: OpenTagRunResult;
  try {
    result = await maybeCreatePullRequest({
      run: claimed.run,
      event: claimed.event,
      binding,
      result: executorResult,
      options: input.pullRequestOptions ?? {}
    });
  } catch (error) {
    result = pullRequestPreparationFailureResult(executorResult, error);
  }
  await input.client.complete(claimed.run.id, result);
  return true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timeout);
      resolve();
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function serveDaemon(input: {
  runnerId: string;
  repositories: RepositoryBindingConfig[];
  executors: Record<string, ExecutorAdapter>;
  security?: RunnerSecurityPolicy;
  pullRequestOptions?: PullRequestOptions;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  client: DaemonClient;
}): Promise<void> {
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  while (!input.signal?.aborted) {
    try {
      const didWork = await runOneDaemonIteration({
        runnerId: input.runnerId,
        repositories: input.repositories,
        executors: input.executors,
        ...(input.security ? { security: input.security } : {}),
        ...(input.pullRequestOptions ? { pullRequestOptions: input.pullRequestOptions } : {}),
        ...(input.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: input.heartbeatIntervalMs } : {}),
        client: input.client
      });
      if (!didWork) {
        await sleep(pollIntervalMs, input.signal);
      }
    } catch (error) {
      if (input.signal?.aborted) break;
      console.warn("OpenTag daemon iteration failed; retrying:", error);
      await sleep(pollIntervalMs, input.signal);
    }
  }
}
