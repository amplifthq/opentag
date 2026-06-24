import type { OpenTagCommand } from "./schema.js";

type MentionMatch = { matched: false } | ({ matched: true } & OpenTagCommand);

const INTENTS: OpenTagCommand["intent"][] = ["fix", "review", "investigate", "explain", "run"];

export function commandFromRawText(rawText: string): OpenTagCommand {
  const firstWord = rawText.split(/\s+/, 1)[0]?.toLowerCase();
  const intent = INTENTS.includes(firstWord as OpenTagCommand["intent"])
    ? (firstWord as OpenTagCommand["intent"])
    : "unknown";

  return {
    rawText,
    intent,
    args: {}
  };
}

export function parseOpenTagMention(body: string, mention = "@opentag"): MentionMatch {
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}\\s+([^\\n\\r]+)`, "i");
  const match = body.match(pattern);

  if (!match?.[1]) {
    return { matched: false };
  }

  const rawText = match[1].trim();
  return {
    matched: true,
    ...commandFromRawText(rawText)
  };
}
