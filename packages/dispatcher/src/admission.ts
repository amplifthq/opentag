import {
  conversationKeysFromEvent,
  projectTargetRefFromEvent,
  RunAdmissionDecisionSchema,
  type OpenTagEvent,
  type OpenTagRun,
  type RunAdmissionDecision,
  type RunAdmissionReasonCode
} from "@opentag/core";
import { type FollowUpRequest, type RepoBinding, type createOpenTagRepository } from "@opentag/store";

type Repository = ReturnType<typeof createOpenTagRepository>;

export type AgentAccessProfileCheckInput = {
  event: OpenTagEvent;
  binding: RepoBinding;
};

export type AgentAccessProfileCheckResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      reasonCode?: Extract<RunAdmissionReasonCode, "agent_access_profile_denied" | "policy_rejected">;
    };

export type AgentAccessProfileCheck = (input: AgentAccessProfileCheckInput) => Promise<AgentAccessProfileCheckResult>;

export type AdmitRunInput = {
  requestId: string;
  event: OpenTagEvent;
};

export type AdmitRunResult =
  | {
      outcome: "start";
      decision: RunAdmissionDecision;
      binding?: RepoBinding;
    }
  | {
      outcome: "drop_duplicate";
      decision: RunAdmissionDecision;
      run: OpenTagRun;
      idempotentReplay: true;
    }
  | {
      outcome: "follow_up_queued";
      decision: RunAdmissionDecision;
      followUpRequest: FollowUpRequest;
    }
  | {
      outcome: "needs_human_decision";
      decision: RunAdmissionDecision;
    };

function isWriteCapable(event: OpenTagEvent): boolean {
  return event.permissions.some((permission) => ["repo:write", "pr:create", "pr:update"].includes(permission.scope));
}

function actorInAllowedList(event: OpenTagEvent, allowedActors: string[]): boolean {
  return allowedActors.includes(event.actor.handle ?? "") || allowedActors.includes(event.actor.providerUserId);
}

const SOURCE_WORK_ITEM_KINDS = new Set(["issue", "pull_request", "merge_request"]);

/** True when the event originated from a work item on a public GitHub/GitLab
 * repository. Uses the work-item context pointers, whose visibility the
 * platform adapters derive from the repository's own private/visibility flag
 * (GitLab "internal" is already collapsed to private by its adapter). */
export function sourceRepoIsPublic(event: OpenTagEvent): boolean {
  if (event.source !== "github" && event.source !== "gitlab") return false;
  return event.context.some(
    (pointer) => SOURCE_WORK_ITEM_KINDS.has(pointer.kind) && pointer.visibility === "public"
  );
}

type ActorGateResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      reasonCode: Extract<RunAdmissionReasonCode, "actor_not_allowed_for_write" | "actor_not_authorized_for_public_repo">;
    };

/** Decides whether the requesting actor may start a run for this binding.
 *
 * With an explicit `allowedActors` list the operator's intent wins: the list
 * gates write-capable runs, matching the pre-existing contract.
 *
 * Without a list, the default is platform-aware instead of allow-all:
 * anyone inside a closed surface (Slack workspace, Lark tenant, private
 * GitHub/GitLab repository) may trigger runs, but on a public repository the
 * actor must carry platform-reported write access (`actor.writeAccess`).
 * Platforms that cannot report access (GitLab Note Hooks) leave it unset, so
 * public projects there stay closed until `allowedActors` is configured. */
function evaluateActorGate(event: OpenTagEvent, allowedActors: string[] | undefined): ActorGateResult {
  if (allowedActors?.length) {
    if (isWriteCapable(event) && !actorInAllowedList(event, allowedActors)) {
      return {
        allowed: false,
        reason: "The requesting actor is not allowed to start a write-capable run in this repository.",
        reasonCode: "actor_not_allowed_for_write"
      };
    }
    return { allowed: true };
  }

  if (sourceRepoIsPublic(event) && event.actor.writeAccess !== true) {
    return {
      allowed: false,
      reason:
        "This repository is public and the requesting actor does not have write access to it. Ask a maintainer to grant write access, or configure allowedActors on the repository binding.",
      reasonCode: "actor_not_authorized_for_public_repo"
    };
  }

  return { allowed: true };
}

function admissionDecision(input: {
  action: RunAdmissionDecision["action"];
  reason: string;
  reasonCode: RunAdmissionReasonCode;
  event: OpenTagEvent;
  activeRunId?: string;
}): RunAdmissionDecision {
  return RunAdmissionDecisionSchema.parse({
    action: input.action,
    reason: input.reason,
    reasonCode: input.reasonCode,
    decidedAt: new Date().toISOString(),
    ...(input.activeRunId ? { activeRunId: input.activeRunId } : {}),
    eventId: input.event.id
  });
}

async function defaultAgentAccessProfileCheck(): Promise<AgentAccessProfileCheckResult> {
  return { allowed: true };
}

export function createAdmissionRuntime(input: {
  repo: Repository;
  agentAccessProfileCheck?: AgentAccessProfileCheck;
}) {
  const agentAccessProfileCheck = input.agentAccessProfileCheck ?? defaultAgentAccessProfileCheck;

  return {
    async admitRun(request: AdmitRunInput): Promise<AdmitRunResult> {
      const existingRun = await input.repo.getRunByEventId({ eventId: request.event.id });
      if (existingRun) {
        return {
          outcome: "drop_duplicate",
          decision: admissionDecision({
            action: "drop_duplicate",
            reason: "Source event already created a run.",
            reasonCode: "duplicate_source_event",
            event: request.event,
            activeRunId: existingRun.run.id
          }),
          run: existingRun.run,
          idempotentReplay: true
        };
      }

      const repoKey = projectTargetRefFromEvent(request.event);
      let binding: RepoBinding | undefined;
      if (!repoKey) {
        const metadata = request.event.metadata ?? {};
        const hasRepositoryMetadata = ["repoProvider", "owner", "repo"].some((key) => metadata[key] !== undefined);
        if (request.event.source === "github" || request.event.source === "gitlab" || hasRepositoryMetadata) {
          return {
            outcome: "needs_human_decision",
            decision: admissionDecision({
              action: "needs_human_decision",
              reason: "The repository-bearing event did not resolve to a complete repository context.",
              reasonCode: "repo_context_missing",
              event: request.event
            })
          };
        }
      } else {
        binding = (await input.repo.getRepoBinding(repoKey)) ?? undefined;
        if (!binding) {
          return {
            outcome: "needs_human_decision",
            decision: admissionDecision({
              action: "needs_human_decision",
              reason: "No repository binding is configured for this work context.",
              reasonCode: "repo_not_bound",
              event: request.event
            })
          };
        }

        const actorGate = evaluateActorGate(request.event, binding.allowedActors);
        if (!actorGate.allowed) {
          return {
            outcome: "needs_human_decision",
            decision: admissionDecision({
              action: "needs_human_decision",
              reason: actorGate.reason,
              reasonCode: actorGate.reasonCode,
              event: request.event
            })
          };
        }

        const accessDecision = await agentAccessProfileCheck({ event: request.event, binding });
        if (!accessDecision.allowed) {
          return {
            outcome: "needs_human_decision",
            decision: admissionDecision({
              action: "needs_human_decision",
              reason: accessDecision.reason,
              reasonCode: accessDecision.reasonCode ?? "agent_access_profile_denied",
              event: request.event
            })
          };
        }
      }

      let activeRun: { run: OpenTagRun; event: OpenTagEvent } | null = null;
      for (const conversationKey of conversationKeysFromEvent(request.event)) {
        activeRun = await input.repo.findActiveRunForConversation({ conversationKey });
        if (activeRun) break;
      }
      if (activeRun) {
        const decision = admissionDecision({
          action: "queue_follow_up",
          reason: "A run is already active for this thread; queue the new request as follow-up work.",
          reasonCode: isWriteCapable(request.event) ? "active_write_run_same_thread" : "active_run_same_thread",
          event: request.event,
          activeRunId: activeRun.run.id
        });
        const { followUpRequest, created } = await input.repo.createFollowUpRequest({
          id: request.requestId,
          event: request.event,
          decision,
          activeRunId: activeRun.run.id
        });
        if (created) {
          await input.repo.appendRunEvent({
            runId: activeRun.run.id,
            type: "follow_up_request.queued",
            payload: { followUpRequestId: followUpRequest.id, sourceEventId: request.event.id },
            visibility: "audit",
            importance: "normal",
            message: decision.reason
          });
        }
        return {
          outcome: "follow_up_queued",
          decision,
          followUpRequest
        };
      }

      return {
        outcome: "start",
        decision: admissionDecision({
          action: "start",
          reason: "Source event accepted and ready to create a run.",
          reasonCode: "new_event",
          event: request.event
        }),
        ...(binding ? { binding } : {})
      };
    }
  };
}
