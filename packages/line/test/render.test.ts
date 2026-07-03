import { describe, expect, it } from "vitest";
import { createLinePushMessagePayloads, renderLineAcknowledgement, renderLineFinalResult, renderLineProgress } from "../src/render.js";

describe("LINE rendering", () => {
  it("renders text callbacks", () => {
    expect(renderLineAcknowledgement("run_1")).toContain("run_1");
    expect(renderLineProgress()).toBe("Working...");
    expect(
      renderLineFinalResult(
        { conclusion: "success", summary: "Done.", verification: [{ command: "pnpm test", outcome: "passed" }], nextAction: "Review." },
        { auditRunId: "run_1" }
      )
    ).toContain("Audit: opentag status --run run_1");
  });

  it("chunks push payloads at LINE limits", () => {
    const payloads = createLinePushMessagePayloads({ to: "U123", text: "x".repeat(5000 * 6) });
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.messages).toHaveLength(5);
    expect(payloads[1]?.messages).toHaveLength(1);
  });
});
