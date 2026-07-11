import {
  createFinalSummaryPresentation,
  renderMarkdownArtifactLines,
  type ActionReceiptDecision,
  type OpenTagFinalSummaryPresentation,
  type OpenTagPresentationAction,
  type OpenTagRunResult
} from "@opentag/core";

export function renderAcknowledgement(runId: string): string {
  return `OpenTag picked this up. Run: \`${runId}\``;
}

export function renderProgress(input: { runId: string; message: string }): string {
  return `OpenTag progress for \`${input.runId}\`: ${input.message}`;
}

function tableValue(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function decisionLabel(decision: ActionReceiptDecision): string {
  if (decision === "apply") return "Apply now";
  if (decision === "approve") return "Approve only";
  if (decision === "continue") return "Continue";
  return "Reject";
}

function decisionEffect(decision: ActionReceiptDecision): string {
  if (decision === "apply") return "Applies this action to the system of record.";
  if (decision === "approve") return "Records approval without applying yet.";
  if (decision === "continue") return "Starts a follow-up run from this approved action.";
  return "Rejects this action.";
}

function actionDetailRows(action: OpenTagPresentationAction): Array<[string, string]> {
  if (action.detailRows?.length) return action.detailRows.map((row) => [row.label, row.value]);
  const rows: Array<[string, string]> = [["Target", action.targetLabel]];
  if (action.setupReason) rows.push(["Status", action.setupReason]);
  return rows;
}

function renderPresentationActions(presentation: OpenTagFinalSummaryPresentation): string[] {
  const actions = presentation.actions ?? [];
  if (actions.length === 0 || !presentation.actionReceiptTitle) return [];

  const lines = [
    `### ${presentation.actionReceiptTitle}`,
    "",
    "OpenTag prepared a source-thread action receipt. Choose one command in this Linear issue; full protocol lineage stays in the audit log."
  ];
  if (presentation.auditRunId) {
    lines.push("", `Audit: run \`opentag status --run ${presentation.auditRunId}\` locally.`);
  }
  for (const action of actions) {
    lines.push("", `#### ${action.index}. ${action.title}`, "", "| Field | Value |", "| --- | --- |");
    for (const [label, value] of actionDetailRows(action)) {
      lines.push(`| ${label} | ${tableValue(value)} |`);
    }
    lines.push("", "**Choose in this issue**", "", "| Decision | Comment command | Effect |", "| --- | --- | --- |");
    for (const decision of action.visibleDecisions) {
      lines.push(`| ${decisionLabel(decision)} | \`${decision} ${action.index}\` | ${decisionEffect(decision)} |`);
    }
  }

  return lines;
}

export function renderFinalSummaryPresentation(presentation: OpenTagFinalSummaryPresentation): string {
  const lines = [`OpenTag finished with **${presentation.outcome}**.`, "", presentation.summary];

  if (presentation.verification?.length) {
    lines.push("", "Verification:");
    for (const check of presentation.verification) {
      lines.push(`- \`${check.command}\`: ${check.outcome}`);
    }
  }

  const artifacts = renderMarkdownArtifactLines(presentation);
  if (artifacts.length > 0) {
    lines.push("", ...artifacts);
  }

  const actions = renderPresentationActions(presentation);
  if (actions.length > 0) {
    lines.push("", ...actions);
  } else if (presentation.nextActions?.length) {
    lines.push("", `Next action: ${presentation.nextActions[0]}`);
  }

  return lines.join("\n");
}

export function renderFinalResult(result: OpenTagRunResult): string {
  return renderFinalSummaryPresentation(createFinalSummaryPresentation({ result }));
}
