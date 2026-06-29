export const EXECUTOR_REPORT_START = "OPENTAG_EXECUTOR_REPORT_START";
export const EXECUTOR_REPORT_END = "OPENTAG_EXECUTOR_REPORT_END";

const REPORT_OUTCOMES = new Set(["passed", "failed", "not_run"]);
const MAX_REPORT_ITEMS = 8;
const MAX_REPORT_TEXT_LENGTH = 600;

export type ExecutorReport = {
  changes: Array<{
    file?: string;
    summary: string;
  }>;
  verification?: Array<{
    command?: string;
    outcome: "passed" | "failed" | "not_run";
    summary?: string;
  }>;
  risks?: string[];
  notes?: string[];
};

export function executorReportPromptLines(): string[] {
  return [
    "End with this exact machine-readable OpenTag executor report block. Put it last.",
    "Replace every example value with the actual result. Use changes: [] if no files changed.",
    "Use verification: [] if no checks ran. Use verification outcome exactly one of: passed, failed, not_run.",
    EXECUTOR_REPORT_START,
    JSON.stringify(
      {
        changes: [{ file: "README.md", summary: "Added one sentence describing the completed change." }],
        verification: [{ command: "corepack pnpm test", outcome: "passed", summary: "Tests passed." }],
        risks: []
      },
      null,
      2
    ),
    EXECUTOR_REPORT_END
  ];
}

export function executorPolicyPromptLines(): string[] {
  return [
    "Work autonomously but keep the change narrow. Run relevant verification if you modify files.",
    "OpenTag owns the source-control handoff after you finish.",
    "Do not run, request, or recommend git add, git commit, git push, or gh pr create.",
    "Do not ask the user to approve local source-control commands; summarize file changes and verification only.",
    "OpenTag will publish the run branch and expose pull-request creation as a suggested action.",
    ...executorReportPromptLines()
  ];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function cleanReportText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 0 ? text.slice(0, MAX_REPORT_TEXT_LENGTH) : undefined;
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(cleanReportText).filter((item): item is string => Boolean(item));
  return items.length > 0 ? items.slice(0, MAX_REPORT_ITEMS) : undefined;
}

function normalizeReport(value: unknown): ExecutorReport | undefined {
  const record = asRecord(value);
  if (!record || !Array.isArray(record["changes"])) return undefined;

  const changes = record["changes"]
    .map((item) => {
      const change = asRecord(item);
      if (!change) return undefined;
      const summary = cleanReportText(change["summary"]);
      if (!summary) return undefined;
      const file = cleanReportText(change["file"]);
      return file ? { file, summary } : { summary };
    })
    .filter((item): item is ExecutorReport["changes"][number] => Boolean(item))
    .slice(0, MAX_REPORT_ITEMS);

  if ((record["changes"] as unknown[]).length > 0 && changes.length === 0) return undefined;

  const verificationRaw = record["verification"];
  const verification = Array.isArray(verificationRaw)
    ? verificationRaw
        .map((item) => {
          const check = asRecord(item);
          if (!check || typeof check["outcome"] !== "string" || !REPORT_OUTCOMES.has(check["outcome"])) return undefined;
          const command = cleanReportText(check["command"]);
          const summary = cleanReportText(check["summary"]);
          return {
            ...(command ? { command } : {}),
            outcome: check["outcome"] as "passed" | "failed" | "not_run",
            ...(summary ? { summary } : {})
          };
        })
        .filter((item): item is NonNullable<ExecutorReport["verification"]>[number] => Boolean(item))
        .slice(0, MAX_REPORT_ITEMS)
    : undefined;

  if (Array.isArray(verificationRaw) && verificationRaw.length > 0 && (!verification || verification.length === 0)) {
    return undefined;
  }

  const risks = cleanStringArray(record["risks"]);
  const notes = cleanStringArray(record["notes"]);

  return {
    changes,
    ...(verification && verification.length > 0 ? { verification } : {}),
    ...(risks ? { risks } : {}),
    ...(notes ? { notes } : {})
  };
}

function markerCandidate(output: string): string | undefined {
  const startIndex = output.lastIndexOf(EXECUTOR_REPORT_START);
  if (startIndex < 0) return undefined;
  const afterStart = output.slice(startIndex + EXECUTOR_REPORT_START.length);
  const endIndex = afterStart.indexOf(EXECUTOR_REPORT_END);
  return (endIndex >= 0 ? afterStart.slice(0, endIndex) : afterStart).trim();
}

function parseCandidate(candidate: string): ExecutorReport | undefined {
  try {
    return normalizeReport(JSON.parse(candidate));
  } catch {
    return undefined;
  }
}

export function parseExecutorReport(output: string): ExecutorReport | undefined {
  const marker = markerCandidate(output);
  if (marker) {
    const parsed = parseCandidate(marker);
    if (parsed) return parsed;
  }

  return parseCandidate(output.trim());
}

function deterministicSummary(input: { executorName: string; changedFiles: string[] }): string {
  if (input.changedFiles.length === 0) {
    return `${input.executorName} completed without file changes.`;
  }

  return `${input.executorName} changed ${input.changedFiles.length} file(s). Changed files: ${input.changedFiles.join(", ")}.`;
}

export function renderExecutorReportSummary(input: {
  executorName: string;
  changedFiles: string[];
  report: ExecutorReport;
}): string {
  const lines: string[] = [];

  if (input.report.changes.length > 0) {
    lines.push("What changed:");
    for (const change of input.report.changes) {
      lines.push(`- ${change.file ? `\`${change.file}\`: ` : ""}${change.summary}`);
    }
  }

  if (input.report.verification?.length) {
    if (lines.length > 0) lines.push("");
    lines.push("Verified:");
    for (const check of input.report.verification) {
      const prefix = check.command ? `\`${check.command}\`: ${check.outcome}` : check.outcome;
      lines.push(`- ${check.summary ? `${prefix} - ${check.summary}` : prefix}`);
    }
  }

  if (input.report.risks?.length) {
    if (lines.length > 0) lines.push("");
    lines.push("Risks:");
    for (const risk of input.report.risks) {
      lines.push(`- ${risk}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : deterministicSummary(input);
}
