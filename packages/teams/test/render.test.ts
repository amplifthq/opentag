import { describe, expect, it } from "vitest";
import { renderTeamsAcknowledgement, renderTeamsFinalResult, renderTeamsProgress } from "../src/render.js";

describe("teams render", () => {
  it("acknowledges with the run id", () => {
    expect(renderTeamsAcknowledgement("run-1")).toContain("run-1");
  });

  it("summarizes progress without leaking internal agent chatter", () => {
    expect(renderTeamsProgress("starting codex")).toBe("Thinking...");
    expect(renderTeamsProgress("uploading artifact")).toBe("Working...");
  });

  it("renders a final result with outcome, summary, and audit line", () => {
    const text = renderTeamsFinalResult(
      { conclusion: "success", summary: "Opened PR #12", verification: [], nextAction: undefined } as never,
      { auditRunId: "run-1" }
    );
    expect(text).toContain("success");
    expect(text).toContain("Opened PR #12");
    expect(text).toContain("opentag status --run run-1");
  });

  it("renders verification and next-action sections", () => {
    const text = renderTeamsFinalResult(
      {
        conclusion: "success",
        summary: "All checks passed.",
        verification: [{ command: "pnpm test", outcome: "passed" }],
        nextAction: "Review the PR."
      } as never,
      { auditRunId: "run-1" }
    );
    expect(text).toContain("Finished with success.");
    expect(text).toContain("All checks passed.");
    expect(text).toContain("Verification:");
    expect(text).toContain("pnpm test");
    expect(text).toContain("passed");
    expect(text).toContain("Next action: Review the PR.");
    expect(text).toContain("opentag status --run run-1");
  });
});
