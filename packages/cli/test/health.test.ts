import { describe, expect, it, vi } from "vitest";
import { probeRelayHealth } from "../src/health.js";

describe("paired Control Plane health", () => {
  it("accepts only a successful health response", async () => {
    await expect(probeRelayHealth({
      relayUrl: "https://control.example",
      fetchImpl: vi.fn(async () => Response.json({ ok: true })),
      timeoutMs: 10,
    })).resolves.toBe(true);
    await expect(probeRelayHealth({
      relayUrl: "https://control.example",
      fetchImpl: vi.fn(async () => Response.json({ ok: false }, { status: 503 })),
      timeoutMs: 10,
    })).resolves.toBe(false);
  });

  it("bounds a stalled health request", async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as unknown as typeof fetch;
    await expect(probeRelayHealth({
      relayUrl: "https://control.example",
      fetchImpl,
      timeoutMs: 1,
    })).resolves.toBe(false);
  });
});
