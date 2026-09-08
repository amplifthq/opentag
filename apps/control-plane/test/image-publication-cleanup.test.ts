import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const workflowPath = fileURLToPath(new URL("../../../.github/workflows/control-plane-image.yml", import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const fixture = async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "opentag-cleanup-test-"));
  directories.push(sandbox);
  // Even a broken guard must keep the traversal probe inside disposable state.
  const root = join(sandbox, "runner");
  await mkdir(root, { mode: 0o700 });
  const target = await mkdtemp(join(root, "opentag-ghcr."));
  await writeFile(join(target, "config.json"), '{"auths":{"ghcr.io":{"auth":"test-only"}}}', { mode: 0o600 });
  return { root, target };
};

async function runCleanup(root: string, target: string | undefined, scenario = "success") {
  const workflow = await readFile(workflowPath, "utf8");
  const match = workflow.match(/      - name: Remove registry credentials\n        if: always\(\)\n        run: \|\n((?:          [^\n]*\n?)*)/u);
  expect(match, "the test must execute the actual always-run cleanup step").not.toBeNull();
  const script = match![1]!.replace(/^          /gmu, "");
  const env = { ...process.env, RUNNER_TEMP: root,
    OPENTAG_GHCR_DOCKER_CONFIG: target ?? "", OPENTAG_TEST_LOGOUT_SCENARIO: scenario };
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `
docker() {
  case "$OPENTAG_TEST_LOGOUT_SCENARIO" in
    failure) return 7 ;;
    INT|TERM) kill -s "$OPENTAG_TEST_LOGOUT_SCENARIO" "$$" ;;
  esac
}
${script}`], { env, encoding: "utf8", timeout: 3_000 });
}

describe("publication credential cleanup", () => {
  it.each(["success", "failure", "INT", "TERM"])(
    "removes credential files after logout %s", async (scenario) => {
      const { root, target } = await fixture();
      const result = await runCleanup(root, target, scenario);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(scenario === "INT" ? 130 : scenario === "TERM" ? 143 : 0);
      await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(root)).isDirectory()).toBe(true);
      expect(`${result.stdout}${result.stderr}`).not.toContain("test-only");
    },
  );

  it("accepts missing configuration and already-removed temporary directories", async () => {
    const { root, target } = await fixture();
    expect((await runCleanup(root, undefined)).status).toBe(0);
    expect((await stat(target)).isDirectory()).toBe(true);
    await rm(target, { recursive: true });
    expect((await runCleanup(root, target)).status).toBe(0);
  });

  it("refuses the runner root, unrelated paths, traversal and symlink targets", async () => {
    const first = await fixture();
    const outside = await fixture();
    const linked = join(first.root, "opentag-ghcr.linked");
    await symlink(outside.target, linked);
    const nested = join(first.target, "opentag-ghcr.nested");
    await mkdir(nested);
    for (const target of [first.root, outside.target, resolve(first.root, ".."), linked, nested]) {
      const result = await runCleanup(first.root, target);
      expect(result.status).not.toBe(0);
      expect(result.error).toBeUndefined();
      expect(await readFile(join(outside.target, "config.json"), "utf8")).toContain("test-only");
      expect(await readFile(join(first.target, "config.json"), "utf8")).toContain("test-only");
    }
  });
});
