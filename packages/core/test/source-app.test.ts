import { describe, expect, it } from "vitest";
import { SourceAppCapabilitiesSchema } from "../src/source-app.js";

describe("Source App core contract", () => {
  it("accepts the complete provider-neutral capability vocabulary", () => {
    expect(SourceAppCapabilitiesSchema.parse({
      threads: true,
      messageUpdate: false,
      reactions: true,
      interactiveActions: false,
      attachments: "metadata",
      authenticatedDeletion: true,
      stableSourceVersions: true
    })).toEqual({
      threads: true,
      messageUpdate: false,
      reactions: true,
      interactiveActions: false,
      attachments: "metadata",
      authenticatedDeletion: true,
      stableSourceVersions: true
    });
  });

  it("rejects undeclared capabilities instead of silently widening the contract", () => {
    expect(() => SourceAppCapabilitiesSchema.parse({
      threads: true,
      messageUpdate: true,
      reactions: true,
      interactiveActions: true,
      attachments: "body",
      authenticatedDeletion: true,
      stableSourceVersions: true,
      messageScheduling: true
    })).toThrow();
  });
});
