import {
  type ActionReceiptContext,
  type ActionReceiptDecision,
  type OpenTagActionReceiptPresentation,
  type OpenTagDoctorSummaryPresentation,
  type OpenTagFinalSummaryPresentation,
  type OpenTagPresentationAction,
  type OpenTagSourceThreadStatusPresentation,
  createFinalSummaryPresentation,
  type OpenTagRunResult
} from "@opentag/core";

export type SlackTextBlock = {
  type: "section";
  text: {
    type: "mrkdwn";
    text: string;
  };
};

export type SlackDividerBlock = {
  type: "divider";
};

export type SlackContextBlock = {
  type: "context";
  elements: Array<{
    type: "mrkdwn";
    text: string;
  }>;
};

export type SlackButtonElement = {
  type: "button";
  text: {
    type: "plain_text";
    text: string;
    emoji?: boolean;
  };
  action_id: string;
  value: string;
  style?: "primary" | "danger";
};

export type SlackActionsBlock = {
  type: "actions";
  block_id?: string;
  elements: SlackButtonElement[];
};

export type SlackBlock = SlackTextBlock | SlackDividerBlock | SlackContextBlock | SlackActionsBlock;

export type SlackSuggestedActionButtonValue = {
  version: 1;
  command: string;
  proposalId: string;
  intentId: string;
};

export type SlackMessagePayload = {
  channel: string;
  text: string;
  thread_ts?: string;
  ts?: string;
  blocks?: SlackBlock[];
};

export type SlackReactionPayload = {
  channel: string;
  timestamp: string;
  name: string;
};

export type SlackSourceReceiptState = "received" | "running";

const MAX_SLACK_SUGGESTED_ACTION_CANDIDATES = 20;

export type SlackRenderOptions = {
  receiptContext?: ActionReceiptContext;
  auditRunId?: string;
};

export function buildSlackSuggestedActionButtonValue(input: SlackSuggestedActionButtonValue): string {
  return JSON.stringify(input);
}

export function parseSlackSuggestedActionButtonValue(value: string): SlackSuggestedActionButtonValue | null {
  try {
    const parsed = JSON.parse(value) as Partial<SlackSuggestedActionButtonValue>;
    if (
      parsed.version !== 1 ||
      typeof parsed.command !== "string" ||
      parsed.command.trim().length === 0 ||
      typeof parsed.proposalId !== "string" ||
      parsed.proposalId.length === 0 ||
      typeof parsed.intentId !== "string" ||
      parsed.intentId.length === 0
    ) {
      return null;
    }
    return {
      version: 1,
      command: parsed.command.trim(),
      proposalId: parsed.proposalId,
      intentId: parsed.intentId
    };
  } catch {
    return null;
  }
}

function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function markdownToSlackMrkdwn(text: string): string {
  const links: string[] = [];
  const withoutLinks = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    const token = `\u0000SLACK_LINK_${links.length}\u0000`;
    links.push(`<${url}|${escapeSlackText(label)}>`);
    return token;
  });
  const converted = escapeSlackText(withoutLinks)
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*");
  return links.reduce((output, link, index) => output.replace(`\u0000SLACK_LINK_${index}\u0000`, link), converted);
}

function markdownToSlackActionDetail(text: string): string {
  return markdownToSlackMrkdwn(text).replace(/-&gt;/g, "->");
}

export function renderSlackAcknowledgement(runId: string): string {
  void runId;
  return "Working on it.";
}

export function slackSourceReceiptReactionName(state: SlackSourceReceiptState): string {
  if (state === "received") return "eyes";
  if (state === "running") return "hourglass_flowing_sand";
  return "eyes";
}

export function createSlackReactionPayload(input: { channelId: string; messageTs: string; name: string }): SlackReactionPayload {
  return {
    channel: input.channelId,
    timestamp: input.messageTs,
    name: input.name
  };
}

function truncateSlackText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function firstMarkdownSection(text: string, heading: string): string | undefined {
  const pattern = new RegExp(`\\*\\*${heading}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\s*\\n\\*\\*[^*]+:\\*\\*|\\n\\s*\\n[A-Z][^\\n]{0,60}:|$)`, "i");
  const match = text.match(pattern);
  return match?.[1]?.trim();
}

function compactSlackSummary(summary: string): string {
  const whatChanged = firstMarkdownSection(summary, "What changed");
  const firstParagraph = summary
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find(Boolean);
  const selected = whatChanged ?? firstParagraph ?? summary;
  return truncateSlackText(selected.replace(/^\*\*[^*]+:\*\*\s*/i, ""), 360);
}

function compactNextAction(nextAction: string): string {
  return truncateSlackText(nextAction, 180);
}

function resultForFinalSummaryPresentation(result: OpenTagRunResult): OpenTagRunResult {
  if (!result.suggestedChanges) return result;
  const visibleSuggestedChanges = result.suggestedChanges.filter((snapshot) => snapshot.intents.length > 0);
  if (visibleSuggestedChanges.length === result.suggestedChanges.length) return result;
  const { suggestedChanges: _suggestedChanges, ...withoutSuggestedChanges } = result;
  return visibleSuggestedChanges.length > 0 ? { ...withoutSuggestedChanges, suggestedChanges: visibleSuggestedChanges } : withoutSuggestedChanges;
}

function slackSection(text: string): SlackTextBlock {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text
    }
  };
}

function slackContext(text: string): SlackContextBlock {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text }]
  };
}

function slackCheckStatusLabel(status: OpenTagDoctorSummaryPresentation["checks"][number]["status"]): string {
  if (status === "ok") return "OK";
  if (status === "warn") return "WARN";
  if (status === "fail") return "FAIL";
  return "UNKNOWN";
}

function slackStatusActiveRun(presentation: OpenTagSourceThreadStatusPresentation): string {
  if (!presentation.activeRun) return "none";
  return `${presentation.activeRun.id} (${presentation.activeRun.status})${presentation.activeRun.updatedAt ? `, updated ${presentation.activeRun.updatedAt}` : ""}`;
}

function slackStatusQueuedFollowUps(presentation: OpenTagSourceThreadStatusPresentation): string {
  const total = presentation.queuedFollowUpsTotal ?? presentation.queuedFollowUps.length;
  if (total === 0) return "none";
  const visible = presentation.queuedFollowUps.map((followUp) => {
    const status = followUp.status ? ` (${followUp.status})` : "";
    const command = followUp.command ? `: ${markdownToSlackMrkdwn(truncateSlackText(followUp.command, 120))}` : "";
    return `${followUp.id}${status}${command}`;
  });
  const remaining = Math.max(total - visible.length, 0);
  return `${total}${visible.length ? ` (${visible.join(", ")}${remaining > 0 ? `, +${remaining} more` : ""})` : ""}`;
}

function renderPresentationActionLines(action: OpenTagPresentationAction): string[] {
  const lines = [`${action.index}. *${markdownToSlackMrkdwn(action.title)}*`];
  lines.push(`Target: ${markdownToSlackMrkdwn(action.targetLabel)}`);
  if (action.setupReason) {
    lines.push(`Status: ${markdownToSlackMrkdwn(action.setupReason)}`);
  }
  if (action.details?.length) {
    lines.push(...action.details.map(markdownToSlackActionDetail));
  }
  return lines;
}

type SlackActionReceiptGroup = {
  state: OpenTagPresentationAction["state"];
  title: string;
  actions: OpenTagPresentationAction[];
};

const ACTION_RECEIPT_GROUP_ORDER: Array<OpenTagPresentationAction["state"]> = [
  "ready_to_apply",
  "needs_setup",
  "needs_approval",
  "unsupported"
];

function actionReceiptGroupTitle(state: OpenTagPresentationAction["state"]): string {
  if (state === "ready_to_apply") return "Ready to apply";
  if (state === "needs_setup") return "Needs setup";
  if (state === "unsupported") return "Needs attention";
  return "Needs approval";
}

function actionReceiptGroups(actions: OpenTagPresentationAction[]): SlackActionReceiptGroup[] {
  return ACTION_RECEIPT_GROUP_ORDER.flatMap((state) => {
    const groupedActions = actions.filter((action) => action.state === state);
    return groupedActions.length > 0
      ? [
          {
            state,
            title: actionReceiptGroupTitle(state),
            actions: groupedActions
          }
        ]
      : [];
  });
}

function renderActionReceiptMarkdownLines(input: { title: string; actions: OpenTagPresentationAction[] }): string[] {
  if (input.actions.length === 0) return [];

  const visibleActions = input.actions.slice(0, MAX_SLACK_SUGGESTED_ACTION_CANDIDATES);
  const groups = actionReceiptGroups(visibleActions);
  const showGroupHeadings = groups.length > 1;
  const lines = [`*${input.title}*`, "", "Choose an action in this thread. Details stay in the OpenTag audit log."];
  for (const group of groups) {
    if (showGroupHeadings) {
      lines.push("", `*${group.title}*`);
    }
    for (const action of group.actions) {
      lines.push("", ...renderPresentationActionLines(action));
    }
  }

  const remainingCount = input.actions.length - visibleActions.length;
  if (remainingCount > 0) {
    lines.push("", `Showing first ${visibleActions.length} of ${input.actions.length} actions. Reply with an action number for the rest.`);
  }
  lines.push("", "Use the buttons below, or reply with the matching command.");
  return lines;
}

function renderSuggestedActionsMarkdown(presentation: OpenTagFinalSummaryPresentation): string[] {
  const actions = presentation.actions ?? [];
  if (actions.length === 0 || !presentation.actionReceiptTitle) return [];
  return renderActionReceiptMarkdownLines({ title: presentation.actionReceiptTitle, actions });
}

function createSuggestedActionButton(action: OpenTagPresentationAction & { proposalId: string; intentId: string }, decision: ActionReceiptDecision): SlackButtonElement {
  const index = action.index;
  const labels: Record<ActionReceiptDecision, string> = {
    apply: `Apply ${index}`,
    approve: "Approve only",
    continue: "Continue",
    reject: "Reject"
  };
  return {
    type: "button",
    text: { type: "plain_text", text: labels[decision], emoji: true },
    action_id: `opentag:${decision}:${index}`,
    value: buildSlackSuggestedActionButtonValue({
      version: 1,
      command: `${decision} ${index}`,
      proposalId: action.proposalId,
      intentId: action.intentId
    }),
    ...(decision === "apply" ? { style: "primary" as const } : {}),
    ...(decision === "reject" ? { style: "danger" as const } : {})
  };
}

function actionHasInteractiveIdentity(action: OpenTagPresentationAction): action is OpenTagPresentationAction & { proposalId: string; intentId: string } {
  return Boolean(action.proposalId && action.intentId);
}

function createSuggestedActionButtons(action: OpenTagPresentationAction): SlackButtonElement[] {
  if (!actionHasInteractiveIdentity(action)) return [];
  return action.visibleDecisions.map((decision) => createSuggestedActionButton(action, decision));
}

function createSlackActionReceiptBlockSet(input: {
  title: string;
  actions: OpenTagPresentationAction[];
  auditRunId?: string;
  includeDivider?: boolean;
}): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  if (input.includeDivider) blocks.push({ type: "divider" });
  blocks.push(
    slackSection(`*${markdownToSlackMrkdwn(input.title)}*\n\nChoose an action in this thread. Details stay in the OpenTag audit log.`)
  );

  const visibleActions = input.actions.slice(0, MAX_SLACK_SUGGESTED_ACTION_CANDIDATES);
  const groups = actionReceiptGroups(visibleActions);
  const showGroupHeadings = groups.length > 1;
  for (const group of groups) {
    if (showGroupHeadings) {
      blocks.push(slackSection(`*${markdownToSlackMrkdwn(group.title)}*`));
    }
    for (const action of group.actions) {
      blocks.push(slackSection(renderPresentationActionLines(action).join("\n")));
      const buttons = createSuggestedActionButtons(action);
      if (buttons.length === 0) continue;
      blocks.push({
        type: "actions",
        block_id: `opentag_actions_${action.index}`,
        elements: buttons
      });
    }
  }

  const remainingCount = input.actions.length - visibleActions.length;
  if (remainingCount > 0) {
    blocks.push(slackSection(`Showing first ${visibleActions.length} of ${input.actions.length} actions. Reply with an action number for the rest.`));
  }

  if (input.auditRunId) {
    blocks.push(slackContext(markdownToSlackMrkdwn(`Audit: \`opentag status --run ${input.auditRunId}\``)));
  }

  return blocks;
}

export function renderSlackActionReceiptPresentation(presentation: OpenTagActionReceiptPresentation): string {
  const lines = renderActionReceiptMarkdownLines({ title: presentation.title, actions: presentation.actions });
  if (presentation.auditRunId) {
    lines.push("", markdownToSlackMrkdwn(`Audit: \`opentag status --run ${presentation.auditRunId}\``));
  }
  return lines.join("\n");
}

export function createSlackActionReceiptBlocks(presentation: OpenTagActionReceiptPresentation): SlackBlock[] {
  return createSlackActionReceiptBlockSet({
    title: presentation.title,
    actions: presentation.actions,
    ...(presentation.auditRunId ? { auditRunId: presentation.auditRunId } : {})
  });
}

export function renderSlackFinalResult(result: OpenTagRunResult, options: SlackRenderOptions = {}): string {
  return renderSlackFinalSummaryPresentation(
    createFinalSummaryPresentation({
      result: resultForFinalSummaryPresentation(result),
      ...(options.receiptContext ? { receiptContext: options.receiptContext } : {}),
      ...(options.auditRunId ? { auditRunId: options.auditRunId } : {})
    })
  );
}

export function renderSlackFinalSummaryPresentation(presentation: OpenTagFinalSummaryPresentation): string {
  const lines = [`*Finished: ${presentation.outcome}.*`, markdownToSlackMrkdwn(compactSlackSummary(presentation.summary))];

  if (presentation.verification?.length) {
    lines.push(
      `Verified: ${presentation.verification
        .slice(0, 3)
        .map((check) => `\`${markdownToSlackMrkdwn(check.command)}\` ${markdownToSlackMrkdwn(check.outcome)}`)
        .join(", ")}`
    );
  }

  const suggestedActions = renderSuggestedActionsMarkdown(presentation);
  if (presentation.nextActions?.length && suggestedActions.length === 0) {
    lines.push(`Next: ${markdownToSlackMrkdwn(compactNextAction(presentation.nextActions[0] ?? ""))}`);
  }
  if (suggestedActions.length > 0) {
    lines.push("", ...suggestedActions);
  }
  if (presentation.auditRunId) {
    lines.push("", markdownToSlackMrkdwn(`Audit: \`opentag status --run ${presentation.auditRunId}\``));
  }

  return lines.join("\n");
}

export function createSlackFinalResultBlocks(result: OpenTagRunResult, options: SlackRenderOptions = {}): SlackBlock[] {
  return createSlackFinalSummaryBlocks(
    createFinalSummaryPresentation({
      result: resultForFinalSummaryPresentation(result),
      ...(options.receiptContext ? { receiptContext: options.receiptContext } : {}),
      ...(options.auditRunId ? { auditRunId: options.auditRunId } : {})
    })
  );
}

export function createSlackFinalSummaryBlocks(presentation: OpenTagFinalSummaryPresentation): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Finished: ${presentation.outcome}.*\n${markdownToSlackMrkdwn(compactSlackSummary(presentation.summary))}`
      }
    }
  ];

  if (presentation.verification?.length) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Verified: ${markdownToSlackMrkdwn(
          presentation.verification
            .slice(0, 3)
            .map((check) => `\`${check.command}\` ${check.outcome}`)
            .join(", ")
        )}`
      }
    });
  }

  const actions = presentation.actions ?? [];
  if (presentation.nextActions?.length && actions.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Next: ${markdownToSlackMrkdwn(compactNextAction(presentation.nextActions[0] ?? ""))}`
      }
    });
  }

  if (actions.length > 0 && presentation.actionReceiptTitle) {
    blocks.push(...createSlackActionReceiptBlockSet({ title: presentation.actionReceiptTitle, actions, includeDivider: true }));
  }

  if (presentation.auditRunId) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: markdownToSlackMrkdwn(`Audit: \`opentag status --run ${presentation.auditRunId}\``)
        }
      ]
    });
  }

  return blocks;
}

export function createSlackDoctorSummaryBlocks(presentation: OpenTagDoctorSummaryPresentation): SlackBlock[] {
  const blocks: SlackBlock[] = [slackSection(`*${markdownToSlackMrkdwn(presentation.title)}*`)];
  if (presentation.checks.length === 0) {
    blocks.push(slackContext("No readiness checks were reported."));
    return blocks;
  }

  for (const check of presentation.checks.slice(0, 10)) {
    blocks.push(
      slackSection(
        `*${slackCheckStatusLabel(check.status)} ${markdownToSlackMrkdwn(check.name)}*${check.message ? `\n${markdownToSlackMrkdwn(check.message)}` : ""}`
      )
    );
  }
  if (presentation.checks.length > 10) {
    blocks.push(slackContext(`Showing first 10 of ${presentation.checks.length} readiness checks. Use \`opentag doctor\` locally for full detail.`));
  }
  return blocks;
}

export function createSlackSourceThreadStatusBlocks(presentation: OpenTagSourceThreadStatusPresentation): SlackBlock[] {
  const blocks: SlackBlock[] = [
    slackSection(`*${markdownToSlackMrkdwn(presentation.title)}*`),
    slackContext(
      [
        presentation.sourceContainer ? `Source: \`${presentation.sourceContainer}\`` : undefined,
        `Project Target: \`${presentation.projectTarget ?? "not bound"}\``
      ]
        .filter((line): line is string => Boolean(line))
        .join(" | ")
    ),
    slackSection(
      [
        `*Active run:* ${markdownToSlackMrkdwn(slackStatusActiveRun(presentation))}`,
        presentation.currentCommand ? `*Command:* ${markdownToSlackMrkdwn(presentation.currentCommand)}` : undefined,
        `*Queued follow-ups:* ${markdownToSlackMrkdwn(slackStatusQueuedFollowUps(presentation))}`,
        `*Next action:* ${markdownToSlackMrkdwn(presentation.nextAction)}`
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    )
  ];

  if (presentation.stopHint || presentation.detailHint) {
    blocks.push(
      slackContext(
        [
          presentation.stopHint ? `Stop/timeout: ${presentation.stopHint}` : undefined,
          presentation.detailHint ? `Details: ${presentation.detailHint}` : undefined
        ]
          .filter((line): line is string => Boolean(line))
          .map(markdownToSlackMrkdwn)
          .join(" | ")
      )
    );
  }
  return blocks;
}

export function createSlackPostMessagePayload(input: { channelId: string; text: string; threadTs: string; blocks?: SlackBlock[] }): SlackMessagePayload {
  return {
    channel: input.channelId,
    text: markdownToSlackMrkdwn(input.text),
    thread_ts: input.threadTs,
    ...(input.blocks?.length ? { blocks: input.blocks } : {})
  };
}

export function createSlackUpdateMessagePayload(input: { channelId: string; text: string; messageTs: string; blocks?: SlackBlock[] }): SlackMessagePayload {
  return {
    channel: input.channelId,
    text: markdownToSlackMrkdwn(input.text),
    ts: input.messageTs,
    ...(input.blocks?.length ? { blocks: input.blocks } : {})
  };
}
