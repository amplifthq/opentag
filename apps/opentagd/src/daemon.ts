import type { OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import type { ExecutorAdapter } from "@opentag/runner";
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
  const owner = event.metadata["owner"];
  const repo = event.metadata["repo"];
  const repoProvider =
    typeof event.metadata["repoProvider"] === "string" ? (event.metadata["repoProvider"] as string) : "github";
  if (typeof owner !== "string" || typeof repo !== "string") return null;

  return (
    repositories.find(
      (candidate) => candidate.provider === repoProvider && candidate.owner === owner && candidate.repo === repo
    ) ?? null
  );
}

export function resolveWorkspacePath(event: OpenTagEvent, repositories: RepositoryBindingConfig[]): string | null {
  return resolveRepositoryBinding(event, repositories)?.checkoutPath ?? null;
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  return message.length > 4000 ? `${message.slice(0, 3997)}...` : message;
}

export async function runOneDaemonIteration(input: {
  runnerId: string;
  repositories: RepositoryBindingConfig[];
  executors: Record<string, ExecutorAdapter>;
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

  const readiness = await executor.canRun({
    runId: claimed.run.id,
    workspacePath: binding.checkoutPath,
    ...(binding.baseBranch ? { baseBranch: binding.baseBranch } : {}),
    ...(binding.worktreeRoot ? { worktreeRoot: binding.worktreeRoot } : {}),
    ...(binding.keepWorktree ? { keepWorktree: binding.keepWorktree } : {}),
    command: claimed.event.command,
    context: claimed.event.context
  });
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
        ...(binding.baseBranch ? { baseBranch: binding.baseBranch } : {}),
        ...(binding.worktreeRoot ? { worktreeRoot: binding.worktreeRoot } : {}),
        ...(binding.keepWorktree ? { keepWorktree: binding.keepWorktree } : {}),
        command: claimed.event.command,
        context: claimed.event.context
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
    await input.client.complete(claimed.run.id, {
      conclusion: "failure",
      summary: `OpenTag executor failed: ${errorSummary(error)}`
    });
    return true;
  } finally {
    if (heartbeatHandle) clearInterval(heartbeatHandle);
  }
  try {
    const result = await maybeCreatePullRequest({
      run: claimed.run,
      event: claimed.event,
      binding,
      result: executorResult,
      options: input.pullRequestOptions ?? {}
    });
    await input.client.complete(claimed.run.id, result);
  } catch (error) {
    await input.client.complete(claimed.run.id, {
      conclusion: "failure",
      summary: `OpenTag failed after executor completion: ${errorSummary(error)}`
    });
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function serveDaemon(input: {
  runnerId: string;
  repositories: RepositoryBindingConfig[];
  executors: Record<string, ExecutorAdapter>;
  pullRequestOptions?: PullRequestOptions;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  client: DaemonClient;
}): Promise<never> {
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  for (;;) {
    const didWork = await runOneDaemonIteration({
      runnerId: input.runnerId,
      repositories: input.repositories,
      executors: input.executors,
      ...(input.pullRequestOptions ? { pullRequestOptions: input.pullRequestOptions } : {}),
      ...(input.heartbeatIntervalMs ? { heartbeatIntervalMs: input.heartbeatIntervalMs } : {}),
      client: input.client
    });
    if (!didWork) {
      await sleep(pollIntervalMs);
    }
  }
}
