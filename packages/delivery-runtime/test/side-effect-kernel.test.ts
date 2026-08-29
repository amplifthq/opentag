import { describe, expect, it } from "vitest";
import type { DeliveryKernelRepository } from "../src/repository.js";

describe("DeliveryKernelRepository", () => {
  it("accepts synchronous and asynchronous repository implementations", async () => {
    const repository: DeliveryKernelRepository = {
      recordIntent: () => undefined, claimNext: async () => null, renewLease: () => null,
      getIntent: () => null, releaseUnusedClaim: () => false, markBegin: () => null,
      settleOrReadTerminal: async (input) => input, finalizeStrandedBegun: () => 0,
      findAcceptedExternalResource: () => ({ outcome: "none" }),
    };
    await expect(repository.claimNext()).resolves.toBeNull();
  });
});
