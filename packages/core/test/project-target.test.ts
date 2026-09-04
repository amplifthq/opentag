import { describe, expect, it } from "vitest";
import {
  formatProjectTargetRef,
  projectTargetRefFromEvent
} from "../src/project-target.js";

describe("ProjectTargetRef", () => {
  it("formats the explicit provider:owner/repo shape", () => {
    const ref = { provider: "github", owner: "acme", repo: "demo" };

    expect(formatProjectTargetRef(ref)).toBe("github:acme/demo");
  });

  it("uses the only supported Project Target provider when event metadata omits it", () => {
    expect(projectTargetRefFromEvent({ metadata: { owner: "acme", repo: "demo" } })).toEqual({
      provider: "github",
      owner: "acme",
      repo: "demo"
    });
  });

  it("returns null when event metadata does not name a project target", () => {
    expect(projectTargetRefFromEvent({ metadata: { owner: "acme" } })).toBeNull();
    expect(projectTargetRefFromEvent({ metadata: { repo: "demo" } })).toBeNull();
    expect(projectTargetRefFromEvent(undefined)).toBeNull();
    expect(projectTargetRefFromEvent({})).toBeNull();
  });

  it("normalizes event metadata and rejects blank project target segments", () => {
    expect(projectTargetRefFromEvent({ metadata: { repoProvider: " github ", owner: " acme ", repo: " demo " } })).toEqual({
      provider: "github",
      owner: "acme",
      repo: "demo"
    });
    expect(projectTargetRefFromEvent({ metadata: { owner: " ", repo: "demo" } })).toBeNull();
    expect(projectTargetRefFromEvent({ metadata: { owner: "acme", repo: "" } })).toBeNull();
    expect(projectTargetRefFromEvent({ metadata: { repoProvider: " ", owner: "acme", repo: "demo" } })).toBeNull();
  });

});
