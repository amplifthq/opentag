import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { containerControlPlaneReady, prepareContainerEnvironment,
  startContainerRole, waitForContainerDependency } from "../src/container.js";

const releaseSha = "a".repeat(40);
const environment = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_test",
  OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Container test",
  OPENTAG_BOOTSTRAP_PAIRING_TOKEN: "test-pairing-token-only",
  OPENTAG_FENCING_TOKEN_SECRET: "f".repeat(32),
  OPENTAG_LOGIN_THROTTLE_SECRET: "t".repeat(32),
  OPENTAG_ENVIRONMENT: "staging",
  OPENTAG_PUBLIC_URL: "https://relay.example.test",
  OPENTAG_RELEASE_SHA: releaseSha,
  OPENTAG_RELAY_CONTENT_KEY_VERSION: "v1",
  OPENTAG_CONTAINER_RELAY_CONTENT_KEK: "ab".repeat(32),
  OPENTAG_CONTAINER_SLACK_SIGNING_SECRET: "test-signing-secret-only",
  OPENTAG_CONTAINER_SLACK_BOT_TOKEN: "test-bot-token-only",
  OPENTAG_BOOTSTRAP_ADMIN_EMAIL: "owner@example.test",
  OPENTAG_BOOTSTRAP_ADMIN_NAME: "Test Owner",
  OPENTAG_BOOTSTRAP_ADMIN_PASSWORD: "test-owner-password-only",
  OPENTAG_SLACK_INSTALLATION_ID: "slack_primary",
  OPENTAG_SLACK_BINDING_ID: "slack_binding",
  OPENTAG_SLACK_ROUTE_IDENTITY: "route_identity_test_only",
  OPENTAG_SLACK_PROJECT_TARGET_ID: "github_primary",
  OPENTAG_SLACK_TEAM_ID: "T_TEST",
  OPENTAG_SLACK_APP_ID: "A_TEST",
  OPENTAG_SLACK_CHANNEL_ID: "C_TEST",
  OPENTAG_SLACK_BOT_USER_ID: "U_BOT",
  OPENTAG_SLACK_MEMBER_USER_IDS: "U_OWNER",
});

describe("container secret custody", () => {
  const directories: string[] = [];
  const directory = async () => {
    const path = await mkdtemp(join(tmpdir(), "opentag-container-test-"));
    directories.push(path);
    return path;
  };
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("materializes private bounded files and consumes platform secret variables", async () => {
    const root = await directory();
    const input = { ...environment(), PORT: "8123" };
    const env = await prepareContainerEnvironment(input, root);
    expect(env.OPENTAG_PORT).toBe("8123");
    expect(env.OPENTAG_RELAY_CONTENT_KEK_FILE).toBe(join(root, "opentag_relay_content_kek"));
    expect(env.OPENTAG_SLACK_BOT_TOKEN_REF).toBe(`file:${root}/opentag_slack_bot_token`);
    for (const [key, name] of [
      ["OPENTAG_CONTAINER_RELAY_CONTENT_KEK", "opentag_relay_content_kek"],
      ["OPENTAG_CONTAINER_SLACK_SIGNING_SECRET", "opentag_slack_signing_secret"],
      ["OPENTAG_CONTAINER_SLACK_BOT_TOKEN", "opentag_slack_bot_token"],
    ]) {
      expect(input[key!]).toBeUndefined();
      expect(env[key!]).toBeUndefined();
      expect(await readFile(join(root, name!), "utf8")).toBe(environment()[key!]);
      expect((await lstat(join(root, name!))).mode & 0o777).toBe(0o400);
    }
    expect(env.OPENTAG_RELAY_CONTENT_KEK).toBeUndefined();
  });

  it("reuses only exact existing files without rotating or overwriting secrets", async () => {
    const root = await directory();
    await prepareContainerEnvironment(environment(), root);
    await expect(prepareContainerEnvironment(environment(), root)).resolves.toBeDefined();
    await expect(prepareContainerEnvironment({ ...environment(),
      OPENTAG_CONTAINER_RELAY_CONTENT_KEK: "cd".repeat(32) }, root))
      .rejects.toThrow("container_secret_file_conflict");
    expect(await readFile(join(root, "opentag_relay_content_kek"), "utf8"))
      .toBe("ab".repeat(32));
  });

  it.each(["", "short", "replace-with-a-secret", "ab".repeat(32) + "\n"])(
    "rejects an invalid KEK and removes all injected values", async (key) => {
      const root = await directory();
      const input = { ...environment(), OPENTAG_CONTAINER_RELAY_CONTENT_KEK: key };
      await expect(prepareContainerEnvironment(input, root)).rejects.toThrow("container_secrets_invalid");
      expect(input.OPENTAG_CONTAINER_RELAY_CONTENT_KEK).toBeUndefined();
      expect(input.OPENTAG_CONTAINER_SLACK_BOT_TOKEN).toBeUndefined();
    },
  );

  it("rejects credential whitespace, placeholders, invalid bytes and oversized values", async () => {
    for (const value of ["", " token", "token\n", "token\0value", "replace-with-token", "x".repeat(4097), "😀".repeat(2000)]) {
      await expect(prepareContainerEnvironment({ ...environment(),
        OPENTAG_CONTAINER_SLACK_BOT_TOKEN: value }, await directory()))
        .rejects.toThrow("container_secrets_invalid");
    }
  });

  it("does not relax existing config and secret-reference constraints", async () => {
    const root = await directory();
    await expect(prepareContainerEnvironment({ ...environment(), OPENTAG_PUBLIC_URL: "http://bad.test" }, root))
      .rejects.toThrow("configuration_invalid");
    await expect(prepareContainerEnvironment({ ...environment(),
      OPENTAG_RELAY_CONTENT_KEK: "not-permitted" }, root)).rejects.toThrow("configuration_invalid");
    await expect(prepareContainerEnvironment({ ...environment(),
      OPENTAG_SLACK_BOT_TOKEN_REF: "env:OTHER_TOKEN" }, root))
      .rejects.toThrow("container_secret_reference_conflict");
  });

  it("rejects unsafe directories and symlinks without modifying their targets", async () => {
    const root = await directory();
    const unsafe = join(root, "unsafe");
    await symlink(root, unsafe);
    await expect(prepareContainerEnvironment(environment(), unsafe))
      .rejects.toThrow("container_secret_directory_unsafe");
    await chmod(root, 0o755);
    await expect(prepareContainerEnvironment(environment(), root))
      .rejects.toThrow("container_secret_directory_unsafe");
    await chmod(root, 0o700);
    const target = join(root, "outside");
    await writeFile(target, "untouched", { mode: 0o400 });
    await symlink(target, join(root, "opentag_relay_content_kek"));
    await expect(prepareContainerEnvironment(environment(), root)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("untouched");
  });
});

describe("container startup ordering", () => {
  const startup = (role: "serve" | "jobs", env = environment()) => {
    const commands: string[] = [];
    const runCommand = vi.fn(async (input?: { argv?: readonly string[]; env?: NodeJS.ProcessEnv }) => {
      commands.push(input?.argv?.[0] ?? "missing");
    });
    return { commands, input: { role, env, signal: new AbortController().signal, runCommand,
      waitForDatabase: async () => { commands.push("database-ready"); },
      waitForControlPlane: async () => { commands.push("control-plane-ready"); },
    } };
  };

  it("starts HTTP only after database, migrations and exact-replay bootstraps", async () => {
    const { commands, input } = startup("serve");
    await startContainerRole(input);
    expect(commands).toEqual(["database-ready", "migrate", "bootstrap-admin", "bootstrap-slack", "serve"]);
    expect(input.env.OPENTAG_BOOTSTRAP_ADMIN_PASSWORD).toBeUndefined();
  });

  it.each(["migrate", "bootstrap-admin", "bootstrap-slack"])(
    "never retries a failed %s or starts the next phase", async (failedCommand) => {
      const { input } = startup("serve");
      input.runCommand.mockImplementation(async (command) => {
        if (command?.argv?.[0] === failedCommand) throw new Error("private database details");
      });
      await expect(startContainerRole(input))
        .rejects.toThrow(`container_${failedCommand.replaceAll("-", "_")}_failed`);
      const calls = input.runCommand.mock.calls.map(([call]) => call?.argv?.[0]);
      expect(calls.at(-1)).toBe(failedCommand);
      expect(calls.filter((command) => command === failedCommand)).toHaveLength(1);
      expect(calls).not.toContain("serve");
    },
  );

  it("validates bootstrap configuration before any database mutation", async () => {
    const { commands, input } = startup("serve", { ...environment(), OPENTAG_SLACK_CHANNEL_ID: "" });
    await expect(startContainerRole(input)).rejects.toThrow();
    expect(commands).toEqual([]);
  });

  it("keeps jobs behind the ready relay and never bootstraps from the worker", async () => {
    const { commands, input } = startup("jobs");
    await startContainerRole(input);
    expect(commands).toEqual(["control-plane-ready", "jobs"]);
  });

  it("bounds read-only dependency retries and honors cancellation", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await waitForContainerDependency(probe, { signal: new AbortController().signal, pollMs: 1 });
    expect(probe).toHaveBeenCalledTimes(2);
    await expect(waitForContainerDependency(async () => false,
      { signal: AbortSignal.timeout(10), pollMs: 1 })).rejects.toThrow();
    const { input } = startup("jobs");
    input.signal = AbortSignal.abort();
    await expect(startContainerRole(input)).rejects.toThrow();
    expect(input.runCommand).not.toHaveBeenCalled();
  });

  it("cancels a hung initialization command without starting a later phase", async () => {
    const { input } = startup("serve");
    const controller = new AbortController();
    input.signal = controller.signal;
    input.runCommand.mockImplementation(async () => {
      controller.abort();
      await new Promise(() => {});
    });
    await expect(startContainerRole(input)).rejects.toThrow("container_migrate_failed");
    expect(input.runCommand).toHaveBeenCalledTimes(1);
  });
});

describe("jobs relay observation", () => {
  const capabilities = (sha = releaseSha) => ({
    schemaVersion: 1, protocolVersion: "1.0", registryVersion: "opentag.control.capabilities/v1",
    capabilities: ["relay.readiness.v1"], minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
    deployment: { environment: "staging", releaseSha: sha },
    artifact: { packageName: "@opentag/control-plane", packageVersion: "0.0.0" },
  });
  it("accepts readiness only from the same release and performs GETs without credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => Response.json(
      new URL(String(url)).pathname === "/readyz" ? { status: "ready" } : capabilities()));
    await expect(containerControlPlaneReady({ origin: "http://control-plane.railway.internal:3000",
      releaseSha, signal: new AbortController().signal, fetchImpl })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchImpl.mock.calls) {
      expect(options?.method).toBeUndefined();
      expect(options?.headers).toBeUndefined();
      expect(options?.redirect).toBe("error");
    }
  });
  it.each(["not-ready", "old-release", "malformed", "network-failure"])(
    "keeps jobs waiting after %s", async (failure) => {
      const fetchImpl = vi.fn<typeof fetch>(async (url) => {
        if (failure === "network-failure") throw new Error("private transport details");
        if (failure === "not-ready") return new Response("not-ready", { status: 503 });
        if (new URL(String(url)).pathname === "/readyz") return Response.json({ status: "ready" });
        return Response.json(failure === "malformed" ? {} : capabilities("b".repeat(40)));
      });
      await expect(containerControlPlaneReady({ origin: "http://relay.internal:3000", releaseSha,
        signal: new AbortController().signal, fetchImpl })).resolves.toBe(false);
    },
  );
  it("rejects credentials, paths and unsupported schemes before making a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const origin of ["http://user:password@relay", "http://relay/path", "file:///tmp/private"]) {
      await expect(containerControlPlaneReady({ origin, releaseSha,
        signal: new AbortController().signal, fetchImpl })).rejects.toThrow("container_control_plane_url_invalid");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
