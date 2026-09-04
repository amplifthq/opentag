import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnvironmentSlackSecretResolver } from "../src/index.js";

describe("production Slack secret references", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("preserves env references and reads only direct bounded files under the allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "opentag-slack-secrets-"));
    directories.push(root);
    const signingPath = join(root, "signing_secret");
    await writeFile(signingPath, "signing-secret-value\n", { mode: 0o400 });
    const resolver = createEnvironmentSlackSecretResolver(
      { LEGACY_SLACK_TOKEN: "legacy-token" },
      { fileRoot: root },
    );
    await expect(resolver.resolve("env:LEGACY_SLACK_TOKEN")).resolves.toBe("legacy-token");
    await expect(resolver.resolve(`file:${signingPath}`)).resolves.toBe("signing-secret-value");

    const outside = await mkdtemp(join(tmpdir(), "opentag-slack-outside-"));
    directories.push(outside);
    const outsidePath = join(outside, "secret");
    await writeFile(outsidePath, "outside-secret-value", { mode: 0o400 });
    await expect(resolver.resolve(`file:${outsidePath}`))
      .rejects.toThrow("slack_secret_reference_unsupported");

    const symlinkPath = join(root, "linked_secret");
    await symlink(signingPath, symlinkPath);
    await expect(resolver.resolve(`file:${symlinkPath}`))
      .rejects.toThrow("slack_secret_unavailable");
  });

  it("rejects missing, empty, malformed, and oversized secret files without leaking paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "opentag-slack-invalid-secrets-"));
    directories.push(root);
    const resolver = createEnvironmentSlackSecretResolver({}, { fileRoot: root });
    for (const [name, content] of [
      ["empty", ""],
      ["nul", "secret\0value"],
      ["oversized", "x".repeat(4097)],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, content, { mode: 0o400 });
      let message = "";
      try {
        await resolver.resolve(`file:${path}`);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("slack_secret_unavailable");
      expect(message).not.toContain(path);
    }
    await expect(resolver.resolve(`file:${join(root, "missing")}`))
      .rejects.toThrow("slack_secret_unavailable");
  });
});
