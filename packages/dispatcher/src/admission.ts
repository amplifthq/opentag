import {
  conversationKeyFromEvent,
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
      binding: RepoBinding;
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

function actorIsAllowed(event: OpenTagEvent, allowedActors: string[] | undefined): boolean {
  if (!allowedActors?.length) return true;
  return allowedActors.includes(event.actor.handle ?? "") || allowedActors.includes(event.actor.providerUserId);
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
      if (!repoKey) {
        return {
          outcome: "needs_human_decision",
          decision: admissionDecision({
            action: "needs_human_decision",
            reason: "The event did not resolve to a repository context.",
            reasonCode: "repo_context_missing",
            event: request.event
          })
        };
      }

      const binding = await input.repo.getRepoBinding(repoKey);
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

      if (isWriteCapable(request.event) && !actorIsAllowed(request.event, binding.allowedActors)) {
        return {
          outcome: "needs_human_decision",
          decision: admissionDecision({
            action: "needs_human_decision",
            reason: "The requesting actor is not allowed to start a write-capable run in this repository.",
            reasonCode: "actor_not_allowed_for_write",
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

      const activeRun = await input.repo.findActiveRunForConversation({
        conversationKey: conversationKeyFromEvent(request.event)
      });
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
        binding
      };
    }
  };
}
