import { describe, expect, it } from "vitest";
import { isRepositoryFreePermissionScope } from "../src/index.js";

describe("repository-free permission scope classification", () => {
  it.each([
    "chat:postMessage",
    "reactions:write",
    "runner:local",
    "issue:create",
    "issue:comment",
    "agent:activity",
    "network:restricted"
  ])("allows the known repository-free scope %s", (scope) => {
    expect(isRepositoryFreePermissionScope(scope)).toBe(true);
  });

  it.each(["repo:read", "repo:write", "pr:create", "pr:update", "git:push", "branch:write", "future:unknown"])(
    "fails closed for repository-bound or unknown scope %s",
    (scope) => {
      expect(isRepositoryFreePermissionScope(scope)).toBe(false);
    }
  );
});
