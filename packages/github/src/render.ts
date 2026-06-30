import {
  actionReceiptHeading,
  buildActionReceiptsFromResult,
  type ActionReceipt,
  type ActionReceiptContext,
  type ActionReceiptDecision,
  type OpenTagRunResult
} from "@opentag/core";

export type GitHubRenderOptions = {
  receiptContext?: ActionReceiptContext;
  auditRunId?: string;
};

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
      const summary = (item as Record<string, unknown>)["summary"];
      if (typeof outcome !== "string") return undefined;
      const prefix = typeof command === "string" && command.length > 0 ? `\`${command}\`: ${outcome}` : outcome;
      return typeof summary === "string" && summary.length > 0 ? `${prefix} - ${summary}` : prefix;
    })
    .filter((line): line is string => Boolean(line));
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

function tableValue(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function tableList(values: string[]): string {
  return values.map(tableValue).join("<br>");
}

function renderSuggestedActionDetails(receipt: ActionReceipt): Array<[string, string]> {
  const candidate = receipt.candidate;
  const params = candidate.intent.params;
  const rows: Array<[string, string]> = [["Target", receipt.targetLabel]];
  if (receipt.setupReason) rows.push(["Status", receipt.setupReason]);
  if (candidate.intent.action !== "create_pull_request") {
    if (candidate.proposalPreconditions?.length) {
      rows.push(["Preconditions", tableList(candidate.proposalPreconditions)]);
    }
    return rows;
  }

  const title = stringParam(params, "title");
  const head = stringParam(params, "head") ?? stringParam(params, "branch");
  const base = stringParam(params, "base") ?? stringParam(params, "baseBranch");
  const changedFiles = stringArrayParam(params, "changedFiles");
  const risks = stringArrayParam(params, "risks");
  const verification = renderVerificationParams(params);
  if (title) rows.push(["Title", title]);
  if (head || base) rows.push(["Branch", `${inlineCode(head ?? "unknown")} -> ${inlineCode(base ?? "main")}`]);
  if (changedFiles.length > 0) rows.push(["Changed files", changedFiles.map(inlineCode).join(", ")]);
  if (verification.length > 0) rows.push(["Verification", tableList(verification)]);
  if (risks.length > 0) rows.push(["Risks", tableList(risks)]);
  if (candidate.proposalPreconditions?.length) {
    rows.push(["Preconditions", tableList(candidate.proposalPreconditions)]);
  }
  return rows;
}

function decisionLabel(decision: ActionReceiptDecision): string {
  if (decision === "apply") return "Apply now";
  if (decision === "approve") return "Approve only";
  if (decision === "continue") return "Continue";
  return "Reject";
}

function decisionEffect(decision: ActionReceiptDecision): string {
  if (decision === "apply") return "Approves and applies this action to the system of record.";
  if (decision === "approve") return "Records approval without applying yet.";
  if (decision === "continue") return "Starts a follow-up run from this approved action.";
  return "Rejects this action.";
}

function renderSuggestedActions(result: OpenTagRunResult, options: GitHubRenderOptions = {}): string[] {
  const receipts = buildActionReceiptsFromResult(result, options.receiptContext);
  if (receipts.length === 0) return [];

  const lines = [
    `### ${actionReceiptHeading(receipts)}`,
    "",
    "OpenTag prepared a source-thread action receipt. Choose one command in this GitHub thread; full protocol lineage stays in the audit log."
  ];
  if (options.auditRunId) {
    lines.push("", `Audit: run ${inlineCode(`opentag status --run ${options.auditRunId}`)} locally.`);
  }
  for (const receipt of receipts) {
    const candidate = receipt.candidate;
    lines.push(
      "",
      `#### ${candidate.index}. ${candidate.intent.summary}`,
      "",
      "| Field | Value |",
      "| --- | --- |"
    );
    for (const [label, value] of renderSuggestedActionDetails(receipt)) {
      lines.push(`| ${label} | ${tableValue(value)} |`);
    }
    lines.push(
      "",
      "**Choose in this thread**",
      "",
      `| Decision | Comment command | Effect |`,
      `| --- | --- | --- |`
    );
    for (const decision of receipt.visibleDecisions) {
      lines.push(`| ${decisionLabel(decision)} | \`${decision} ${candidate.index}\` | ${decisionEffect(decision)} |`);
    }
  }

  return lines;
}

export function renderAcknowledgement(runId: string): string {
  return `OpenTag picked this up. Run: \`${runId}\``;
}

export function renderProgress(input: { runId: string; message: string }): string {
  return `OpenTag progress for \`${input.runId}\`: ${input.message}`;
}

export function renderFinalResult(result: OpenTagRunResult, options: GitHubRenderOptions = {}): string {
  const lines = [`OpenTag finished with **${result.conclusion}**.`, "", result.summary];

  if (result.verification?.length) {
    lines.push("", "Verification:");
    for (const check of result.verification) {
      lines.push(`- \`${check.command}\`: ${check.outcome}`);
    }
  }

  const suggestedActions = renderSuggestedActions(result, options);
  if (suggestedActions.length > 0) {
    lines.push("", ...suggestedActions);
  } else {
    const nextAction = nextActionSummary(result);
    if (nextAction) {
      lines.push("", `Next action: ${nextAction}`);
    }
  }

  return lines.join("\n");
}
