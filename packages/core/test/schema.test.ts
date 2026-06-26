import { describe, expect, it } from "vitest";
import {
  ApprovalDecisionSchema,
  ApplyPlanSchema,
  CapabilityContractSchema,
  ContextPacketSchema,
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  OpenTagRunSchema,
  PolicyResolutionSchema,
  RunAdmissionDecisionSchema,
  RunEventSchema,
  SuccessMetricNameSchema,
  SuggestedChangesSnapshotSchema,
  WorkThreadSchema
} from "../src/schema.js";

describe("OpenTagEventSchema", () => {
  it("accepts a valid GitHub event", () => {
    const parsed = OpenTagEventSchema.parse({
      id: "evt_1",
      source: "github",
      sourceEventId: "12345",
      receivedAt: "2026-06-24T00:00:00.000Z",
      actor: {
        provider: "github",
        providerUserId: "42",
        handle: "octocat"
      },
      target: {
        mention: "@opentag",
        agentId: "opentag"
      },
      command: {
        rawText: "fix this",
        intent: "fix",
        args: {}
      },
      context: [
        {
          provider: "github",
          kind: "issue",
          uri: "https://github.com/acme/demo/issues/1",
          visibility: "public"
        }
      ],
      permissions: [
        {
          scope: "issue:comment",
          reason: "reply to source thread"
        }
      ],
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments"
      },
      metadata: {}
    });

    expect(parsed.source).toBe("github");
  });

  it("accepts a valid Telegram event", () => {
    const parsed = OpenTagEventSchema.parse({
      id: "evt_tg_1",
      source: "telegram",
      sourceEventId: "update_123",
      receivedAt: "2026-06-25T00:00:00.000Z",
      actor: {
        provider: "telegram",
        providerUserId: "456",
        handle: "alice"
      },
      target: {
        mention: "@opentag_bot",
        agentId: "opentag"
      },
      command: {
        rawText: "fix this",
        intent: "fix",
        args: {}
      },
      context: [
        {
          provider: "telegram",
          kind: "message",
          uri: "telegram://bot/123/chat/456/message/789",
          visibility: "organization"
        }
      ],
      permissions: [
        {
          scope: "chat:postMessage",
          reason: "reply to source thread"
        }
      ],
      callback: {
        provider: "telegram",
        uri: "https://api.telegram.org/sendMessage",
        threadKey: "123|456|789|"
      },
      metadata: {}
    });

    expect(parsed.source).toBe("telegram");
    expect(parsed.callback.provider).toBe("telegram");
  });

  it("accepts adapter-defined providers and context kinds without changing core", () => {
    const parsed = OpenTagEventSchema.parse({
      id: "evt_linear_1",
      source: "linear",
      sourceEventId: "comment_123",
      receivedAt: "2026-06-25T00:00:00.000Z",
      actor: {
        provider: "linear",
        providerUserId: "user_123"
      },
      target: {
        mention: "@opentag",
        agentId: "opentag"
      },
      command: {
        rawText: "triage this",
        intent: "run",
        args: {}
      },
      context: [
        {
          provider: "linear",
          kind: "issue",
          uri: "linear://issue/ENG-123",
          visibility: "organization"
        }
      ],
      permissions: [
        {
          scope: "issue:comment",
          reason: "reply to source thread"
        }
      ],
      callback: {
        provider: "linear",
        uri: "linear://comment/123"
      },
      metadata: {}
    });

    expect(parsed.context[0]).toMatchObject({ provider: "linear", kind: "issue" });
  });

  it("rejects legacy provider-prefixed context kinds", () => {
    expect(() =>
      OpenTagEventSchema.parse({
        id: "evt_legacy_kind",
        source: "github",
        sourceEventId: "comment_legacy_kind",
        receivedAt: "2026-06-25T00:00:00.000Z",
        actor: {
          provider: "github",
          providerUserId: "42"
        },
        target: {
          mention: "@opentag",
          agentId: "opentag"
        },
        command: {
          rawText: "fix this",
          intent: "fix",
          args: {}
        },
        context: [
          {
            kind: "github.issue",
            uri: "https://github.com/acme/demo/issues/1",
            visibility: "public"
          }
        ],
        permissions: [
          {
            scope: "issue:comment",
            reason: "reply to source thread"
          }
        ],
        callback: {
          provider: "github",
          uri: "https://api.github.com/repos/acme/demo/issues/1/comments"
        },
        metadata: {}
      })
    ).toThrow(/provider prefix/);
  });

  it("accepts the current public executor hints", () => {
    for (const executorHint of ["claude-code", "codex", "hermes", "openclaw", "custom"]) {
      expect(
        OpenTagEventSchema.parse({
          id: `evt_${executorHint}`,
          source: "github",
          sourceEventId: `comment_${executorHint}`,
          receivedAt: "2026-06-24T00:00:00.000Z",
          actor: { provider: "github", providerUserId: "42" },
          target: {
            mention: "@opentag",
            agentId: "opentag",
            executorHint
          },
          command: { rawText: "run this", intent: "run", args: {} },
          context: [],
          permissions: [{ scope: "runner:local", reason: "execute locally" }],
          callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
          metadata: { owner: "acme", repo: "demo" }
        }).target.executorHint
      ).toBe(executorHint);
    }
  });

  it("rejects the retired oh-my-pi executor hint", () => {
    expect(() =>
      OpenTagEventSchema.parse({
        id: "evt_old_executor",
        source: "github",
        sourceEventId: "comment_old_executor",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42" },
        target: {
          mention: "@opentag",
          agentId: "opentag",
          executorHint: "oh-my-pi"
        },
        command: { rawText: "run this", intent: "run", args: {} },
        context: [],
        permissions: [{ scope: "runner:local", reason: "execute locally" }],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
        metadata: { owner: "acme", repo: "demo" }
      })
    ).toThrow();
  });
});

describe("Agent Work Protocol schemas", () => {
  it("accepts a work item thread with one primary control anchor", () => {
    const thread = WorkThreadSchema.parse({
      id: "thread_github_1",
      workItemReference: {
        provider: "github",
        kind: "issue",
        externalId: "acme/demo#123",
        uri: "https://github.com/acme/demo/issues/123",
        ownerContainer: {
          provider: "github",
          id: "acme/demo",
          uri: "https://github.com/acme/demo"
        }
      },
      primaryAnchor: {
        provider: "github",
        kind: "issue_comment_thread",
        externalId: "comment_456",
        uri: "https://github.com/acme/demo/issues/123#issuecomment-456",
        controlPlane: true,
        canApprove: true
      },
      secondaryAnchors: [
        {
          provider: "slack",
          kind: "thread",
          externalId: "T123:C123:1710000000.000100",
          uri: "https://slack.com/app_redirect?channel=C123",
          threadKey: "T123|C123|1710000000.000100",
          controlPlane: false,
          canApprove: false
        }
      ]
    });

    expect(thread.workItemReference.provider).toBe("github");
    expect(thread.primaryAnchor.canApprove).toBe(true);
    expect(thread.secondaryAnchors?.[0]?.controlPlane).toBe(false);
  });

  it("accepts a minimal context packet with assembly stages", () => {
    const packet = ContextPacketSchema.parse({
      summary: "Investigate the failing test on the linked issue.",
      sourcePointers: [{ provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/123", visibility: "public" }],
      intent: {
        rawText: "@opentag investigate flaky test",
        normalizedIntent: "investigate",
        requestedBy: { provider: "github", providerUserId: "42", handle: "octocat" }
      },
      sources: [
        {
          pointer: { provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/123", visibility: "public" },
          role: "primary",
          included: true,
          reason: "The issue is the primary source for the request."
        }
      ],
      facts: [{ text: "The issue reports a flaky test in CI.", sourceUri: "https://github.com/acme/demo/issues/123" }],
      risks: ["The executor should not push directly to the default branch."],
      exclusions: ["Do not change unrelated Slack callback presentation work."],
      assembly: {
        stages: ["collect", "classify", "filter", "preserve", "summarize", "budget", "emit"],
        budgetTokens: 4000,
        emittedAt: "2026-06-24T00:00:00.000Z"
      }
    });

    expect(packet.assembly?.stages).toContain("budget");
    expect(packet.intent?.normalizedIntent).toBe("investigate");
    expect(packet.sources?.[0]?.role).toBe("primary");
  });

  it("accepts run events with visibility and importance", () => {
    const event = RunEventSchema.parse({
      runId: "run_1",
      type: "run.waiting_for_permission",
      createdAt: "2026-06-24T00:00:00.000Z",
      visibility: "human",
      importance: "blocking",
      message: "Approval is required before applying suggested changes.",
      payload: { proposalId: "proposal_1" }
    });

    expect(event.visibility).toBe("human");
    expect(event.importance).toBe("blocking");
  });

  it("accepts run admission decisions", () => {
    const decision = RunAdmissionDecisionSchema.parse({
      action: "drop_duplicate",
      reason: "Source event already created a run.",
      reasonCode: "duplicate_source_event",
      decidedAt: "2026-06-25T00:00:00.000Z",
      activeRunId: "run_existing",
      eventId: "evt_duplicate"
    });

    expect(decision.reasonCode).toBe("duplicate_source_event");
    expect(decision.activeRunId).toBe("run_existing");
  });

  it("models capability contracts and policy resolution separately from platform permissions", () => {
    const capability = CapabilityContractSchema.parse({
      id: "create_pr",
      semanticAction: "create_pull_request",
      capabilityClass: "external_write",
      requiresExplicitIntent: true,
      mayAutoApplyByPolicy: true,
      adapterTargets: ["github"],
      requiredPermissionScopes: ["pr:create"],
      requiredExecutorConditions: ["local runner completed on isolated branch"]
    });

    const resolution = PolicyResolutionSchema.parse({
      capabilityId: capability.id,
      decision: "allow",
      resolvedBy: "work_context_owner_container",
      rules: [
        {
          id: "repo_allows_pr_creation",
          scope: "work_context_owner_container",
          effect: "allow",
          capabilityId: "create_pr",
          reason: "Repository policy allows explicit PR creation."
        }
      ],
      reason: "Platform permission and OpenTag repo policy both allow PR creation."
    });

    expect(capability.capabilityClass).toBe("external_write");
    expect(resolution.decision).toBe("allow");
  });

  it("exposes protocol success metric names", () => {
    expect(SuccessMetricNameSchema.parse("thread_noise_ratio")).toBe("thread_noise_ratio");
  });

  it("models immutable suggested changes, subset approval, and apply outcomes", () => {
    const proposal = SuggestedChangesSnapshotSchema.parse({
      proposalId: "proposal_1",
      createdAt: "2026-06-24T00:00:00.000Z",
      sourceRunId: "run_1",
      summary: "Move the issue forward with owner and label updates.",
      intents: [
        {
          intentId: "intent_assignee_1",
          domain: "assignee",
          action: "set_assignee",
          summary: "Assign the issue to Alice.",
          params: { assignee: "alice" }
        },
        {
          intentId: "intent_label_1",
          domain: "labels",
          action: "add_label",
          summary: "Add the bug label.",
          params: { label: "bug" }
        }
      ],
      preconditions: ["Issue updated_at matched 2026-06-24T00:00:00.000Z"]
    });

    const decision = ApprovalDecisionSchema.parse({
      id: "approval_1",
      proposalId: proposal.proposalId,
      approvedIntentIds: ["intent_label_1"],
      rejectedIntentIds: ["intent_assignee_1"],
      approvedBy: { provider: "github", providerUserId: "42", handle: "octocat" },
      approvedAt: "2026-06-24T00:01:00.000Z",
      scope: "manual"
    });

    const applyPlan = ApplyPlanSchema.parse({
      id: "apply_1",
      proposalId: proposal.proposalId,
      approvalDecisionId: decision.id,
      selectedIntentIds: decision.approvedIntentIds,
      adapter: "github",
      outcomes: [{ intentId: "intent_label_1", outcome: "applied", externalUri: "https://github.com/acme/demo/issues/123" }]
    });

    expect(proposal.intents).toHaveLength(2);
    expect(decision.approvedIntentIds).toEqual(["intent_label_1"]);
    expect(applyPlan.mode).toBe("preflight_then_per_intent");
    expect(applyPlan.outcomes?.[0]?.outcome).toBe("applied");
  });

  it("accepts structured next actions while preserving legacy string next actions", () => {
    const structured = OpenTagRunResultSchema.parse({
      conclusion: "needs_human",
      summary: "I prepared a suggested change snapshot.",
      suggestedChanges: [
        {
          proposalId: "proposal_1",
          createdAt: "2026-06-24T00:00:00.000Z",
          summary: "Add the bug label.",
          intents: [
            {
              intentId: "intent_label_1",
              domain: "labels",
              action: "add_label",
              summary: "Add the bug label.",
              params: { label: "bug" }
            }
          ]
        }
      ],
      nextAction: {
        summary: "Approve intent_label_1 to add the bug label.",
        hint: {
          kind: "apply_suggested_changes",
          targetId: "proposal_1",
          selectedIntentIds: ["intent_label_1"]
        }
      }
    });

    const legacy = OpenTagRunResultSchema.parse({
      conclusion: "success",
      summary: "Done.",
      nextAction: "Review the branch."
    });

    expect(typeof structured.nextAction).toBe("object");
    expect(legacy.nextAction).toBe("Review the branch.");
  });

  it("adds optional run lineage without changing the existing run contract", () => {
    const run = OpenTagRunSchema.parse({
      id: "run_2",
      eventId: "evt_2",
      status: "queued",
      parentRunId: "run_1",
      triggeredByAction: {
        kind: "generate_patch",
        targetId: "proposal_1"
      },
      sourceProposalId: "proposal_1",
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z"
    });

    expect(run.parentRunId).toBe("run_1");
    expect(run.triggeredByAction?.kind).toBe("generate_patch");
  });
});
