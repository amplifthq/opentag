import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { LocalWorkspaceWriteObservationV1Schema, type LocalWorkspaceWriteObservationV1 } from "@opentag/core";
import type { AttemptWorkspaceAttestation } from "./git.js";

const hash = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const MAX_BYTES = 2_000_000;

async function containedPath(workspace: string, requested: string) {
  const path = resolve(workspace, requested); let parent = dirname(path);
  const missing: string[] = [];
  let realParent: string;
  for (;;) {
    try { realParent = await realpath(parent); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(basename(parent)); parent = dirname(parent);
    }
  }
  const canonical = resolve(realParent, ...missing, basename(path));
  const local = relative(workspace, canonical);
  if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)
    || local.split(sep).some(part => [".git", ".codex", ".claude", ".omx"].includes(part.toLowerCase()))) {
    throw new Error("local_write_target_outside_workspace");
  }
  return canonical;
}

/** Only a bounded full-file write has enough request data for exact readback. */
export async function prepareLocalWriteObservation(input: {
  rawInput: unknown; operation: string; targetFingerprint: string | undefined;
  workspacePath: string; sessionCwd?: string; attestation: AttemptWorkspaceAttestation;
}): Promise<(() => Promise<LocalWorkspaceWriteObservationV1 | undefined>) | undefined> {
  if (!["write", "edit"].includes(input.operation) || !input.targetFingerprint
    || !input.rawInput || typeof input.rawInput !== "object" || Array.isArray(input.rawInput)) return undefined;
  const raw = input.rawInput as Record<string, unknown>;
  const keys = Object.keys(raw);
  const requested = raw.file_path ?? raw.path;
  if (keys.some(key => !["file_path", "path", "content"].includes(key))
    || (raw.file_path !== undefined && raw.path !== undefined)
    || typeof requested !== "string" || typeof raw.content !== "string"
    || Buffer.byteLength(raw.content) > MAX_BYTES) return undefined;
  try {
    const workspace = await realpath(input.workspacePath);
    if (hash(workspace) !== input.attestation.workspacePathDigest) return undefined;
    const sessionCwd = input.sessionCwd ? await realpath(input.sessionCwd) : workspace;
    const requestedPath = resolve(sessionCwd, requested);
    const path = await containedPath(workspace, requestedPath);
    const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null; throw error;
    });
    if (before && (!before.isFile() || before.nlink !== 1)) return undefined;
    const expectedContentDigest = hash(Buffer.from(raw.content));
    const byteLength = Buffer.byteLength(raw.content);
    return async () => {
      try {
        if (await realpath(input.workspacePath) !== workspace
          || await containedPath(workspace, requestedPath) !== path) return undefined;
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.size !== byteLength) return undefined;
          const bytes = Buffer.alloc(byteLength + 1); let length = 0;
          while (length < bytes.length) {
            const read = await handle.read(bytes, length, bytes.length - length, length);
            if (!read.bytesRead) break; length += read.bytesRead;
          }
          const after = await handle.stat();
          const currentFile = await lstat(path);
          if (length !== byteLength || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
            || after.nlink !== 1 || !currentFile.isFile() || currentFile.nlink !== 1
            || currentFile.ino !== stat.ino || currentFile.dev !== stat.dev) return undefined;
          const parsed = LocalWorkspaceWriteObservationV1Schema.safeParse({
            kind: "local_workspace_write_observation_v1", workspaceId: input.attestation.workspaceId,
            workspacePathDigest: input.attestation.workspacePathDigest,
            worktreeIdentityDigest: input.attestation.worktreeIdentityDigest,
            targetFingerprint: input.targetFingerprint, filePathDigest: hash(path),
            expectedContentDigest, observedContentDigest: hash(bytes.subarray(0, length)), byteLength,
          });
          return parsed.success ? parsed.data : undefined;
        } finally { await handle.close(); }
      } catch { return undefined; }
    };
  } catch { return undefined; }
}
