import { normalizeGitLabBaseUrl } from "./normalize.js";

export type CreateMergeRequestInput = {
  token: string;
  projectPathWithNamespace: string;
  baseUrl?: string;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  removeSourceBranch?: boolean;
};

export type FetchLike = typeof fetch;

function mergeRequestsUrl(input: { baseUrl?: string; projectPathWithNamespace: string }): string {
  const encodedProject = encodeURIComponent(input.projectPathWithNamespace);
  return `${normalizeGitLabBaseUrl(input.baseUrl)}/api/v4/projects/${encodedProject}/merge_requests`;
}

export async function createMergeRequestViaFetch(input: CreateMergeRequestInput, fetchImpl: FetchLike = fetch): Promise<string> {
  const response = await fetchImpl(mergeRequestsUrl(input), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "PRIVATE-TOKEN": input.token
    },
    body: JSON.stringify({
      title: input.title,
      description: input.description,
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      ...(input.removeSourceBranch !== undefined ? { remove_source_branch: input.removeSourceBranch } : {})
    })
  });

  if (!response.ok) {
    throw new Error(`create merge request failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { web_url?: string };
  if (!body.web_url) {
    throw new Error("create merge request response did not include web_url");
  }
  return body.web_url;
}
