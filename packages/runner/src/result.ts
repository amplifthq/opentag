import type { OpenTagRunResult } from "@opentag/core";
import { EXECUTOR_REPORT_START, parseExecutorReport, renderExecutorReportSummary } from "./executor-report.js";

const MAX_EXECUTOR_SUMMARY_LENGTH = 4000;
const MAX_ARTIFACT_SUMMARY_LENGTH = 1200;

type ResultArtifact = NonNullable<OpenTagRunResult["artifacts"]>[number];

const DIRECT_SOURCE_CONTROL_COMMAND_PATTERN = /^\s*(?:[-*]\s*)?(?:`{1,3})?\s*(?:git\s+(?:add|commit|push|checkout)|gh\s+pr\s+create)\b/i;

const GIT_HANDOFF_PATTERNS = [
  DIRECT_SOURCE_CONTROL_COMMAND_PATTERN,
  /\b(?:interactive user approval|permission system)\b.*\b(?:git|source-control|commit|push|pull request|pr)\b/i,
  /\b(?:git|source-control|commit|push|pull request|pr)\b.*\b(?:interactive user approval|permission system)\b/i,
  /(?=.*\b(?:git\s+(?:add|commit|push|checkout)|gh\s+pr\s+create|commit|push|pull request|pr)\b)(?=.*\b(?:approval|approve|manual|need|needs|cannot|can't|please|requires?|required|finish|next action|remaining work|blocked|blocker|permission)\b)/i
];

const HANDOFF_HEADING_PATTERN =
  /^(?:#{1,6}\s*)?(?:\*\*)?\s*(?:blocker|recommended next action|next action|remaining work|manual steps|to finish)\b.*\b(?:git|source-control|commit|push|pull request|pr)\b/i;

function looksLikeGitHandoff(line: string): boolean {
  return GIT_HANDOFF_PATTERNS.some((pattern) => pattern.test(line));
}

function stripGitHandoffTail(line: string): string {
  if (!looksLikeGitHandoff(line)) return line;
  return line
    .replace(/\s*(?:Blocker|Recommended next action|Next action|Remaining work|Manual steps|To finish)\s*:.*$/i, "")
    .trimEnd();
}

function cleanOrFallbackExecutorSummary(input: {
  executorName: string;
  output: string;
  changedFiles: string[];
}): string {
  const summary = cleanExecutorSummaryText(input.output);
  if (summary) return summary;

  if (input.changedFiles.length === 0) {
    return `${input.executorName} completed without file changes.`;
  }

  return `${input.executorName} changed ${input.changedFiles.length} file(s). Changed files: ${input.changedFiles.join(", ")}.`;
}

function cleanExecutorSummaryText(output: string): string | undefined {
  const normalizedOutput = output.replace(/\r\n/g, "\n");
  const sliceStart = Math.max(0, normalizedOutput.length - MAX_EXECUTOR_SUMMARY_LENGTH);
  let rawSummary = normalizedOutput.slice(sliceStart);
  if (sliceStart > 0 && normalizedOutput[sliceStart - 1] !== "\n") {
    const firstCompleteLine = rawSummary.indexOf("\n");
    rawSummary = firstCompleteLine >= 0 ? rawSummary.slice(firstCompleteLine + 1) : "";
  }
  const filteredLines: string[] = [];

  for (const rawLine of rawSummary.split("\n")) {
    const trimmed = rawLine.trim();
    if (HANDOFF_HEADING_PATTERN.test(trimmed)) continue;

    const withoutHandoffTail = stripGitHandoffTail(rawLine);
    if (looksLikeGitHandoff(withoutHandoffTail)) continue;
    if (withoutHandoffTail.trim().length === 0 && trimmed.length > 0) continue;

    filteredLines.push(withoutHandoffTail);
  }

  const summary = filteredLines
    .join("\n")
    .replace(/(?:^|\n)\s*(?:To finish|Manual steps):\s*\n```[^\n]*\n\s*```/gi, "\n")
    .replace(/```[^\n]*\n\s*```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return summary.length > 0 ? summary : undefined;
}

function executorAnswerBeforeReport(output: string): string | undefined {
  const startIndex = output.lastIndexOf(EXECUTOR_REPORT_START);
  if (startIndex < 0) return undefined;
  return cleanExecutorSummaryText(output.slice(0, startIndex));
}

function summaryWithExecutorAnswer(input: {
  executorName: string;
  output: string;
  changedFiles: string[];
  report: NonNullable<ReturnType<typeof parseExecutorReport>>;
}): string {
  const reportSummary = renderExecutorReportSummary(input);
  if (input.changedFiles.length > 0 || input.report.changes.length > 0) return reportSummary;

  const answer = executorAnswerBeforeReport(input.output);
  if (!answer || answer === reportSummary) return reportSummary;

  const hasReportDetails = Boolean(input.report.verification?.length || input.report.risks?.length);
  return hasReportDetails ? [answer, "", reportSummary].join("\n") : answer;
}

function runArtifactUri(runId: string, artifact: string): string {
  return `opentag://run/${encodeURIComponent(runId)}/${artifact}`;
}

function truncateArtifactText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_ARTIFACT_SUMMARY_LENGTH ? `${normalized.slice(0, MAX_ARTIFACT_SUMMARY_LENGTH - 1)}...` : normalized;
}

function dedupeArtifacts(artifacts: ResultArtifact[]): ResultArtifact[] {
  const seen = new Set<string>();
  const deduped: ResultArtifact[] = [];
  for (const artifact of artifacts) {
    const key = `${artifact.kind ?? "artifact"}:${artifact.uri}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(artifact);
  }
  return deduped;
}

function createRunArtifacts(input: {
  executorName: string;
  runId: string;
  branchName: string;
  baseBranch?: string;
  output: string;
  summary: string;
  changedFiles: string[];
  report?: NonNullable<ReturnType<typeof parseExecutorReport>>;
  extraArtifacts?: ResultArtifact[];
}): ResultArtifact[] {
  const generated: ResultArtifact[] = [];
  if (input.changedFiles.length > 0) {
    generated.push({
      kind: "patch",
      title: "Generated patch",
      uri: input.branchName,
      metadata: {
        runId: input.runId,
        executor: input.executorName,
        branchName: input.branchName,
        baseBranch: input.baseBranch ?? "main",
        changedFiles: input.changedFiles
      }
    });
    generated.push({
      kind: "report",
      title: "Run report",
      uri: runArtifactUri(input.runId, "report"),
      metadata: {
        runId: input.runId,
        executor: input.executorName,
        summary: truncateArtifactText(input.summary),
        changedFiles: input.changedFiles,
        ...(input.report ? { report: input.report } : {})
      }
    });
    generated.push({
      kind: "log_summary",
      title: "Log summary",
      uri: runArtifactUri(input.runId, "log-summary"),
      metadata: {
        runId: input.runId,
        executor: input.executorName,
        summary: truncateArtifactText(executorAnswerBeforeReport(input.output) ?? input.summary)
      }
    });
  }

  return dedupeArtifacts([...generated, ...(input.report?.artifacts ?? []), ...(input.extraArtifacts ?? [])]);
}

export function createExecutorRunResult(input: {
  executorName: string;
  runId: string;
  branchName: string;
  baseBranch?: string;
  output: string;
  changedFiles: string[];
  extraArtifacts?: NonNullable<OpenTagRunResult["artifacts"]>;
}): OpenTagRunResult {
  const proposalId = `proposal_${input.runId}`;
  const report = parseExecutorReport(input.output);
  const summary = report ? summaryWithExecutorAnswer({ ...input, report }) : cleanOrFallbackExecutorSummary(input);
  const artifacts = createRunArtifacts({ ...input, summary, ...(report ? { report } : {}) });
  const suggestedChanges =
    input.changedFiles.length > 0
      ? [
          {
            proposalId,
            createdAt: new Date().toISOString(),
            sourceRunId: input.runId,
            summary: `${input.executorName} changed ${input.changedFiles.length} file(s) on branch ${input.branchName}.`,
            intents: [
              {
                intentId: `${proposalId}_create_pr`,
                domain: "pull_request" as const,
                action: "create_pull_request",
                summary: `Create a pull request for branch ${input.branchName}.`,
                params: {
                  title: `OpenTag run ${input.runId}`,
                  body: [
                    "## Summary",
                    "",
                    summary
                  ].join("\n"),
                  head: input.branchName,
                  base: input.baseBranch ?? "main",
                  changedFiles: input.changedFiles,
                  risks: ["Creates a pull request from the executor-produced branch; review the diff before merging."],
                  executorConditions: ["isolated branch exists"]
                }
              }
            ],
            preconditions: ["The local branch was generated from the checkout state available to the runner."]
          }
        ]
      : undefined;

  return {
    conclusion: "success",
    summary,
    changedFiles: input.changedFiles,
    artifacts,
    ...(suggestedChanges ? { suggestedChanges } : {}),
    nextAction:
      input.changedFiles.length > 0
        ? {
            summary: "Review the proposed pull request action and reply `apply 1` if the branch should become a PR.",
            hint: {
              kind: "create_pull_request",
              targetId: proposalId,
              selectedIntentIds: [`${proposalId}_create_pr`]
            }
          }
        : "No file changes were detected."
  };
}
