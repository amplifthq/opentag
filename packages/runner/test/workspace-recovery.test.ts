import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeCommandRunner } from "../src/command.js";
import { attestAttemptWorkspace, recoverInterruptedAttemptWorkspace,
  verifyAttemptWorkspaceAttestation } from "../src/git.js";

function repository() {
  const path = mkdtempSync(join(tmpdir(), "opentag-attestation-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: path });
  execFileSync("git", ["config", "user.name", "OpenTag Test"], { cwd: path });
  writeFileSync(join(path, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: path });
  execFileSync("git", ["commit", "-m", "base"], { cwd: path });
  return path;
}

describe("attempt workspace recovery", () => {
  it("continues only while path, base, tree, Attempt, fence, credential, and lease match", async () => {
    const path = repository();
    const input = { runner: nodeCommandRunner, workspacePath: path, repositoryPath: path,
      workspaceId: "workspace_attempt_2", baseRevision: "HEAD", attemptId: "attempt_2",
      attemptNumber: 2, fencingTokenDigest: `sha256:${"1".repeat(64)}`,
      credentialId: "credential_1", leaseExpiresAt: "2026-08-30T01:00:00.000Z" };
    const attestation = await attestAttemptWorkspace(input);
    await expect(verifyAttemptWorkspaceAttestation({ ...input, attestation,
      now: new Date("2026-08-30T00:00:00.000Z") })).resolves.toBe(true);
    writeFileSync(join(path, "README.md"), "changed behind reconnect\n");
    await expect(verifyAttemptWorkspaceAttestation({ ...input, attestation,
      now: new Date("2026-08-30T00:00:00.000Z") })).resolves.toBe(false);
    await expect(verifyAttemptWorkspaceAttestation({ ...input, attestation,
      fencingTokenDigest: `sha256:${"2".repeat(64)}`,
      now: new Date("2026-08-30T00:00:00.000Z") })).resolves.toBe(false);
  });

  it("retains expired workspaces as interrupted evidence and allocates a new Attempt identity", () => {
    const recovered = recoverInterruptedAttemptWorkspace({ runId: "run_1",
      oldAttemptId: "attempt_1", oldWorkspaceId: "workspace_attempt_1",
      oldWorkspacePathDigest: `sha256:${"1".repeat(64)}`,
      replacementAttemptId: "attempt_2", replacementFenceDigest: `sha256:${"2".repeat(64)}` });
    expect(recovered.oldWorkspace.state).toBe("interrupted_evidence");
    expect(recovered.newWorkspace.id).not.toBe(recovered.oldWorkspace.id);
    expect(recovered.newWorkspace.reuseOldWorkspace).toBe(false);
  });
});
