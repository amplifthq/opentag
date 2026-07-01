import { describe, expect, it } from "vitest";
import { dispatcherRuntimeInputFromEnv, startDispatcher, type LocalDispatcherRuntimeInput } from "../src/dispatcher.js";

async function withDispatcherServer(
  input: Omit<LocalDispatcherRuntimeInput, "port" | "databasePath">,
  test: (baseUrl: string) => Promise<void>
) {
  const handle = startDispatcher({ port: 0, databasePath: ":memory:", ...input });
  const address = handle.server.address();
  if (!address || typeof address === "string") {
    await handle.close();
    throw new Error("Expected dispatcher server to listen on a TCP port.");
  }
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await handle.close();
  }
}

describe("local dispatcher runtime", () => {
  it("parses per-agent Slack bot tokens from env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_SLACK_BOT_TOKENS_JSON: JSON.stringify({ reviewer: "xoxb-reviewer" })
      }).slackBotTokensByAgentId
    ).toEqual({ reviewer: "xoxb-reviewer" });
  });

  it("rejects non-string per-agent bot tokens", () => {
    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_SLACK_BOT_TOKENS_JSON: JSON.stringify({ reviewer: 123 })
      })
    ).toThrow("Token for agent reviewer must be a non-empty string");
  });

  it("can split GitHub callback and apply tokens from env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_GITHUB_TOKEN: "ghp_callback_and_apply",
        OPENTAG_GITHUB_CALLBACK_TOKEN: "ghp_callback",
        OPENTAG_GITHUB_APPLY_TOKEN: "ghp_apply"
      })
    ).toMatchObject({
      githubToken: "ghp_callback_and_apply",
      githubCallbackToken: "ghp_callback",
      githubApplyToken: "ghp_apply"
    });
  });

  it("can split pairing and runner dispatcher tokens from env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_PAIRING_TOKEN: "pairing_token",
        OPENTAG_RUNNER_TOKEN: "runner_token",
        OPENTAG_RUNNER_TOKENS_JSON: JSON.stringify(["runner_old"]),
        OPENTAG_REVOKED_RUNNER_TOKEN_FINGERPRINTS_JSON: JSON.stringify(["abc123"])
      })
    ).toMatchObject({
      pairingToken: "pairing_token",
      runnerToken: "runner_token",
      runnerTokens: ["runner_old"],
      revokedRunnerTokenFingerprints: ["abc123"]
    });
  });

  it("rejects invalid runner token rotation lists", () => {
    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_RUNNER_TOKENS_JSON: JSON.stringify(["runner_old", ""])
      })
    ).toThrow("Entry 1 must be a non-empty string");
  });

  it("can disable GitHub direct apply while leaving callback token configured", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_GITHUB_TOKEN: "ghp_callback",
        OPENTAG_GITHUB_APPLY_DISABLED: "true"
      })
    ).toMatchObject({
      githubToken: "ghp_callback",
      githubApplyToken: null
    });
  });

  it("parses dispatcher request body and rate-limit hardening env", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_MAX_REQUEST_BODY_BYTES: "4096",
        OPENTAG_RATE_LIMIT_WINDOW_MS: "60000",
        OPENTAG_RATE_LIMIT_MAX_REQUESTS: "120"
      })
    ).toMatchObject({
      maxRequestBodyBytes: 4096,
      rateLimit: {
        windowMs: 60000,
        maxRequests: 120
      }
    });
  });

  it("rejects partial or invalid dispatcher hardening env", () => {
    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_MAX_REQUEST_BODY_BYTES: "0"
      })
    ).toThrow("OPENTAG_MAX_REQUEST_BODY_BYTES must be a positive integer");

    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_RATE_LIMIT_WINDOW_MS: "60000"
      })
    ).toThrow("OPENTAG_RATE_LIMIT_WINDOW_MS and OPENTAG_RATE_LIMIT_MAX_REQUESTS must be configured together");

    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_RATE_LIMIT_DISABLED: "yes"
      })
    ).toThrow("OPENTAG_RATE_LIMIT_DISABLED must be either true or false");
  });

  it("makes dispatcher rate limiting explicitly disableable", () => {
    expect(
      dispatcherRuntimeInputFromEnv({
        OPENTAG_RATE_LIMIT_DISABLED: "true"
      })
    ).toMatchObject({ rateLimit: false });

    expect(() =>
      dispatcherRuntimeInputFromEnv({
        OPENTAG_RATE_LIMIT_DISABLED: "true",
        OPENTAG_RATE_LIMIT_WINDOW_MS: "60000",
        OPENTAG_RATE_LIMIT_MAX_REQUESTS: "120"
      })
    ).toThrow("OPENTAG_RATE_LIMIT_DISABLED cannot be true");
  });

  it("wires configured request body limits into the started dispatcher", async () => {
    await withDispatcherServer({ maxRequestBodyBytes: 24 }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/runners`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "request_body_too_large", maxBytes: 24 });
    });
  });

  it("wires configured rate limits into the started dispatcher", async () => {
    await withDispatcherServer(
      {
        rateLimit: {
          windowMs: 1_000,
          maxRequests: 1,
          now: () => 10_000
        }
      },
      async (baseUrl) => {
        const first = await fetch(`${baseUrl}/v1/runners/runner_1`, {
          headers: { authorization: "Bearer token_a" }
        });
        expect(first.status).toBe(404);

        const second = await fetch(`${baseUrl}/v1/runners/runner_1`, {
          headers: { authorization: "Bearer token_a" }
        });
        expect(second.status).toBe(429);
        await expect(second.json()).resolves.toEqual({
          error: "rate_limited",
          retryAfterMs: 1_000,
          maxRequests: 1,
          windowMs: 1_000
        });
      }
    );
  });
});
