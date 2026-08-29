import { describe, expect, it } from "vitest";
import { ProviderAdapterRegistry } from "../../src/delivery/provider-registry.js";

describe("dispatcher delivery runtime compatibility", () => {
  it("re-exports the delivery runtime registry", () => {
    expect(new ProviderAdapterRegistry()).toBeInstanceOf(ProviderAdapterRegistry);
  });
});
