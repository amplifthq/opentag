import type { OpenTagRunResult } from "@opentag/core";

export type CreatePullRequestInput = {
  token: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
};

export type FetchLike = typeof fetch;

export function buildPullRequestBody(result: OpenTagRunResult): string {
  const lines = ["## Summary", "", result.summary];

  if (result.changedFiles?.length) {
    lines.push("", "## Changed Files");
    for (const file of result.changedFiles) {
      lines.push(`- \`${file}\``);
    }
  }

  if (result.verification?.length) {
    lines.push("", "## Verification");
    for (const check of result.verification) {
      lines.push(`- \`${check.command}\`: ${check.outcome}`);
    }
  }

  return lines.join("\n");
}

export async function createPullRequestViaFetch(input: CreatePullRequestInput, fetchImpl: FetchLike = fetch): Promise<string> {
  const response = await fetchImpl(`https://api.github.com/repos/${input.owner}/${input.repo}/pulls`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28"
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base
    })
  });

  if (!response.ok) {
    throw new Error(`create pull request failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { html_url?: string };
  if (!body.html_url) {
    throw new Error("create pull request response did not include html_url");
  }
  return body.html_url;
}
