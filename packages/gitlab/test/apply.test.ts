import { describe, expect, it } from "vitest";
import { applyGitLabMutationIntent, compileGitLabMutationIntent } from "../src/apply.js";
import { createMergeRequestViaFetch } from "../src/merge-request.js";

describe("GitLab apply helpers", () => {
  it("compiles create_pull_request intents into GitLab merge request operations", () => {
    expect(
      compileGitLabMutationIntent({
        intentId: "intent_create_mr",
        domain: "pull_request",
        action: "create_pull_request",
        summary: "Create an MR for the generated branch.",
        params: {
          title: "OpenTag run run_1",
          head: "opentag/run_1",
          base: "main",
          changedFiles: ["src/demo.ts"],
          risks: ["Review before merge."]
        }
      })
    ).toEqual({
      ok: true,
      intentId: "intent_create_mr",
      operation: {
        kind: "create_merge_request",
        intentId: "intent_create_mr",
        title: "OpenTag run run_1",
        description: ["## Summary", "", "Create an MR for the generated branch.", "", "## Changed Files", "- `src/demo.ts`", "", "## Risks", "- Review before merge."].join(
          "\n"
        ),
        sourceBranch: "opentag/run_1",
        targetBranch: "main"
      }
    });
  });

  it("requires a source branch for create_pull_request intents", () => {
    expect(
      compileGitLabMutationIntent({
        intentId: "intent_create_mr",
        domain: "pull_request",
        action: "create_pull_request",
        summary: "Create an MR.",
        params: { title: "OpenTag run run_1" }
      })
    ).toEqual({
      ok: false,
      outcome: {
        intentId: "intent_create_mr",
        outcome: "failed",
        message: "create_pull_request requires params.head or params.branch."
      }
    });
  });

  it("creates merge requests through the GitLab API", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown; token: string | null }> = [];
    const fetchImpl = (async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        token: new Headers(init?.headers).get("PRIVATE-TOKEN")
      });
      return Response.json({ web_url: "https://gitlab.example.com/acme/team/demo/-/merge_requests/42" });
    }) as typeof fetch;

    await expect(
      createMergeRequestViaFetch(
        {
          token: "glpat_test",
          baseUrl: "https://gitlab.example.com/",
          projectPathWithNamespace: "acme/team/demo",
          title: "OpenTag run run_1",
          description: "MR body",
          sourceBranch: "opentag/run_1",
          targetBranch: "main",
          removeSourceBranch: true
        },
        fetchImpl
      )
    ).resolves.toBe("https://gitlab.example.com/acme/team/demo/-/merge_requests/42");

    expect(requests).toEqual([
      {
        url: "https://gitlab.example.com/api/v4/projects/acme%2Fteam%2Fdemo/merge_requests",
        method: "POST",
        token: "glpat_test",
        body: {
          title: "OpenTag run run_1",
          description: "MR body",
          source_branch: "opentag/run_1",
          target_branch: "main",
          remove_source_branch: true
        }
      }
    ]);
  });

  it("reports a missing web_url when the merge request API response is null", async () => {
    const fetchImpl = (async () => Response.json(null)) as typeof fetch;

    await expect(
      createMergeRequestViaFetch(
        {
          token: "glpat_test",
          baseUrl: "https://gitlab.example.com",
          projectPathWithNamespace: "acme/demo",
          title: "OpenTag run run_1",
          description: "MR body",
          sourceBranch: "opentag/run_1",
          targetBranch: "main"
        },
        fetchImpl
      )
    ).rejects.toThrow("create merge request response did not include web_url");
  });

  it("applies create_pull_request intents through the GitLab merge requests API", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown; token: string | null }> = [];
    const fetchImpl = (async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        token: new Headers(init?.headers).get("PRIVATE-TOKEN")
      });
      return Response.json({ web_url: "https://gitlab.example.com/acme/demo/-/merge_requests/42" });
    }) as typeof fetch;

    await expect(
      applyGitLabMutationIntent({
        target: {
          token: "glpat_test",
          baseUrl: "https://gitlab.example.com",
          projectPathWithNamespace: "acme/demo"
        },
        fetchImpl,
        intent: {
          intentId: "intent_create_mr",
          domain: "pull_request",
          action: "create_pull_request",
          summary: "Create an MR.",
          params: {
            title: "OpenTag run run_1",
            body: "MR body",
            head: "opentag/run_1",
            base: "main"
          }
        }
      })
    ).resolves.toEqual({
      intentId: "intent_create_mr",
      outcome: "applied",
      externalUri: "https://gitlab.example.com/acme/demo/-/merge_requests/42"
    });

    expect(requests).toEqual([
      {
        url: "https://gitlab.example.com/api/v4/projects/acme%2Fdemo/merge_requests",
        method: "POST",
        token: "glpat_test",
        body: {
          title: "OpenTag run run_1",
          description: "MR body",
          source_branch: "opentag/run_1",
          target_branch: "main"
        }
      }
    ]);
  });
});
