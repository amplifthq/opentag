import type { MutationIntent, OpenTagRunResult, SuggestedChangesSnapshot } from "./schema.js";

export type ThreadActionVerb = "approve" | "apply" | "continue" | "reject";

export type ThreadActionSelection =
  | { kind: "latest" }
  | { kind: "all" }
  | { kind: "index"; index: number }
  | { kind: "proposal"; proposalId: string }
  | { kind: "intent"; intentId: string }
  | { kind: "domain"; domain: string };

export type ThreadActionCommand = {
  verb: ThreadActionVerb;
  selection: ThreadActionSelection;
  rawText: string;
  reason?: string;
};

export type SuggestedActionCandidate = {
  index: number;
  proposalId: string;
  proposalSummary: string;
  proposalPreconditions?: string[];
  intent: MutationIntent;
};

const ENGLISH_VERBS: Record<string, ThreadActionVerb> = {
  approve: "approve",
  approved: "approve",
  ok: "approve",
  okay: "approve",
  apply: "apply",
  continue: "continue",
  proceed: "continue",
  reject: "reject",
  decline: "reject"
};

const CHINESE_VERBS: Array<{ pattern: RegExp; verb: ThreadActionVerb }> = [
  { pattern: /^(批准|同意)/, verb: "approve" },
  { pattern: /^(应用|套用|执行)/, verb: "apply" },
  { pattern: /^(继续执行|继续这个|继续此|继续)/, verb: "continue" },
  { pattern: /^(拒绝|不同意|驳回)/, verb: "reject" }
];

const DOMAIN_ALIASES: Record<string, string> = {
  label: "labels",
  labels: "labels",
  status: "status",
  assignee: "assignee",
  assignees: "assignee",
  priority: "priority",
  review: "review",
  reviews: "review",
  artifact: "artifact_links",
  artifacts: "artifact_links",
  pr: "pull_request",
  prs: "pull_request",
  pull_request: "pull_request",
  pull_requests: "pull_request"
};

function normalizeToken(token: string): string {
  return token.trim().replace(/[.,;:!?，。；：！？]+$/u, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSelection(tokens: string[]): ThreadActionSelection {
  const normalized = tokens.map(normalizeToken).filter(Boolean);
  const first = normalized[0];
  if (!first) return { kind: "latest" };
  if (first.toLowerCase() === "all" || first === "全部") return { kind: "all" };
  if (/^\d+$/.test(first)) return { kind: "index", index: Number(first) };
  if (first.startsWith("proposal_")) return { kind: "proposal", proposalId: first };
  if (first.startsWith("intent_")) return { kind: "intent", intentId: first };

  const maybeProposal = normalized.find((token) => token.startsWith("proposal_"));
  if (maybeProposal) return { kind: "proposal", proposalId: maybeProposal };
  const maybeIntent = normalized.find((token) => token.startsWith("intent_"));
  if (maybeIntent) return { kind: "intent", intentId: maybeIntent };

  const domain = DOMAIN_ALIASES[first.toLowerCase()];
  return domain ? { kind: "domain", domain } : { kind: "latest" };
}

function reasonAfterSelection(rest: string, selection: ThreadActionSelection): string | undefined {
  if (!rest.trim()) return undefined;
  if (selection.kind === "all") {
    const stripped = rest.replace(/^\s*(?:all|全部)\s*/iu, "").trim();
    return stripped.length > 0 ? stripped : undefined;
  }
  if (selection.kind === "latest") return rest.trim();
  const selectionText =
    selection.kind === "index"
      ? String(selection.index)
      : selection.kind === "proposal"
        ? escapeRegExp(selection.proposalId)
        : selection.kind === "intent"
          ? escapeRegExp(selection.intentId)
          : Object.keys(DOMAIN_ALIASES).join("|");
  const pattern = new RegExp(`^\\s*(?:${selectionText})\\b\\s*`, "i");
  const stripped = rest.replace(pattern, "").trim();
  return stripped.length > 0 ? stripped : undefined;
}

export function parseThreadActionCommand(rawText: string): ThreadActionCommand | null {
  const text = rawText.trim();
  if (!text) return null;

  for (const candidate of CHINESE_VERBS) {
    const match = text.match(candidate.pattern);
    if (!match) continue;
    const verbText = match[0] ?? "";
    const rest = text.slice(verbText.length).trim();
    const selection = parseSelection(rest.split(/\s+/u));
    const reason = reasonAfterSelection(rest, selection);
    return {
      verb: candidate.verb,
      selection,
      rawText: text,
      ...(reason ? { reason } : {})
    };
  }

  const [verbTokenRaw = "", ...restTokens] = text.split(/\s+/u);
  const verbToken = normalizeToken(verbTokenRaw).toLowerCase();
  const verb = ENGLISH_VERBS[verbToken];
  if (!verb) return null;
  const rest = restTokens.join(" ");
  const selection = parseSelection(restTokens);
  const reason = reasonAfterSelection(rest, selection);
  return {
    verb,
    selection,
    rawText: text,
    ...(reason ? { reason } : {})
  };
}

export function suggestedActionCandidatesFromSnapshots(
  snapshots: SuggestedChangesSnapshot[],
  startIndex = 1
): SuggestedActionCandidate[] {
  const candidates: SuggestedActionCandidate[] = [];
  let index = startIndex;
  for (const snapshot of snapshots) {
    for (const intent of snapshot.intents) {
      candidates.push({
        index,
        proposalId: snapshot.proposalId,
        proposalSummary: snapshot.summary,
        ...(snapshot.preconditions?.length ? { proposalPreconditions: snapshot.preconditions } : {}),
        intent
      });
      index += 1;
    }
  }
  return candidates;
}

export function suggestedActionCandidatesFromResult(result: OpenTagRunResult): SuggestedActionCandidate[] {
  return suggestedActionCandidatesFromSnapshots(result.suggestedChanges ?? []);
}
