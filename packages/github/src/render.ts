import { suggestedActionCandidatesFromResult, type OpenTagRunResult } from "@opentag/core";

function nextActionSummary(result: OpenTagRunResult): string | undefined {
  if (!result.nextAction) return undefined;
  if (typeof result.nextAction === "string") return result.nextAction;
  return result.nextAction.summary;
}

function renderSuggestedActions(result: OpenTagRunResult): string[] {
  const candidates = suggestedActionCandidatesFromResult(result);
  if (candidates.length === 0) return [];

  const lines = ["Suggested actions:"];
  for (const candidate of candidates) {
    lines.push(
      "",
      `${candidate.index}. **${candidate.intent.summary}**`,
      `   Intent: \`${candidate.intent.action}\` (\`${candidate.intent.domain}\`)`,
      `   Proposal: \`${candidate.proposalId}\``,
      `   Intent ID: \`${candidate.intent.intentId}\``
    );
    if (candidate.proposalPreconditions?.length) {
      lines.push("   Preconditions:");
      for (const precondition of candidate.proposalPreconditions) {
        lines.push(`   - ${precondition}`);
      }
    }
  }

  lines.push(
    "",
    "Reply with:",
    "- `approve 1` to record approval without applying yet",
    "- `apply 1` or `apply all` to apply supported actions",
    "- `continue 1` to continue with a follow-up run",
    "- `reject 1` to reject an action"
  );
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
