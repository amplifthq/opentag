import {
  createFinalSummaryPresentation,
  suggestedActionCandidatesFromResult,
  type ActionReceiptDecision,
  type OpenTagFinalSummaryPresentation,
  type OpenTagPresentationAction,
  type OpenTagRunResult
} from "@opentag/core";

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
      return typeof summary === "string" && summary.length > 0 ? `  - ${prefix} - ${summary}` : `  - ${prefix}`;
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
  if (title) lines.push(`- Title: ${title}`);
  if (head || base) lines.push(`- Branch: \`${head ?? "unknown"}\` -> \`${base ?? "main"}\``);
  if (changedFiles.length > 0) lines.push(`- Changed files: ${changedFiles.map((file) => `\`${file}\``).join(", ")}`);
  if (risks.length > 0) {
    lines.push("- Risks:");
    for (const risk of risks) {
      lines.push(`  - ${risk}`);
    }
  }
  if (verification.length > 0) {
    lines.push("- Verification:");
    lines.push(...verification);
  }
  return lines;
}

function renderSuggestedActions(result: OpenTagRunResult): string[] {
  const candidates = suggestedActionCandidatesFromResult(result);
  if (candidates.length === 0) return [];

  const lines = [
    "### Suggested actions:",
    "",
    // GitLab-flavored copy. The proposal may include both `create_pull_request`
    // intents (mapped to MR creation by future adapters) and MR-specific review
    // intents; the approval table stays identical so users can copy commands
    // verbatim into a GitLab reply.
    "Source-thread approval: choose one command in this GitLab thread to apply a protocolized mutation or merge request action to the system of record."
  ];
  for (const candidate of candidates) {
    lines.push(
      "",
      `#### Action ${candidate.index}: ${candidate.intent.summary}`,
      "",
      `- System-of-record action: \`${candidate.intent.action}\` (\`${candidate.intent.domain}\`)`,
      `- Proposal: \`${candidate.proposalId}\``,
      `- Intent ID: \`${candidate.intent.intentId}\``
    );
    lines.push(...renderSuggestedActionDetails(candidate.intent.params, candidate.intent.action));
    if (candidate.proposalPreconditions?.length) {
      lines.push("- Preconditions:");
      for (const precondition of candidate.proposalPreconditions) {
        lines.push(`  - ${precondition}`);
      }
    }
    lines.push(
      "",
      "**Approve in this thread**",
      "",
      `| Decision | Comment command | Effect |`,
      `| --- | --- | --- |`,
      `| Apply now | \`apply ${candidate.index}\` | Applies this action to the system of record. |`,
      `| Approve only | \`approve ${candidate.index}\` | Records approval without applying yet. |`,
      `| Continue | \`continue ${candidate.index}\` | Starts a follow-up run from this proposal. |`,
      `| Reject | \`reject ${candidate.index}\` | Rejects this action. |`
    );
  }

  lines.push("", "Bulk shortcut: comment `apply all` to apply every supported approved action in this thread.");
  return lines;
}

/** Render the initial acknowledgement message a runner posts back to the
 * GitLab thread when it picks up a new mention. Includes the run id so the
 * user can correlate follow-up progress messages to the originating event.
 *
 * GitLab-flavored markdown (single backtick for the run id; the surrounding
 * text is plain prose so the comment renders cleanly inside a GitLab note
 * without escaping). */
export function renderAcknowledgement(runId: string): string {
  return `OpenTag picked this up. Run: \`${runId}\``;
}

/** Render a mid-run progress update. The runner emits these between the
 * acknowledgement and the final result so the user can see the run is alive
 * while long operations execute. */
export function renderProgress(input: { runId: string; message: string }): string {
  return `OpenTag progress for \`${input.runId}\`: ${input.message}`;
}

function tableValue(value: string): string {
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
    "OpenTag prepared a source-thread action receipt. Choose one command in this GitLab thread; full protocol lineage stays in the audit log."
  ];
  if (presentation.auditRunId) {
    lines.push("", `Audit: run \`opentag status --run ${presentation.auditRunId}\` locally.`);
  }
  for (const action of actions) {
    lines.push(
      "",
      `#### ${action.index}. ${action.title}`,
      "",
      "| Field | Value |",
      "| --- | --- |"
    );
    for (const [label, value] of actionDetailRows(action)) {
      lines.push(`| ${label} | ${tableValue(value)} |`);
    }
    lines.push("", "**Choose in this thread**", "", "| Decision | Comment command | Effect |", "| --- | --- | --- |");
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

  const suggestedActions = renderPresentationActions(presentation);
  if (suggestedActions.length > 0) {
    lines.push("", ...suggestedActions);
  } else if (presentation.nextActions?.length) {
    lines.push("", `Next action: ${presentation.nextActions[0]}`);
  }

  return lines.join("\n");
}

/** Render the final result a runner posts back to the GitLab thread when a
 * run completes. Produces a GitLab-flavored markdown body with:
 *
 * 1. The conclusion and summary (`OpenTag finished with **success**.`).
 * 2. Verification rows (one bullet per `result.verification` entry).
 * 3. A `Next action` line if `result.nextAction` is set.
 * 4. A `Suggested actions` block (when `result` carries suggestions) with a
 *    source-thread approval table. The table reuses the GitHub / Slack shape
 *    so users can copy `apply N` / `approve N` / `continue N` / `reject N`
 *    commands verbatim into a GitLab reply.
 */
export function renderFinalResult(result: OpenTagRunResult): string {
  const suggestedActions = renderSuggestedActions(result);
  const presentation = createFinalSummaryPresentation({ result });
  if (suggestedActions.length === 0) {
    return renderFinalSummaryPresentation(presentation);
  }
  const lines = [`OpenTag finished with **${result.conclusion}**.`, "", result.summary];
  if (result.verification?.length) {
    lines.push("", "Verification:");
    for (const check of result.verification) {
      lines.push(`- \`${check.command}\`: ${check.outcome}`);
    }
  }
  const nextAction = nextActionSummary(result);
  if (nextAction) lines.push("", `Next action: ${nextAction}`);
  lines.push("", ...suggestedActions);
  return lines.join("\n");
}
