import type { OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import { buildPullRequestBody, createPullRequestViaFetch, type FetchLike } from "@opentag/github";
import { branchNameForRun, nodeCommandRunner, pushBranch, type CommandRunner } from "@opentag/runner";
import type { RepositoryBindingConfig } from "./config.js";

export type PullRequestOptions = {
  githubToken?: string;
  commandRunner?: CommandRunner;
  fetchImpl?: FetchLike;
};

function hasPermission(event: OpenTagEvent, scope: string): boolean {
  return event.permissions.some((permission) => permission.scope === scope);
}

function isGitHubRepositoryTarget(input: { event: OpenTagEvent; binding: RepositoryBindingConfig }): boolean {
  const repoProvider = input.event.metadata["repoProvider"];
  return input.binding.provider === "github" && (repoProvider == null || repoProvider === "github");
}

export async function maybeCreatePullRequest(input: {
  run: OpenTagRun;
  event: OpenTagEvent;
  binding: RepositoryBindingConfig;
  result: OpenTagRunResult;
  options: PullRequestOptions;
}): Promise<OpenTagRunResult> {
  if (!input.options.githubToken) return input.result;
  if (!isGitHubRepositoryTarget({ event: input.event, binding: input.binding })) return input.result;
  if (!hasPermission(input.event, "pr:create")) return input.result;
  if (!input.result.changedFiles?.length) return input.result;

  const owner = input.event.metadata["owner"];
  const repo = input.event.metadata["repo"];
  if (typeof owner !== "string" || typeof repo !== "string") return input.result;

  const branchName = branchNameForRun(input.run.id);
  await pushBranch({
    runner: input.options.commandRunner ?? nodeCommandRunner,
    workspacePath: input.binding.checkoutPath,
    remote: input.binding.pushRemote ?? "origin",
    branchName
  });

  const pullRequestUrl = await createPullRequestViaFetch(
    {
      token: input.options.githubToken,
      owner,
      repo,
      title: `OpenTag run ${input.run.id}`,
      body: buildPullRequestBody(input.result),
      head: branchName,
      base: input.binding.baseBranch ?? "main"
    },
    input.options.fetchImpl
  );

  return {
    ...input.result,
    createdPullRequestUrl: pullRequestUrl,
    artifacts: [...(input.result.artifacts ?? []), { title: "Pull request", uri: pullRequestUrl }],
    nextAction: `Review pull request: ${pullRequestUrl}`
  };
}
