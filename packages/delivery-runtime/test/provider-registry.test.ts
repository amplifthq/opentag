import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SourceAppRegistry, type SourceAppDefinition } from "@opentag/source-app-runtime";
import { ProviderAdapterRegistry } from "../src/index.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function sourceApp(): SourceAppDefinition<unknown, unknown, { text: string }> {
  return { appId: "slack", protocol: "opentag.channel.v1",
    capabilities: { threads: true, messageUpdate: true, reactions: true,
      interactiveActions: false, attachments: "metadata", authenticatedDeletion: true,
      stableSourceVersions: true },
    installation: { appInstanceId: "workspace-a", bindingDigest: digest("binding"),
      credentialGeneration: 7, credentialGenerationDigest: digest("generation") },
    ingress: { verify: async (input) => input, normalize: () => null },
    context: { readThread: async () => ({ messages: [], truncated: false, decodedBytes: 0 }) },
    presentation: { render: () => ({}) },
    delivery: { prepare: () => ({ text: "prepared" }),
      deliver: async () => ({ outcome: "accepted", evidenceDigest: digest("accepted"),
        externalResourceId: "1712345678.000001" }),
      reconcile: async () => ({ outcome: "outcome_unknown", evidenceDigest: digest("unknown") }) },
  };
}

describe("ProviderAdapterRegistry", () => {
  it("resolves delivery from the one composite SourceAppRegistry identity", async () => {
    const sources = new SourceAppRegistry().register(sourceApp());
    const registry = new ProviderAdapterRegistry<{ text: string }>(sources);
    const binding = { bindingKind: "established" as const, providerId: "slack",
      providerInstanceId: "workspace-a", bindingDigest: digest("binding"),
      providerPrincipalDigest: digest("principal"), principalAssurance: "provider_verified" as const,
      providerConfigGeneration: 7, providerConfigGenerationDigest: digest("generation"),
      lifecycle: "active" as const };
    const adapter = registry.resolve(binding);
    expect(adapter).toBeDefined();
    await expect(adapter!.deliver({ request: { text: "hello" }, intent: {} as never }))
      .resolves.toMatchObject({ outcome: "accepted", externalResourceId: "1712345678.000001" });
    expect(registry.resolve({ ...binding, providerConfigGeneration: 8 })).toBeUndefined();
  });
});
