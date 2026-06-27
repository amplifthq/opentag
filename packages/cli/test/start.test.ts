import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSetupConfig } from "../src/setup.js";
import {
  bootstrapLocalDispatcher,
  dispatcherRuntimeInputFromCliConfig,
  larkIngressConfigFromCliConfig,
  waitForDispatcher
} from "../src/start.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function config() {
  return createSetupConfig({
    language: "en",
    platform: "lark",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    lark: {
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      botOpenId: "ou_bot",
      setupMethod: "scan",
      bindingMethod: "default_project"
    }
  });
}

function hangingFetch(): typeof fetch {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as unknown as typeof fetch;
}

describe("OpenTag CLI start wiring", () => {
  it("derives dispatcher input with the Lark callback sink credentials", () => {
    const built = config();
    const dispatcher = dispatcherRuntimeInputFromCliConfig(built);

    expect(dispatcher).toMatchObject({
      port: 3030,
      databasePath: built.state.databasePath,
      pairingToken: built.daemon.pairingToken,
      lark: {
        appId: "cli_test",
        appSecret: "secret_test",
        domain: "lark"
      }
    });
  });

  it("derives Lark ingress config with a default repo binding for one Project Target", () => {
    const built = config();
    const ingress = larkIngressConfigFromCliConfig(built);
    const repository = built.daemon.repositories[0]!;

    expect(ingress).toMatchObject({
      appId: "cli_test",
      appSecret: "secret_test",
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: built.daemon.pairingToken,
      agentId: "opentag",
      botOpenId: "ou_bot",
      defaultRepoBinding: {
        repoProvider: repository.provider,
        owner: repository.owner,
        repo: repository.repo
      }
    });
  });

  it("omits default Lark repo binding when setup chose bind later", () => {
    const built = config();
    built.platforms.lark!.defaultProjectBinding = false;

    expect(larkIngressConfigFromCliConfig(built).defaultRepoBinding).toBeUndefined();
  });

  it("bootstraps runner, Project Target, and channel bindings in dispatcher state", async () => {
    const built = config();
    built.daemon.channelBindings = [
      {
        provider: "lark",
        accountId: "tenant_1",
        conversationId: "chat_1",
        repoProvider: built.daemon.repositories[0]!.provider,
        owner: built.daemon.repositories[0]!.owner,
        repo: built.daemon.repositories[0]!.repo
      }
    ];
    const calls: string[] = [];

    await bootstrapLocalDispatcher(built, {
      async registerRunner(name) {
        calls.push(`runner:${name}`);
      },
      async bindRepository(binding) {
        calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
      },
      async bindChannel(binding) {
        calls.push(`channel:${binding.provider}:${binding.accountId}/${binding.conversationId}`);
      }
    });

    expect(calls).toEqual([
      "runner:runner_local",
      `repo:${built.daemon.repositories[0]!.provider}:${built.daemon.repositories[0]!.owner}/${built.daemon.repositories[0]!.repo}`,
      "channel:lark:tenant_1/chat_1"
    ]);
  });

  it("waits for dispatcher health instead of assuming the port is ready", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await expect(
      waitForDispatcher({
        dispatcherUrl: "http://localhost:3030",
        fetchImpl,
        attempts: 2,
        delayMs: 1
      })
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("times out each dispatcher health attempt", async () => {
    const fetchImpl = hangingFetch();

    await expect(
      waitForDispatcher({
        dispatcherUrl: "http://localhost:3030",
        fetchImpl,
        attempts: 1,
        delayMs: 1,
        timeoutMs: 5
      })
    ).rejects.toThrow("Dispatcher did not become healthy at http://localhost:3030/healthz.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
