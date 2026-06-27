import type { OpenTagRunResult } from "@opentag/core";

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
  const summary = input.output.slice(-4000);
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
