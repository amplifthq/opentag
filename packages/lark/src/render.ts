import type { OpenTagRunResult } from "@opentag/core";

function nextActionSummary(result: OpenTagRunResult): string | undefined {
  if (!result.nextAction) return undefined;
  if (typeof result.nextAction === "string") return result.nextAction;
  return result.nextAction.summary;
}

export function renderLarkAcknowledgement(runId: string): string {
  return `I picked this up: ${runId}`;
}

export function renderLarkFinalResult(result: OpenTagRunResult): string {
  const lines = [`Finished with ${result.conclusion}.`, "", result.summary];

  if (result.verification?.length) {
    lines.push("", "Verification");
    for (const check of result.verification) {
      lines.push(`- ${check.command}: ${check.outcome}`);
    }
  }

  const nextAction = nextActionSummary(result);
  if (nextAction) {
    lines.push("", `Next action: ${nextAction}`);
  }

  return lines.join("\n");
}

/**
 * Lark text messages carry their body as a JSON-encoded `{ "text": "..." }`
 * string in the `content` field. This helper produces that serialized content.
 */
export function createLarkTextMessageContent(text: string): string {
  return JSON.stringify({ text });
}
