import { describe, expect, it } from "vitest";
import { ProviderAdapterRegistry } from "../../src/delivery/provider-registry.js";
import { SourceAppRegistry } from "@opentag/source-app-runtime";

describe("dispatcher delivery runtime compatibility", () => {
  it("re-exports the delivery runtime registry", () => {
    expect(new ProviderAdapterRegistry(new SourceAppRegistry())).toBeInstanceOf(ProviderAdapterRegistry);
  });
});
