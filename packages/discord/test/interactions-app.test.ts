import { generateKeyPairSync, sign } from "node:crypto";
import type { OpenTagEvent } from "@opentag/core";
import { describe, expect, it, vi } from "vitest";
import { createDiscordInteractionsApp, type DiscordInteractionsAppInput, type DiscordThreadActionInput } from "../src/interactions-app.js";
import type { DiscordChannelBinding } from "../src/normalize.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_HEX = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
const TIMESTAMP = "1719900000";

function signed(body: string): { headers: Record<string, string> } {
  const signature = sign(null, Buffer.from(TIMESTAMP + body), privateKey).toString("hex");
  return {
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": TIMESTAMP
    }
  };
}

const binding: DiscordChannelBinding = {
  applicationId: "app_1",
  channelId: "chan_1",
  repoProvider: "github",
  owner: "acme",
  repo: "demo"
};

function makeApp(overrides: Partial<DiscordInteractionsAppInput> = {}) {
  const createRun = vi.fn(async (_event: OpenTagEvent) => ({ runId: "run_1" }));
  const submitThreadAction = vi.fn(async (_action: DiscordThreadActionInput) => ({ outcome: "applied" }));
  const resolveChannelBinding = vi.fn(
    async (_input: { applicationId: string; channelId: string }): Promise<DiscordChannelBinding | null> => binding
  );
  const notifyChannel = vi.fn(async (_input: { channelId: string; content: string }) => {});
  const onBackgroundError = vi.fn((_error: unknown) => {});
  const app = createDiscordInteractionsApp({
    publicKey: PUBLIC_KEY_HEX,
    resolveChannelBinding,
    createRun,
    submitThreadAction,
    notifyChannel,
    onBackgroundError,
    now: () => "2026-07-02T00:00:00.000Z",
    ...overrides
  });
  return { app, createRun, submitThreadAction, resolveChannelBinding, notifyChannel, onBackgroundError };
}

function commandBody(options: Array<{ name: string; value: string }>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 2,
    id: "int_1",
    application_id: "app_1",
    channel_id: "chan_1",
    guild_id: "guild_1",
    member: { user: { id: "user_1", username: "alice" } },
    data: { name: "opentag", options },
    ...extra
  });
}

describe("Discord interactions app", () => {
  it("responds to PING with PONG and does not create a run", async () => {
    const { app, createRun } = makeApp();
    const body = JSON.stringify({ type: 1 });
    const response = await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
    expect(createRun).not.toHaveBeenCalled();
  });

  it("rejects a request with no signature headers", async () => {
    const { app, createRun } = makeApp();
    const body = JSON.stringify({ type: 1 });
    const response = await app.request("/discord/interactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    expect(response.status).toBe(401);
    expect(createRun).not.toHaveBeenCalled();
  });

  it("rejects a request with an invalid signature", async () => {
    const { app, createRun } = makeApp();
    const body = commandBody([{ name: "prompt", value: "fix this" }]);
    const response = await app.request("/discord/interactions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature-ed25519": "00".repeat(64), "x-signature-timestamp": TIMESTAMP },
      body
    });
    expect(response.status).toBe(401);
    expect(createRun).not.toHaveBeenCalled();
  });

  it("acknowledges immediately with suppressed mentions and creates the run in the background", async () => {
    const { app, createRun } = makeApp();
    const body = commandBody([
      { name: "prompt", value: "fix the bug" },
      { name: "executor", value: "codex" }
    ]);
    const response = await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { type: number; data: { content: string; allowed_mentions?: unknown } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain("Received");
    expect(json.data.allowed_mentions).toEqual({ parse: [] });

    await vi.waitFor(() => expect(createRun).toHaveBeenCalledTimes(1));
    expect(createRun.mock.calls[0]![0]).toMatchObject({
      source: "discord",
      target: { executorHint: "codex" },
      callback: { provider: "discord" },
      metadata: { repoProvider: "github", owner: "acme", repo: "demo" }
    });
  });

  it("routes apply commands to submitThreadAction without creating a run", async () => {
    const { app, createRun, submitThreadAction } = makeApp();
    const body = commandBody([{ name: "prompt", value: "apply 1" }]);
    const response = await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(submitThreadAction).toHaveBeenCalledTimes(1));
    expect(createRun).not.toHaveBeenCalled();
    expect(submitThreadAction.mock.calls[0]![0]).toMatchObject({
      id: expect.stringMatching(/^approval_discord_int_1_[0-9a-f]{12}$/),
      actor: { provider: "discord", handle: "alice" },
      callback: { provider: "discord", threadKey: "guild_1|chan_1|int_1" }
    });
  });

  it("yields the same action id when the same body is delivered twice", async () => {
    const { app, submitThreadAction } = makeApp();
    const body = commandBody([{ name: "prompt", value: "apply 1" }]);
    await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
    await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
    await vi.waitFor(() => expect(submitThreadAction).toHaveBeenCalledTimes(2));
    expect(submitThreadAction.mock.calls[0]![0].id).toBe(submitThreadAction.mock.calls[1]![0].id);
  });

  it("notifies the channel instead of creating a run when the channel is not bound", async () => {
    const { app, createRun, notifyChannel } = makeApp({ resolveChannelBinding: async () => null });
    const body = commandBody([{ name: "prompt", value: "fix this" }]);
    const response = await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(notifyChannel).toHaveBeenCalledTimes(1));
    expect(notifyChannel.mock.calls[0]![0]).toMatchObject({
      channelId: "chan_1",
      content: expect.stringContaining("not bound")
    });
    expect(createRun).not.toHaveBeenCalled();
  });

  it("acknowledges, reports, and notifies the channel when createRun rejects", async () => {
    const { app, onBackgroundError, notifyChannel } = makeApp({
      createRun: async () => {
        throw new Error("dispatcher down");
      }
    });
    const body = commandBody([{ name: "prompt", value: "fix the bug" }]);
    const response = await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledTimes(1));
    expect((onBackgroundError.mock.calls[0]![0] as Error).message).toBe("dispatcher down");
    await vi.waitFor(() => expect(notifyChannel).toHaveBeenCalledTimes(1));
    expect(notifyChannel.mock.calls[0]![0]).toMatchObject({
      channelId: "chan_1",
      content: expect.stringContaining("couldn't start")
    });
  });

  it("still sends a failure notice when a custom background error reporter throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { app, notifyChannel } = makeApp({
        createRun: async () => {
          throw new Error("dispatcher down");
        },
        onBackgroundError: () => {
          throw new Error("reporter down");
        }
      });
      const body = commandBody([{ name: "prompt", value: "fix the bug" }]);
      const response = await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(notifyChannel).toHaveBeenCalledTimes(1));
      expect(notifyChannel.mock.calls[0]![0]).toMatchObject({
        channelId: "chan_1",
        content: expect.stringContaining("couldn't start")
      });
      expect(consoleError).toHaveBeenCalledWith("Discord interaction background error reporter failed:", expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("acknowledges, reports, and notifies the channel when submitThreadAction rejects", async () => {
    const { app, onBackgroundError, notifyChannel } = makeApp({
      submitThreadAction: async () => {
        throw new Error("dispatcher down");
      }
    });
    const body = commandBody([{ name: "prompt", value: "apply 1" }]);
    const response = await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(notifyChannel).toHaveBeenCalledTimes(1));
    expect(notifyChannel.mock.calls[0]![0]).toMatchObject({
      content: expect.stringContaining("couldn't be processed")
    });
  });

  it("returns a message for an apply command when submitThreadAction is not configured", async () => {
    const { app, createRun } = makeApp({ submitThreadAction: undefined });
    const body = commandBody([{ name: "prompt", value: "apply 1" }]);
    const response = await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { content: expect.stringContaining("not supported") } });
    expect(createRun).not.toHaveBeenCalled();
  });

  it("returns prompt guidance for whitespace-only prompts without creating a run", async () => {
    const { app, createRun, resolveChannelBinding } = makeApp();
    const body = commandBody([
      { name: "prompt", value: "   " },
      { name: "executor", value: "codex" }
    ]);
    const response = await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        content: expect.stringContaining("Please include a prompt"),
        allowed_mentions: { parse: [] }
      }
    });
    expect(resolveChannelBinding).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it("returns 422 for a command payload missing the prompt option", async () => {
    const { app, createRun } = makeApp();
    const body = commandBody([]);
    const response = await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
    expect(response.status).toBe(422);
    expect(createRun).not.toHaveBeenCalled();
  });

  it("returns 400 for a well-signed but non-JSON body", async () => {
    const { app } = makeApp();
    const body = "not json";
    const response = await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
    expect(response.status).toBe(400);
  });

  it("returns 413 when content-length declares an oversized payload", async () => {
    const { app, createRun } = makeApp();
    const body = JSON.stringify({ type: 1 });
    const response = await app.request("/discord/interactions", {
      method: "POST",
      headers: { ...signed(body).headers, "content-length": "1048576" },
      body
    });
    expect(response.status).toBe(413);
    expect(createRun).not.toHaveBeenCalled();
  });

  it("returns 413 when the actual body exceeds the cap despite no declared content-length", async () => {
    const { app, createRun } = makeApp();
    const body = commandBody([{ name: "prompt", value: "x".repeat(1_048_600) }]);
    const response = await app.request("/discord/interactions", { method: "POST", body, ...signed(body) });
    expect(response.status).toBe(413);
    expect(createRun).not.toHaveBeenCalled();
  });
});
