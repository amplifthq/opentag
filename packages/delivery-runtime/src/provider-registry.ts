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
  constructor(sources: SourceAppRegistry) {
    if (!sources) throw new Error("Canonical SourceAppRegistry is required");
    this.#sources = sources;
  }

  resolve(input: { organizationId: string; binding: EstablishedProviderBindingV1 }): ResolvedProviderAdapter<Request> | undefined {
    const { binding } = input;
    const definition = this.#sources.resolveDelivery({ organizationId: input.organizationId,
      appId: binding.providerId,
      appInstanceId: binding.providerInstanceId, bindingDigest: binding.bindingDigest,
      credentialGeneration: binding.providerConfigGeneration,
      credentialGenerationDigest: binding.providerConfigGenerationDigest });
    if (!definition) return undefined;
    return { deliver: (input) => definition.delivery.deliver(input as never),
      reconcile: (input) => definition.delivery.reconcile(input as never) };
  }
}

export type { ProviderDeliveryResult } from "@opentag/delivery-contract";
