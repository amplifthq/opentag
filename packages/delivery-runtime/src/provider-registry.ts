import type { DeliveryIntentV2, EstablishedProviderBindingV1, ProviderDeliveryResult } from "@opentag/delivery-contract";
import { SourceAppRegistry } from "@opentag/source-app-runtime";

export type RegisteredProviderAdapter<Request extends object = object> = {
  providerId: string; providerInstanceId: string; bindingDigest: string;
  providerPrincipalDigest: string; providerConfigGeneration: number;
  providerConfigGenerationDigest: string;
  deliver(input: Request & { intent: DeliveryIntentV2; signal?: AbortSignal }): Promise<ProviderDeliveryResult>;
  reconcile?(input: Request & { intent: DeliveryIntentV2 }): Promise<ProviderDeliveryResult>;
};
export type ResolvedProviderAdapter<Request extends object> = {
  deliver(input: { request: Request; intent: DeliveryIntentV2; signal?: AbortSignal }): Promise<ProviderDeliveryResult>;
  reconcile(input: { request: Request; intent: DeliveryIntentV2 }): Promise<ProviderDeliveryResult>;
};

export class ProviderAdapterRegistry<Request extends object = object> {
  readonly #sources: SourceAppRegistry;
  constructor(sources = new SourceAppRegistry()) { this.#sources = sources; }

  /** @deprecated Register complete Source Apps in SourceAppRegistry. */
  register(adapter: RegisteredProviderAdapter<Request>): this {
    this.#sources.register({ appId: adapter.providerId, protocol: "opentag.channel.v1",
      capabilities: { threads: true, messageUpdate: true, reactions: true,
        interactiveActions: false, attachments: "metadata", authenticatedDeletion: false,
        stableSourceVersions: false },
      installation: { appInstanceId: adapter.providerInstanceId, bindingDigest: adapter.bindingDigest,
        credentialGeneration: adapter.providerConfigGeneration,
        credentialGenerationDigest: adapter.providerConfigGenerationDigest },
      ingress: { verify: async (input) => input, normalize: () => null },
      context: { readThread: async () => ({ messages: [], truncated: false, decodedBytes: 0 }) },
      presentation: { render: () => ({}) }, delivery: { prepare: () => ({}),
        deliver: ({ request, intent, signal }) => adapter.deliver({ ...(request as Request), intent,
          ...(signal ? { signal } : {}) }),
        reconcile: ({ request, intent }) => adapter.reconcile?.({ ...(request as Request), intent })
          ?? Promise.resolve({ outcome: "outcome_unknown", evidenceDigest:
            "sha256:03678b4f38f44836d76b8172e58b915aeb9e74d85627087f005ee6f9e4a76b7e" }) },
    });
    return this;
  }

  resolve(binding: EstablishedProviderBindingV1): ResolvedProviderAdapter<Request> | undefined {
    const definition = this.#sources.resolveDelivery({ appId: binding.providerId,
      appInstanceId: binding.providerInstanceId, bindingDigest: binding.bindingDigest,
      credentialGeneration: binding.providerConfigGeneration,
      credentialGenerationDigest: binding.providerConfigGenerationDigest });
    if (!definition) return undefined;
    return { deliver: (input) => definition.delivery.deliver(input as never),
      reconcile: (input) => definition.delivery.reconcile(input as never) };
  }
}

export type { ProviderDeliveryResult } from "@opentag/delivery-contract";
