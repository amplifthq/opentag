import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    expect(projectTargetRefFromEvent(undefined)).toBeNull();
    expect(projectTargetRefFromEvent({})).toBeNull();
  });

  it("normalizes event metadata and rejects blank project target segments", () => {
    expect(projectTargetRefFromEvent({ metadata: { repoProvider: " gitlab ", owner: " acme ", repo: " demo " } })).toEqual({
      provider: "gitlab",
      owner: "acme",
      repo: "demo"
    });
    expect(projectTargetRefFromEvent({ metadata: { owner: " ", repo: "demo" } })).toBeNull();
    expect(projectTargetRefFromEvent({ metadata: { owner: "acme", repo: "" } })).toBeNull();
    expect(projectTargetRefFromEvent({ metadata: { repoProvider: " ", owner: "acme", repo: "demo" } })).toBeNull();
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

  it("keeps the local Project Target script helper consistent with the core helper", () => {
    const workspace = mkdtempSync(join(tmpdir(), "opentag-project-target-"));
    const symlinkPath = `${workspace}-link`;
    try {
      symlinkSync(workspace, symlinkPath);
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
      const appDir = join(repoRoot, "apps/lark-events");
      const script = join(repoRoot, "scripts/dev/print-local-project-target-ref.ts");
      const tsx = join(appDir, "node_modules/.bin/tsx");
      const env = { ...process.env, NODE_OPTIONS: "--conditions=development" };

      const fromRealPath = execFileSync(tsx, [script, workspace], { cwd: appDir, env, encoding: "utf8" });
      const fromSymlinkPath = execFileSync(tsx, [script, symlinkPath], { cwd: appDir, env, encoding: "utf8" });
      const fromCore = formatProjectTargetRef(projectTargetRefFromLocalPath(realpathSync.native(workspace)));

      expect(fromRealPath).toBe(fromCore);
      expect(fromSymlinkPath).toBe(fromCore);
    } finally {
      if (existsSync(symlinkPath)) unlinkSync(symlinkPath);
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
