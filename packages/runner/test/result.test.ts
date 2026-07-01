import { describe, expect, it } from "vitest";
import { EXECUTOR_REPORT_END, EXECUTOR_REPORT_START } from "../src/executor-report.js";
import { createExecutorRunResult } from "../src/result.js";

describe("createExecutorRunResult", () => {
  it("renders user-visible summaries from the structured executor report when present", () => {
    const result = createExecutorRunResult({
      executorName: "Claude Code",
      runId: "run_1",
      branchName: "opentag/run_1",
      output: [
        "Raw executor note: please approve `git commit` and `gh pr create` to finish.",
        EXECUTOR_REPORT_START,
        JSON.stringify({
          changes: [{ file: "README.md", summary: "Added one sentence about clean Slack approval summaries." }],
          verification: [{ outcome: "passed", summary: "The edit applied cleanly." }],
          risks: ["No known risks beyond reviewing the generated diff."]
        }),
        EXECUTOR_REPORT_END
      ].join("\n"),
      changedFiles: ["README.md"]
    });

    expect(result.summary).toBe(
      [
        "What changed:",
        "- `README.md`: Added one sentence about clean Slack approval summaries.",
        "",
        "Verified:",
        "- passed - The edit applied cleanly.",
        "",
        "Risks:",
        "- No known risks beyond reviewing the generated diff."
      ].join("\n")
    );
    expect(result.summary).not.toMatch(/git\s+commit/i);
    expect(result.summary).not.toMatch(/gh\s+pr\s+create/i);

    const pullRequestBody = result.suggestedChanges?.[0]?.intents[0]?.params?.["body"];
    expect(pullRequestBody).toContain("- `README.md`: Added one sentence about clean Slack approval summaries.");
    expect(pullRequestBody).not.toMatch(/git\s+commit/i);
    expect(pullRequestBody).not.toMatch(/gh\s+pr\s+create/i);
  });

  it("preserves no-change answer text before a structured executor report", () => {
    const result = createExecutorRunResult({
      executorName: "Codex",
      runId: "run_1",
      branchName: "opentag/run_1",
      output: [
        "OpenTag is a local-first source-thread callback system. It connects chat or issue events to a local coding agent, runs work in an isolated checkout, and posts concise results back to the originating thread.",
        "",
        EXECUTOR_REPORT_START,
        JSON.stringify({
          changes: [],
          verification: [
            {
              command: "git status --short --branch",
              outcome: "passed",
              summary: "Confirmed the checkout remained clean after read-only inspection."
            }
          ],
          risks: []
        }),
        EXECUTOR_REPORT_END
      ].join("\n"),
      changedFiles: []
    });

    expect(result.summary).toContain("OpenTag is a local-first source-thread callback system.");
    expect(result.summary).toContain("Verified:");
    expect(result.summary).toContain("git status --short --branch");
    expect(result.summary).not.toContain(EXECUTOR_REPORT_START);
    expect(result.summary).not.toContain(EXECUTOR_REPORT_END);
  });

  it("drops a leading partial line when a long no-change answer is truncated before the executor report", () => {
    const result = createExecutorRunResult({
      executorName: "Codex",
      runId: "run_1",
      branchName: "opentag/run_1",
      output: [
        `${"OpenTag policy handoff ".repeat(260)}source-thread decisions apply/reject/continue.`,
        "",
        "**Repository Shape**",
        "This is a PNPM workspace with packages, apps, docs, and examples.",
        "",
        EXECUTOR_REPORT_START,
        JSON.stringify({
          changes: [],
          verification: [{ command: "git status --short", outcome: "passed", summary: "No file changes." }],
          risks: []
        }),
        EXECUTOR_REPORT_END
      ].join("\n"),
      changedFiles: []
    });

    expect(result.summary).toContain("**Repository Shape**");
    expect(result.summary).toContain("This is a PNPM workspace");
    expect(result.summary).not.toContain("apply/reject/continue");
    expect(result.summary.trimStart().startsWith("**Repository Shape**")).toBe(true);
  });

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

  it("preserves generic blocker and permission-system status lines in fallback summaries", () => {
    const result = createExecutorRunResult({
      executorName: "Claude Code",
      runId: "run_1",
      branchName: "opentag/run_1",
      output: [
        "What changed:",
        "- Updated permission-system documentation.",
        "",
        "Blocker: External API credentials are missing.",
        "",
        "Verified: Not run because credentials are missing."
      ].join("\n"),
      changedFiles: ["docs/security.md"]
    });

    expect(result.summary).toContain("What changed:");
    expect(result.summary).toContain("Updated permission-system documentation.");
    expect(result.summary).toContain("Blocker: External API credentials are missing.");
    expect(result.summary).toContain("Verified: Not run because credentials are missing.");
  });
});
