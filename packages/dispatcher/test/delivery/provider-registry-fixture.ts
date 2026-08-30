import { SourceAppRegistry, type SourceAppDefinition } from "@opentag/source-app-runtime";
import { ProviderAdapterRegistry, type RegisteredProviderAdapter } from "../../src/delivery/provider-registry.js";

export function providerRegistry<Request extends object>(adapter?: RegisteredProviderAdapter<Request>) {
  const sources = new SourceAppRegistry();
  if (adapter) sources.register({ appId: adapter.providerId, protocol: "opentag.channel.v1",
    capabilities: { threads: true, messageUpdate: true, reactions: true,
      interactiveActions: false, attachments: "metadata", authenticatedDeletion: false,
      stableSourceVersions: false }, installation: { appInstanceId: adapter.providerInstanceId,
      bindingDigest: adapter.bindingDigest, credentialGeneration: adapter.providerConfigGeneration,
      credentialGenerationDigest: adapter.providerConfigGenerationDigest },
    ingress: { verify: async (input) => input, normalize: () => null },
    context: { readThread: async () => ({ messages: [], truncated: false, decodedBytes: 0 }) },
    presentation: { render: () => ({}) }, delivery: { prepare: () => ({}),
      deliver: ({ request, intent, signal }) => adapter.deliver({ ...(request as Request), intent,
        ...(signal ? { signal } : {}) }),
      reconcile: ({ request, intent }) => adapter.reconcile?.({ ...(request as Request), intent })
        ?? Promise.resolve({ outcome: "outcome_unknown", evidenceDigest:
          "sha256:03678b4f38f44836d76b8172e58b915aeb9e74d85627087f005ee6f9e4a76b7e",
          errorCode: "ambiguous_response" }) } } satisfies SourceAppDefinition<unknown, unknown, Request>);
  return new ProviderAdapterRegistry<Request>(sources);
}
