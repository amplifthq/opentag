import { describe, expect, it } from "vitest";
import {
  formatProjectTargetRef,
  parseProjectTargetRef,
  projectTargetRefFromEvent,
  projectTargetRefFromLocalPath
} from "../src/project-target.js";

describe("ProjectTargetRef", () => {
  it("formats and parses the existing provider:owner/repo shape", () => {
    const ref = { provider: "github", owner: "acme", repo: "demo" };

    expect(formatProjectTargetRef(ref)).toBe("github:acme/demo");
    expect(parseProjectTargetRef("github:acme/demo")).toEqual(ref);
  });

  it("parses owner/repo as a GitHub Project Target ref for compatibility", () => {
    expect(parseProjectTargetRef("acme/demo")).toEqual({
      provider: "github",
      owner: "acme",
      repo: "demo"
    });
  });

  it("defaults event metadata without repoProvider to github", () => {
    expect(projectTargetRefFromEvent({ metadata: { owner: "acme", repo: "demo" } })).toEqual({
      provider: "github",
      owner: "acme",
      repo: "demo"
    });
  });

  it("returns null when event metadata does not name a project target", () => {
    expect(projectTargetRefFromEvent({ metadata: { owner: "acme" } })).toBeNull();
    expect(projectTargetRefFromEvent({ metadata: { repo: "demo" } })).toBeNull();
  });

  it("uses the full normalized local path for local project identity", () => {
    const first = projectTargetRefFromLocalPath("/Users/alice/work/app");
    const second = projectTargetRefFromLocalPath("/Users/alice/scratch/app");

    expect(first.provider).toBe("local");
    expect(first.repo).toBe("app");
    expect(second.repo).toBe("app");
    expect(first.owner).not.toBe(second.owner);
    expect(formatProjectTargetRef(first)).not.toBe(formatProjectTargetRef(second));
  });

  it("keeps local project target refs stable for trailing slash variants", () => {
    expect(projectTargetRefFromLocalPath("/Users/alice/work/app")).toEqual(
      projectTargetRefFromLocalPath("/Users/alice/work/app/")
    );
  });
});
