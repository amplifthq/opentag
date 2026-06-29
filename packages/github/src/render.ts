import { suggestedActionCandidatesFromResult, type OpenTagRunResult } from "@opentag/core";

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
      return typeof command === "string" && typeof outcome === "string" ? `  - \`${command}\`: ${outcome}` : undefined;
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
    "Source-thread approval: choose one command in this GitHub thread to apply a protocolized mutation or PR action to the system of record."
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

export function renderAcknowledgement(runId: string): string {
  return `OpenTag picked this up. Run: \`${runId}\``;
}

export function renderProgress(input: { runId: string; message: string }): string {
  return `OpenTag progress for \`${input.runId}\`: ${input.message}`;
}

export function renderFinalResult(result: OpenTagRunResult): string {
  const lines = [`OpenTag finished with **${result.conclusion}**.`, "", result.summary];

  if (result.verification?.length) {
    lines.push("", "Verification:");
    for (const check of result.verification) {
      lines.push(`- \`${check.command}\`: ${check.outcome}`);
    }
  }

  const nextAction = nextActionSummary(result);
  if (nextAction) {
    lines.push("", `Next action: ${nextAction}`);
  }

  const suggestedActions = renderSuggestedActions(result);
  if (suggestedActions.length > 0) {
    lines.push("", ...suggestedActions);
  }

  return lines.join("\n");
}
