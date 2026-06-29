import { describe, expect, it } from "vitest";
import { defaultExecutorId, detectExecutors } from "../src/catalogs/executors.js";

describe("executor catalog", () => {
  it("uses OPENTAG_HERMES_COMMAND for Hermes detection", () => {
    const detections = detectExecutors({ PATH: "", OPENTAG_HERMES_COMMAND: process.execPath } as NodeJS.ProcessEnv);
    const hermes = detections.find((executor) => executor.id === "hermes");

    expect(hermes).toMatchObject({ available: true, reason: `Found ${process.execPath} on PATH` });
    expect(defaultExecutorId({ detections })).toBe("hermes");
  });
});
