import { describe, expect, it } from "vitest";
import { buildPullRequestBody, createPullRequestViaFetch } from "../src/pull-request.js";

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
        base: "main"
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
          base: "main"
        }
      }
    ]);
  });
});
