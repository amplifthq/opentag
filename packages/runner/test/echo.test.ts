import { describe, expect, it } from "vitest";
import { createEchoExecutor } from "../src/echo.js";

describe("echo executor", () => {
  it("returns the command text as a successful result", async () => {
    const events: string[] = [];
    const executor = createEchoExecutor();
    const result = await executor.run(
      {
        runId: "run_1",
        workspace: { kind: "scratch", path: "/tmp/demo" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      },
      {
        emit: async (event) => {
          events.push(event.type);
        }
      }
    );

    expect(events).toContain("executor.started");
    expect(result.conclusion).toBe("success");
    expect(result.summary).toContain("fix this");
    expect(result.nextAction).toEqual({
      summary: "No external state change is suggested for the echo executor result.",
      hint: { kind: "none" }
    });
  });
});
