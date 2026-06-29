import type { OpenTagRunResult } from "@opentag/core";

const MAX_EXECUTOR_SUMMARY_LENGTH = 4000;

const GIT_HANDOFF_PATTERNS = [
  /\bgit\s+(?:add|commit|push|status|checkout)\b/i,
  /\bgh\s+pr\s+create\b/i,
  /\binteractive user approval\b/i,
  /\bpermission system\b/i,
  /\brequires?\s+approval\b.*\b(?:git|commit|push|pull request|pr)\b/i,
  /\b(?:cannot|can't|need|needs|please|approve|approval|required)\b.*\b(?:git|commit|push|pull request|pr)\b/i,
  /\b(?:commit|push|create (?:a )?(?:pull request|pr)|open (?:a )?pull request)\b.*\b(?:approve|approval|manual|finish|next|requires?|required)\b/i
];

const HANDOFF_HEADING_PATTERN =
  /^(?:#{1,6}\s*)?(?:\*\*)?\s*(?:blocker|recommended next action|next action|remaining work|manual steps|to finish)\b/i;

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
  const rawSummary = input.output.slice(-MAX_EXECUTOR_SUMMARY_LENGTH).replace(/\r\n/g, "\n");
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
    .replace(/```[^\n]*\n\s*```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (summary.length > 0) return summary;

  if (input.changedFiles.length === 0) {
    return `${input.executorName} completed without file changes.`;
  }

  return `${input.executorName} changed ${input.changedFiles.length} file(s). Changed files: ${input.changedFiles.join(", ")}.`;
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
  const summary = cleanOrFallbackExecutorSummary(input);
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
              },
              {
                intentId: `${proposalId}_link_branch`,
                domain: "artifact_links" as const,
                action: "link_artifact",
                summary: `Link the run branch ${input.branchName} to the work item.`,
                params: { title: "Run branch", uri: input.branchName }
              },
              {
                intentId: `${proposalId}_request_review`,
                domain: "review" as const,
                action: "request_review",
                summary: "Request human review of the generated code changes.",
                params: { changedFiles: input.changedFiles }
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
    artifacts: [
      ...(input.changedFiles.length > 0 ? [{ kind: "patch" as const, title: "Run branch", uri: input.branchName }] : []),
      ...(input.extraArtifacts ?? [])
    ],
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
