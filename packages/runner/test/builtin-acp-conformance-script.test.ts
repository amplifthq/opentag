import { describe, expect, it } from "vitest";
import { classifyBuiltInAcpFailure } from "../../../scripts/test/builtin-acp-conformance.js";

describe("built-in ACP conformance failure classification", () => {
  it.each([
    "Authentication required",
    "Hermes inference provider is unavailable",
    "Error calling LLM API: insufficient quota",
    "Model configured-model not found"
  ])("records provider state without treating it as an implementation diagnosis: %s", (message) => {
    expect(classifyBuiltInAcpFailure(new Error(message))).toBe("provider_status");
  });

  it("classifies protocol and process-tree failures as conformance failures", () => {
    expect(classifyBuiltInAcpFailure(new Error("Cancelled tool process 42 is still alive."))).toBe("conformance");
  });
});
