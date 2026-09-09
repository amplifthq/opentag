import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareLocalWriteObservation } from "../src/local-write-observation.js";

const roots: string[] = [];
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "opentag-write-proof-"))); roots.push(root);
  const path = join(root, "result.txt");
  const attestation = { workspaceId: "workspace_test", workspacePathDigest: hash(root),
    worktreeIdentityDigest: hash("git-dir"), repositoryPathDigest: hash("repo"), baseRevision: "a".repeat(40),
    currentRevision: "a".repeat(40), currentTree: "b".repeat(40), workspaceStateDigest: hash("state"),
    attemptId: "attempt_test", attemptNumber: 1, fencingTokenDigest: hash("fence"),
    credentialId: "credential_test", leaseExpiresAt: "2099-01-01T00:00:00.000Z" };
  return { root, path, input: { rawInput: { file_path: path, content: "expected\n" },
    operation: "edit", targetFingerprint: hash("exact-request"), workspacePath: root, attestation } };
}

it.each(["write", "edit"])("observes bounded exact %s contents without trusting a reported result", async operation => {
  const f = fixture(); const observe = await prepareLocalWriteObservation({ ...f.input, operation });
  expect(observe).toBeTypeOf("function");
  expect(await observe!()).toBeUndefined();
  writeFileSync(f.path, "wrong\n"); expect(await observe!()).toBeUndefined();
  writeFileSync(f.path, "expected\n");
  const proof = await observe!();
  expect(proof).toMatchObject({ kind: "local_workspace_write_observation_v1",
    expectedContentDigest: hash("expected\n"), observedContentDigest: hash("expected\n"), byteLength: 9,
    targetFingerprint: f.input.targetFingerprint, workspacePathDigest: f.input.attestation.workspacePathDigest });
  expect(JSON.stringify(proof)).not.toContain(f.root);
  expect(JSON.stringify(proof)).not.toContain("expected\\n");
});

it("refuses unsupported edits, extra instructions and oversized content", async () => {
  const f = fixture();
  for (const rawInput of [{ file_path: f.path, old_string: "a", new_string: "b" },
    { ...f.input.rawInput, command: "malicious" }, { ...f.input.rawInput, content: "x".repeat(2_000_001) }]) {
    expect(await prepareLocalWriteObservation({ ...f.input, rawInput })).toBeUndefined();
  }
  expect(await prepareLocalWriteObservation({ ...f.input, operation: "execute" })).toBeUndefined();
});

it("resolves relative writes from the exact session cwd while retaining the Attempt root", async () => {
  const f = fixture(); const cwd = join(f.root, "src"); mkdirSync(cwd);
  const observe = await prepareLocalWriteObservation({ ...f.input, sessionCwd: cwd,
    rawInput: { path: "result.txt", content: "expected\n" } });
  writeFileSync(f.path, "expected\n"); expect(await observe!()).toBeUndefined();
  writeFileSync(join(cwd, "result.txt"), "expected\n");
  expect(await observe!()).toMatchObject({ filePathDigest: hash(join(cwd, "result.txt")) });
});

it("refuses outside targets, symlink replacement and hard links", async () => {
  const f = fixture(); const other = fixture(); writeFileSync(other.path, "expected\n");
  expect(await prepareLocalWriteObservation({ ...f.input, rawInput: { ...f.input.rawInput, file_path: other.path } })).toBeUndefined();
  const observe = await prepareLocalWriteObservation(f.input);
  symlinkSync(other.path, f.path); expect(await observe!()).toBeUndefined();
  expect(await prepareLocalWriteObservation(f.input)).toBeUndefined();
  rmSync(f.path); linkSync(other.path, f.path);
  expect(await observe!()).toBeUndefined();
  expect(await prepareLocalWriteObservation(f.input)).toBeUndefined();
});
