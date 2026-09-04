import { describe, expect, it } from "vitest";
import { isRepositoryFreePermissionScope } from "../src/index.js";

describe("repository-free permission scope classification", () => {
  it.each([
    "chat:postMessage",
    "reactions:write",
    "runner:local",
    "agent:activity",
    "network:restricted"
  ])("allows the known repository-free scope %s", (scope) => {
    expect(isRepositoryFreePermissionScope(scope)).toBe(true);
  });

  it.each(["repo:read", "repo:write", "pr:create", "pr:update", "issue:create", "issue:comment", "git:push", "branch:write", "future:unknown"])(
    "fails closed for repository-bound or unknown scope %s",
    (scope) => {
      expect(isRepositoryFreePermissionScope(scope)).toBe(false);
    }
  );
});
