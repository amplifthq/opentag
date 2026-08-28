import {
  OpenTagChannelProtocolSchema,
  SourceAppCapabilitiesSchema,
  type SourceAppCorePorts
} from "@opentag/core";
import type {
  DeliveryIntentV2,
  ProviderDeliveryResult
} from "@opentag/delivery-contract";

export type SourceAppInstallation = {
  appInstanceId: string;
  bindingDigest: string;
  credentialGeneration: number;
  credentialGenerationDigest: string;
};

export type SourceAppDefinition<RawDelivery, NativePresentation, NativeRequest> =
  SourceAppCorePorts<RawDelivery, NativePresentation> & {
    installation: SourceAppInstallation;
    delivery: {
      prepare(command: import("@opentag/core").OpenTagChannelPresentationCommand): NativeRequest;
      deliver(input: {
        request: NativeRequest;
        intent: DeliveryIntentV2;
        signal?: AbortSignal;
      }): Promise<ProviderDeliveryResult>;
      reconcile(input: {
        intent: DeliveryIntentV2;
        request: NativeRequest;
      }): Promise<ProviderDeliveryResult>;
    };
  };

export function assertSourceAppDefinition(
  definition: SourceAppDefinition<unknown, unknown, unknown>
): void {
  if (typeof definition.appId !== "string" || definition.appId.trim().length === 0) {
    throw new Error("Source App appId must be a non-empty string.");
  }
  OpenTagChannelProtocolSchema.parse(definition.protocol);
  SourceAppCapabilitiesSchema.parse(definition.capabilities);
  const installation = definition.installation;
  if (typeof installation.appInstanceId !== "string" || installation.appInstanceId.trim().length === 0) {
    throw new Error("Source App appInstanceId must be a non-empty string.");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(installation.bindingDigest)
    || !/^sha256:[a-f0-9]{64}$/u.test(installation.credentialGenerationDigest)) {
    throw new Error("Source App installation digests must be canonical SHA-256 digests.");
  }
  if (!Number.isInteger(installation.credentialGeneration) || installation.credentialGeneration <= 0) {
    throw new Error("Source App credentialGeneration must be a positive integer.");
  }
}
