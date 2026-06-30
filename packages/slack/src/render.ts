import {
  actionReceiptHeading,
  buildActionReceiptsFromResult,
  type ActionReceipt,
  type ActionReceiptContext,
  type ActionReceiptDecision,
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

export type SlackBlock = SlackTextBlock | SlackDividerBlock | SlackActionsBlock;

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

export type SlackSourceReceiptState = "received";

const MAX_SLACK_SUGGESTED_ACTION_CANDIDATES = 20;

export type SlackRenderOptions = {
  receiptContext?: ActionReceiptContext;
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

export function renderSlackAcknowledgement(runId: string): string {
  void runId;
  return "Working on it.";
}

export function slackSourceReceiptReactionName(state: SlackSourceReceiptState): string {
  if (state === "received") return "eyes";
  return "eyes";
}

export function createSlackReactionPayload(input: { channelId: string; messageTs: string; name: string }): SlackReactionPayload {
  return {
    channel: input.channelId,
    timestamp: input.messageTs,
    name: input.name
  };
}

function nextActionSummary(result: OpenTagRunResult): string | undefined {
  if (!result.nextAction) return undefined;
  if (typeof result.nextAction === "string") return result.nextAction;
  return result.nextAction.summary;
}

function stringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayParam(params: Record<string, unknown> | undefined, key: string): string[] {
  const value = params?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function renderVerificationParams(params: Record<string, unknown> | undefined): string[] {
  const value = params?.["verification"];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
      const command = (item as Record<string, unknown>)["command"];
      const outcome = (item as Record<string, unknown>)["outcome"];
      return typeof command === "string" && typeof outcome === "string" ? `   - \`${command}\`: ${outcome}` : undefined;
    })
    .filter((line): line is string => Boolean(line));
}

function renderSuggestedActionDetails(params: Record<string, unknown> | undefined, action: string): string[] {
  if (action !== "create_pull_request") return [];
  const lines: string[] = [];
  const title = stringParam(params, "title");
  const head = stringParam(params, "head") ?? stringParam(params, "branch");
  const base = stringParam(params, "base") ?? stringParam(params, "baseBranch");
  const changedFiles = stringArrayParam(params, "changedFiles");
  const risks = stringArrayParam(params, "risks");
  const verification = renderVerificationParams(params);
  if (title) lines.push(`   Title: ${markdownToSlackMrkdwn(title)}`);
  if (head || base) lines.push(`   Branch: \`${head ?? "unknown"}\` -> \`${base ?? "main"}\``);
  if (changedFiles.length > 0) lines.push(`   Changed files: ${changedFiles.map((file) => `\`${file}\``).join(", ")}`);
  if (risks.length > 0) {
    lines.push("   Risks:");
    for (const risk of risks) {
      lines.push(`   - ${markdownToSlackMrkdwn(risk)}`);
    }
  }
  if (verification.length > 0) {
    lines.push("   Verification:");
    lines.push(...verification);
  }
  return lines;
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

function renderSuggestedActionCandidateLines(receipt: ActionReceipt): string[] {
  const candidate = receipt.candidate;
  const lines = [`${candidate.index}. *${markdownToSlackMrkdwn(candidate.intent.summary)}*`];
  lines.push(`Target: ${markdownToSlackMrkdwn(receipt.targetLabel)}`);
  if (receipt.setupReason) {
    lines.push(`Status: ${markdownToSlackMrkdwn(receipt.setupReason)}`);
  }
  const details = renderSuggestedActionDetails(candidate.intent.params, candidate.intent.action)
    .filter((line) => line.trim().startsWith("Branch:") || line.trim().startsWith("Changed files:"))
    .map((line) => line.replace(/^\s+/, ""));
  lines.push(...details);
  if (candidate.proposalPreconditions?.length) {
    lines.push(`Preconditions: ${candidate.proposalPreconditions.length} check(s) in the audit log.`);
  }
  return lines;
}

function renderSuggestedActionsMarkdown(result: OpenTagRunResult, options: SlackRenderOptions = {}): string[] {
  const receipts = buildActionReceiptsFromResult(result, options.receiptContext);
  if (receipts.length === 0) return [];

  const heading = actionReceiptHeading(receipts);
  const lines = [`*${heading}*`, "Choose an action in this thread. Details stay in the OpenTag audit log."];
  const visibleReceipts = receipts.slice(0, MAX_SLACK_SUGGESTED_ACTION_CANDIDATES);
  for (const receipt of visibleReceipts) {
    lines.push("", ...renderSuggestedActionCandidateLines(receipt));
  }

  const remainingCount = receipts.length - visibleReceipts.length;
  if (remainingCount > 0) {
    lines.push("", `Showing first ${visibleReceipts.length} of ${receipts.length} actions. Reply with an action number for the rest.`);
  }
  lines.push("", "Use the buttons below, or reply with the matching command.");
  return lines;
}

function createSuggestedActionButton(receipt: ActionReceipt, decision: ActionReceiptDecision): SlackButtonElement {
  const index = receipt.candidate.index;
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
      proposalId: receipt.candidate.proposalId,
      intentId: receipt.candidate.intent.intentId
    }),
    ...(decision === "apply" ? { style: "primary" as const } : {}),
    ...(decision === "reject" ? { style: "danger" as const } : {})
  };
}

function createSuggestedActionButtons(receipt: ActionReceipt): SlackButtonElement[] {
  return receipt.visibleDecisions.map((decision) => createSuggestedActionButton(receipt, decision));
}

export function renderSlackFinalResult(result: OpenTagRunResult, options: SlackRenderOptions = {}): string {
  const lines = [`*Finished: ${result.conclusion}.*`, markdownToSlackMrkdwn(compactSlackSummary(result.summary))];

  if (result.verification?.length) {
    lines.push(
      `Verified: ${result.verification
        .slice(0, 3)
        .map((check) => `\`${markdownToSlackMrkdwn(check.command)}\` ${markdownToSlackMrkdwn(check.outcome)}`)
        .join(", ")}`
    );
  }

  const nextAction = nextActionSummary(result);
  if (nextAction && !result.suggestedChanges?.length) {
    lines.push(`Next: ${markdownToSlackMrkdwn(compactNextAction(nextAction))}`);
  }

  const suggestedActions = renderSuggestedActionsMarkdown(result, options);
  if (suggestedActions.length > 0) {
    lines.push("", ...suggestedActions);
  }

  return lines.join("\n");
}

export function createSlackFinalResultBlocks(result: OpenTagRunResult, options: SlackRenderOptions = {}): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Finished: ${result.conclusion}.*\n${markdownToSlackMrkdwn(compactSlackSummary(result.summary))}`
      }
    }
  ];

  if (result.verification?.length) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Verified: ${markdownToSlackMrkdwn(
          result.verification
            .slice(0, 3)
            .map((check) => `\`${check.command}\` ${check.outcome}`)
            .join(", ")
        )}`
      }
    });
  }

  const nextAction = nextActionSummary(result);
  const receipts = buildActionReceiptsFromResult(result, options.receiptContext);
  if (nextAction && receipts.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Next: ${markdownToSlackMrkdwn(compactNextAction(nextAction))}`
      }
    });
  }

  if (receipts.length > 0) {
    const heading = actionReceiptHeading(receipts);
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${heading}*\nChoose an action in this thread. Details stay in the OpenTag audit log.`
      }
    });
    const visibleReceipts = receipts.slice(0, MAX_SLACK_SUGGESTED_ACTION_CANDIDATES);
    for (const receipt of visibleReceipts) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: renderSuggestedActionCandidateLines(receipt).join("\n")
        }
      });
      blocks.push({
        type: "actions",
        block_id: `opentag_actions_${receipt.candidate.index}`,
        elements: createSuggestedActionButtons(receipt)
      });
    }
    const remainingCount = receipts.length - visibleReceipts.length;
    if (remainingCount > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Showing first ${visibleReceipts.length} of ${receipts.length} actions. Reply with an action number for the rest.`
        }
      });
    }
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
