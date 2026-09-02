import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCommand,
  preflight,
  runCommand,
  testFilesFromCommand
} from "./governance-matrix.mjs";

test("governance matrix passes arguments directly without shell interpretation", async () => {
  const literalArgument = "value with spaces; exit 23";
  const assertion = `if (process.argv[1] !== ${JSON.stringify(literalArgument)}) process.exit(2);`;

  const result = await runCommand({
    executable: process.execPath,
    args: ["--input-type=module", "-e", assertion, literalArgument]
  });

  assert.equal(result.exitCode, 0);
});

test("governance matrix derives preflight checks from structured arguments", () => {
  const command = {
    executable: process.execPath,
    args: ["pnpm", "vitest", "run", "missing/example.test.ts", "missing/other.spec.mjs"]
  };

  assert.deepEqual(testFilesFromCommand(command), [
    "missing/example.test.ts",
    "missing/other.spec.mjs"
  ]);
  assert.deepEqual(preflight({ command }).missing, [
    "file:missing/example.test.ts",
    "file:missing/other.spec.mjs"
  ]);
  assert.equal(
    formatCommand({ executable: "node", args: ["value with spaces"] }),
    'node "value with spaces"'
  );
  assert.deepEqual(preflight({
    command: { executable: "opentag-command-that-does-not-exist", args: [] }
  }).missing, ["command:opentag-command-that-does-not-exist"]);
});
