import { createFinalSummaryPresentation, type OpenTagFinalSummaryPresentation, type OpenTagRunResult } from "@opentag/core";

export type TeamsRenderOptions = { auditRunId?: string };

export function renderTeamsAcknowledgement(runId: string): string {
  return `Received. OpenTag is working.\nRun: ${runId}`;
}

export function renderTeamsProgress(message: string): string {
  if (/starting acp agent|thinking/i.test(message)) {
    return "Thinking...";
  }
  return "Working...";
}

export function renderTeamsFinalResult(result: OpenTagRunResult, options: TeamsRenderOptions = {}): string {
  return renderTeamsFinalSummaryPresentation(
    createFinalSummaryPresentation({
      result,
      ...(options.auditRunId ? { auditRunId: options.auditRunId } : {})
    })
  );
}

export function renderTeamsFinalSummaryPresentation(presentation: OpenTagFinalSummaryPresentation): string {
  const lines = [`Finished with ${presentation.outcome}.`, "", presentation.summary];
  if (presentation.verification?.length) {
    lines.push("", "Verification:");
    for (const check of presentation.verification) {
      lines.push(`- ${check.command}: ${check.outcome}`);
    }
  }
  if (presentation.nextActions?.length) {
    lines.push("", `Next action: ${presentation.nextActions[0]}`);
  }
  if (presentation.auditRunId) {
    lines.push("", `Audit: opentag status --run ${presentation.auditRunId}`);
  }
  return lines.join("\n");
}
