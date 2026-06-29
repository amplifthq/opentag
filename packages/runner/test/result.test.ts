import { describe, expect, it } from "vitest";
import { createExecutorRunResult } from "../src/result.js";

describe("createExecutorRunResult", () => {
  it("removes executor source-control handoff instructions from user-visible summaries", () => {
    const result = createExecutorRunResult({
      executorName: "Claude Code",
      runId: "run_1",
      branchName: "opentag/run_1",
      output: [
        "What changed: Added the requested README sentence.",
        "",
        "Verified: The edit applied cleanly.",
        "",
        "Recommended next action: Commit the change and push to the branch.",
        "",
        "Blocker: I cannot run `git add README.md` or `git commit` because those commands require interactive user approval.",
        "",
        "To finish:",
        "```bash",
        "git add README.md && git commit -m \"Update README\" && gh pr create",
        "```"
      ].join("\n"),
      changedFiles: ["README.md"]
    });

    expect(result.summary).toContain("What changed: Added the requested README sentence.");
    expect(result.summary).toContain("Verified: The edit applied cleanly.");
    expect(result.summary).not.toMatch(/git\s+add/i);
    expect(result.summary).not.toMatch(/git\s+commit/i);
    expect(result.summary).not.toMatch(/git\s+push/i);
    expect(result.summary).not.toMatch(/gh\s+pr\s+create/i);
    expect(result.summary).not.toMatch(/interactive user approval/i);
    expect(result.summary).not.toContain("```");

    const pullRequestBody = result.suggestedChanges?.[0]?.intents[0]?.params?.["body"];
    expect(pullRequestBody).toContain("What changed: Added the requested README sentence.");
    expect(pullRequestBody).toContain("Verified: The edit applied cleanly.");
    expect(pullRequestBody).not.toMatch(/git\s+add/i);
    expect(pullRequestBody).not.toMatch(/git\s+commit/i);
    expect(pullRequestBody).not.toMatch(/gh\s+pr\s+create/i);
    expect(result.nextAction).toMatchObject({
      summary: "Review the proposed pull request action and reply `apply 1` if the branch should become a PR."
    });
  });

  it("falls back to an OpenTag-owned summary when the executor output is only handoff noise", () => {
    const result = createExecutorRunResult({
      executorName: "Claude Code",
      runId: "run_1",
      branchName: "opentag/run_1",
      output: "Please approve `git add README.md && git commit && gh pr create` to finish.",
      changedFiles: ["README.md", "docs/setup.md"]
    });

    expect(result.summary).toBe("Claude Code changed 2 file(s). Changed files: README.md, docs/setup.md.");
    expect(result.summary).not.toMatch(/git\s+add/i);
    expect(result.suggestedChanges?.[0]?.intents[0]?.params?.["body"]).not.toMatch(/git\s+add/i);
  });
});
