import { realpathSync } from "node:fs";
import { formatProjectTargetRef, projectTargetRefFromLocalPath } from "../../packages/core/src/index.ts";

const localPath = process.argv[2];
if (!localPath) {
  throw new Error("Usage: print-local-project-target-ref <local-path>");
}

const canonicalPath = realpathSync.native(localPath);
process.stdout.write(formatProjectTargetRef(projectTargetRefFromLocalPath(canonicalPath)));
