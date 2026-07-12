import {
  formatProjectTargetRef,
  parseWorkContextMutationCommand,
  projectTargetRefFromEvent,
  type OpenTagEvent,
  type OpenTagRun,
  type OpenTagRunResult,
  type ProjectTargetRef
} from "@opentag/core";
import {
  assessRunnerSecurity,
  formatSecurityAssessment,
  createAgentSessionProfileForEvent,
  createWorkContextMutationRunResult,
  resolveAgentSessionProfile,
  type ExecutorAdapter,
  type RunnerSecurityPolicy,
  worktreePathForRun
} from "@opentag/runner";
import type { AgentSessionProfileConfig, RepositoryBindingConfig } from "./config.js";
import { maybeCreatePullRequest, type PullRequestOptions } from "./pr.js";

export type ClaimedRun = {
  run: OpenTagRun;
  event: OpenTagEvent;
  attemptId: string;
  attemptNumber: number;
  fencingToken: string;
};

export type AttemptLease = Pick<ClaimedRun, "attemptId" | "fencingToken">;

export type DaemonClient = {
  claim(): Promise<ClaimedRun | null>;
  markRunning(
    runId: string,
    executor: string,
    lease: AttemptLease,
    options?: { executorCapability?: Record<string, unknown>; runTimeoutMs?: number; idempotencyKey?: string }
  ): Promise<void>;
  heartbeat(runId: string, lease: AttemptLease): Promise<void>;
  progress(runId: string, lease: AttemptLease, input: { type: string; message: string; at: string }): Promise<void>;
  complete(runId: string, lease: AttemptLease, result: OpenTagRunResult): Promise<void>;
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

function claimedProjectTargetFailure(input: {
  event: OpenTagEvent;
  projectTargetRef: ProjectTargetRef | null;
  repositories: RepositoryBindingConfig[];
}): OpenTagRunResult | null {
  if (!input.projectTargetRef) {
    return {
      conclusion: "needs_human",
      summary: "No Project Target metadata is configured for this run.",
      nextAction: "Reject this run or replay it from a source that includes repoProvider, owner, and repo metadata."
    };
  }

  if (input.event.source === "github" && input.projectTargetRef.provider !== "github") {
    return {
      conclusion: "needs_human",
      summary: `GitHub source events must target a GitHub Project Target, received ${formatProjectTargetRef(input.projectTargetRef)}.`,
      nextAction: "Verify the relay is preserving GitHub webhook metadata before allowing this run."
    };
  }

  const allowed = input.repositories.some(
    (repository) =>
      repository.provider === input.projectTargetRef?.provider &&
      repository.owner === input.projectTargetRef.owner &&
      repository.repo === input.projectTargetRef.repo
  );
  if (!allowed) {
    return {
      conclusion: "needs_human",
      summary: `This run targets ${formatProjectTargetRef(input.projectTargetRef)}, which is not in this runner's local Project Target allowlist.`,
      nextAction: "Update the local OpenTag config only if this relay and Project Target are trusted."
    };
  }

  return null;
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

function formatDurationMs(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute(s)`;
  if (ms % 1_000 === 0) return `${ms / 1_000} second(s)`;
  return `${ms}ms`;
}

function timedOutRunResult(input: { executorName: string; timeoutMs: number }): OpenTagRunResult {
  return {
    conclusion: "timed_out",
    summary: `${input.executorName} exceeded the configured hard timeout of ${formatDurationMs(input.timeoutMs)}.`,
    nextAction: "OpenTag requested executor cancellation. Check the local audit/status output before retrying or continuing manually."
  };
}

function runNoLongerClaimed(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("stale_attempt") || message.includes("run_not_claimed_by_runner") || message.includes("run_not_found");
}

type ExecutorRunOutcome =
  | { kind: "result"; result: OpenTagRunResult }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

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

function metadataToken(metadata: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function executorMetadata(event: OpenTagEvent): Record<string, unknown> {
  const metadata = event.metadata ?? {};
  const accountId =
    metadataToken(metadata, "accountId") ??
    metadataToken(metadata, "teamId") ??
    metadataToken(metadata, "tenantKey") ??
    metadataToken(metadata, "botId");
  const conversationId =
    metadataToken(metadata, "conversationId") ??
    metadataToken(metadata, "channelId") ??
    metadataToken(metadata, "chatId");

  return {
    ...metadata,
    provider: event.source,
    ...(accountId ? { accountId } : {}),
    ...(conversationId ? { conversationId } : {})
  };
}

export async function runOneDaemonIteration(input: {
  runnerId: string;
  repositories: RepositoryBindingConfig[];
  executors: Record<string, ExecutorAdapter>;
  security?: RunnerSecurityPolicy;
  pullRequestOptions?: PullRequestOptions;
  heartbeatIntervalMs?: number;
  runTimeoutMs?: number;
  agentSessionProfile?: AgentSessionProfileConfig;
  client: DaemonClient;
}): Promise<boolean> {
  const claimed = await input.client.claim();
  if (!claimed) return false;
  const lease: AttemptLease = { attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };

  const projectTargetRef = projectTargetRefFromEvent(claimed.event);
  const claimedTargetFailure = claimedProjectTargetFailure({
    event: claimed.event,
    projectTargetRef,
    repositories: input.repositories
  });
  if (claimedTargetFailure) {
    await input.client.complete(claimed.run.id, lease, claimedTargetFailure);
    return true;
  }
  const binding = resolveRepositoryBinding(claimed.event, input.repositories);
  if (!binding) {
    await input.client.complete(claimed.run.id, lease, {
      conclusion: "needs_human",
      summary: "No local workspace mapping is configured for this run's repository."
    });
    return true;
  }
  // Pure work-context mutation requests ("set priority to High") never need an
  // executor: compile them into a suggested-changes proposal so the source thread
  // gets an action receipt and the mutation stays behind the governed apply path.
  const mutationRequests = parseWorkContextMutationCommand(claimed.event.command.rawText);
  if (mutationRequests) {
    await input.client.complete(
      claimed.run.id,
      lease,
      createWorkContextMutationRunResult({ runId: claimed.run.id, requests: mutationRequests })
    );
    return true;
  }
  const executorId = claimed.event.target.executorHint ?? binding.defaultExecutor ?? "echo";
  const executor = input.executors[executorId];
  if (!executor) {
    await input.client.complete(claimed.run.id, lease, {
      conclusion: "needs_human",
      summary: `No local executor is configured for '${executorId}'.`
    });
    return true;
  }
  const metadata = executorMetadata(claimed.event);
  const fallbackSessionProfile = createAgentSessionProfileForEvent({
    runId: claimed.run.id,
    event: claimed.event,
    metadata
  });
  const sessionProfile = input.agentSessionProfile
    ? resolveAgentSessionProfile({
        ...(input.agentSessionProfile.profile ? { profile: input.agentSessionProfile.profile } : {}),
        ...(input.agentSessionProfile.profileTemplate ? { profileTemplate: input.agentSessionProfile.profileTemplate } : {}),
        metadata: {
          ...metadata,
          runId: claimed.run.id
        },
        ...(projectTargetRef ? { projectTargetRef } : {}),
        actorId: claimed.event.actor.providerUserId,
        ...(fallbackSessionProfile ? { fallback: fallbackSessionProfile } : {})
      })
    : fallbackSessionProfile;

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
    await input.client.progress(claimed.run.id, lease, {
      type: securityAssessment.allowed ? "security.audit" : "security.blocked",
      message: formatSecurityAssessment(securityAssessment),
      at: new Date().toISOString()
    });
  }
  if (!securityAssessment.allowed) {
    await input.client.complete(claimed.run.id, lease, {
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
      metadata,
      ...(sessionProfile ? { sessionProfile } : {}),
      ...(binding.baseBranch ? { baseBranch: binding.baseBranch } : {}),
      ...(binding.worktreeRoot ? { worktreeRoot: binding.worktreeRoot } : {}),
      ...(binding.keepWorktree !== undefined ? { keepWorktree: binding.keepWorktree } : {})
    });
  } catch (error) {
    await input.client.complete(claimed.run.id, lease, failedRunResult(`${executor.displayName} readiness check`, error));
    return true;
  }

  if (!readiness.ready) {
    await input.client.complete(claimed.run.id, lease, {
      conclusion: "needs_human",
      summary: readiness.reason ?? `${executor.displayName} is not ready`
    });
    return true;
  }

  const runId = claimed.run.id;
  const activeExecutor = executor;
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 15_000;
  const runTimeoutMs = input.runTimeoutMs;
  await input.client.markRunning(runId, activeExecutor.id, lease, {
    ...(activeExecutor.capability ? { executorCapability: activeExecutor.capability as unknown as Record<string, unknown> } : {}),
    idempotencyKey: `${input.runnerId}:${runId}:running`,
    ...(runTimeoutMs ? { runTimeoutMs } : {})
  });
  let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let cancellationDetected = false;
  let cancelPromise: Promise<void> | undefined;
  function requestExecutorCancel(error: unknown): void {
    if (!runNoLongerClaimed(error)) {
      console.warn(`OpenTag heartbeat failed for ${runId}:`, error);
      return;
    }
    cancellationDetected = true;
    cancelPromise ??= activeExecutor.cancel(runId).catch((cancelError: unknown) => {
      console.warn(`OpenTag executor cancellation failed for ${runId}:`, cancelError);
    });
  }
  if (heartbeatIntervalMs > 0) {
    heartbeatHandle = setInterval(() => {
      void input.client.heartbeat(runId, lease).catch(requestExecutorCancel);
    }, heartbeatIntervalMs);
  }

  const executorRunPromise: Promise<ExecutorRunOutcome> = activeExecutor
    .run(
      {
        runId,
        workspacePath: binding.checkoutPath,
        command: claimed.event.command,
        context: claimed.event.context,
        ...(claimed.run.contextPacket ? { contextPacket: claimed.run.contextPacket } : {}),
        permissions: claimed.event.permissions,
        metadata,
        ...(sessionProfile ? { sessionProfile } : {}),
        ...(binding.baseBranch ? { baseBranch: binding.baseBranch } : {}),
        ...(binding.worktreeRoot ? { worktreeRoot: binding.worktreeRoot } : {}),
        ...(binding.keepWorktree !== undefined ? { keepWorktree: binding.keepWorktree } : {})
      },
      {
        emit: async (event) => {
          console.log(`[${event.type}] ${event.message}`);
          try {
            await input.client.progress(runId, lease, {
              type: event.type,
              message: event.message,
              at: event.at
            });
          } catch (error) {
            if (runNoLongerClaimed(error)) {
              requestExecutorCancel(error);
              return;
            }
            throw error;
          }
        }
      }
    )
    .then(
      (result) => ({ kind: "result", result }) as const,
      (error: unknown) => ({ kind: "error", error }) as const
    );

  const timeoutPromise =
    runTimeoutMs && runTimeoutMs > 0
      ? new Promise<ExecutorRunOutcome>((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), runTimeoutMs);
        })
      : undefined;

  let executorOutcome: ExecutorRunOutcome;
  try {
    executorOutcome = await (timeoutPromise ? Promise.race([executorRunPromise, timeoutPromise]) : executorRunPromise);
  } finally {
    if (heartbeatHandle) clearInterval(heartbeatHandle);
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  if (executorOutcome.kind === "timeout") {
    if (cancellationDetected) {
      if (cancelPromise) await cancelPromise;
      return true;
    }
    cancellationDetected = true;
    cancelPromise ??= activeExecutor.cancel(runId).catch((cancelError: unknown) => {
      console.warn(`OpenTag executor cancellation failed after timeout for ${runId}:`, cancelError);
    });
    await cancelPromise;
    try {
      await input.client.complete(runId, lease, timedOutRunResult({ executorName: activeExecutor.displayName, timeoutMs: runTimeoutMs ?? 0 }));
    } catch (completeError) {
      if (runNoLongerClaimed(completeError)) {
        return true;
      }
      throw completeError;
    }
    return true;
  }

  if (executorOutcome.kind === "error") {
    if (cancellationDetected) {
      if (cancelPromise) await cancelPromise;
      return true;
    }
    try {
      await input.client.complete(runId, lease, failedRunResult(activeExecutor.displayName, executorOutcome.error));
    } catch (completeError) {
      if (runNoLongerClaimed(completeError)) {
        return true;
      }
      throw completeError;
    }
    return true;
  }
  if (cancelPromise) await cancelPromise;
  if (cancellationDetected) {
    return true;
  }

  const executorResult = executorOutcome.result;
  let result: OpenTagRunResult;
  try {
    result = await maybeCreatePullRequest({
      run: claimed.run,
      executor: executorId,
      event: claimed.event,
      binding,
      result: executorResult,
      options: input.pullRequestOptions ?? {}
    });
  } catch (error) {
    result = pullRequestPreparationFailureResult(executorResult, error);
  }
  try {
    await input.client.complete(runId, lease, result);
  } catch (error) {
    if (runNoLongerClaimed(error)) {
      return true;
    }
    throw error;
  }
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
  runTimeoutMs?: number;
  agentSessionProfile?: AgentSessionProfileConfig;
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
        ...(input.runTimeoutMs !== undefined ? { runTimeoutMs: input.runTimeoutMs } : {}),
        ...(input.agentSessionProfile ? { agentSessionProfile: input.agentSessionProfile } : {}),
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
