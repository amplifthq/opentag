import { describe, expect, it } from "vitest";
import { buildPullRequestBody, createPullRequestViaFetch } from "../src/pull-request.js";
import { createExactDraftPullRequest } from "../src/publisher.js";

describe("pull request helpers", () => {
  it("builds a verification-oriented PR body", () => {
    expect(
      buildPullRequestBody({
        conclusion: "success",
        summary: "Implemented the fix.",
        changedFiles: ["src/demo.ts"],
        verification: [{ command: "pnpm test", outcome: "passed" }]
      })
    ).toContain("`pnpm test`: passed");
  });

  it("creates a pull request through the GitHub REST API", async () => {
    const requests: { url: string; body: unknown; authorization: string | null }[] = [];
    const url = await createPullRequestViaFetch(
      {
        token: "ghs_test",
        owner: "acme",
        repo: "demo",
        title: "OpenTag run run_1",
        body: "body",
        head: "opentag/run_1",
        base: "main",
        draft: true,
      },
      (async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          authorization: new Headers(init?.headers).get("authorization")
        });
        return Response.json({ html_url: "https://github.com/acme/demo/pull/1" });
      }) as typeof fetch
    );

    expect(url).toBe("https://github.com/acme/demo/pull/1");
    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/pulls",
        authorization: "Bearer ghs_test",
        body: {
          title: "OpenTag run run_1",
          body: "body",
          head: "opentag/run_1",
          base: "main",
          draft: true,
        }
      }
    ]);
  });

  it("rejects non-draft pull request creation", async () => {
    await expect(createPullRequestViaFetch({
      token: "ghs_test", owner: "acme", repo: "demo", title: "title",
      body: "body", head: "opentag/run_1", base: "main", draft: false,
    }, async () => { throw new Error("provider must not be called"); }))
      .rejects.toThrow("draft_pull_request_required");
  });

  it("refetches an exact provider PR when create response omits head provenance", async () => {
    const requests: string[] = [];
    const observation = await createExactDraftPullRequest({
      token: "ghs_test", owner: "acme", repo: "demo", title: "title", body: "body",
      head: "opentag/run_1", base: "main", expectedHeadSha: "a".repeat(40),
      fetchImpl: (async (url, init) => {
        requests.push(`${init?.method ?? "GET"} ${String(url)}`);
        if (init?.method === "POST") return Response.json({ html_url: "https://github.com/acme/demo/pull/7" });
        return Response.json({ number: 7, html_url: "https://github.com/acme/demo/pull/7", draft: true,
          state: "open", merged: false, head: { sha: "a".repeat(40), ref: "opentag/run_1",
            repo: { full_name: "acme/demo" } },
          base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "acme/demo" } } });
      }) as typeof fetch,
    });
    expect(requests).toEqual([
      "POST https://api.github.com/repos/acme/demo/pulls",
      "GET https://api.github.com/repos/acme/demo/pulls/7",
    ]);
    expect(observation).toEqual(expect.objectContaining({ kind: "present", headBranch: "opentag/run_1",
      headRepository: { owner: "acme", repo: "demo" } }));
  });
});
