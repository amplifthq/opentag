import { describe, expect, it, vi } from "vitest";
import { createProviderDeliveryWorker } from "../src/modules/provider-delivery/worker.js";

describe("provider delivery worker", () => {
  it("preloads canonical apps and finalizes stranded begins once before claims resume", async () => {
    const calls: string[] = [];
    const kernel = { recoverStrandedBegun: vi.fn(async () => { calls.push("recover"); return 2; }),
      deliverNext: vi.fn(async () => { calls.push("deliver"); return null; }) };
    const worker = createProviderDeliveryWorker({ kernel,
      preloadSourceApps: async () => { calls.push("preload"); },
      clock: { now: () => new Date("2026-08-30T00:00:00.000Z") } });
    await expect(worker.processNext()).resolves.toEqual({ kind: "empty", recovered: 2 });
    await expect(worker.processNext()).resolves.toEqual({ kind: "empty", recovered: 0 });
    expect(calls).toEqual(["preload", "recover", "deliver", "preload", "deliver"]);
  });
});
