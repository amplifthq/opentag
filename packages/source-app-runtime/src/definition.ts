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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertPortGroup(
  definition: Record<string, unknown>,
  group: "ingress" | "context" | "presentation" | "delivery",
  members: readonly string[]
): void {
  const ports = definition[group];
  for (const member of members) {
    if (!isRecord(ports) || typeof ports[member] !== "function") {
      throw new Error(`Source App ${group}.${member} must be a function.`);
    }
  }
}

export function assertSourceAppDefinition(
  input: unknown
): asserts input is SourceAppDefinition<unknown, unknown, unknown> {
  if (!isRecord(input)) throw new Error("Source App definition must be an object.");
  const definition = input;
  if (typeof definition.appId !== "string" || definition.appId.trim().length === 0) {
    throw new Error("Source App appId must be a non-empty string.");
  }
  OpenTagChannelProtocolSchema.parse(definition.protocol);
  SourceAppCapabilitiesSchema.parse(definition.capabilities);
  const installation = definition.installation;
  if (!isRecord(installation)) throw new Error("Source App installation must be an object.");
  if (typeof installation.appInstanceId !== "string" || installation.appInstanceId.trim().length === 0) {
    throw new Error("Source App appInstanceId must be a non-empty string.");
  }
  if (typeof installation.bindingDigest !== "string"
    || typeof installation.credentialGenerationDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(installation.bindingDigest)
    || !/^sha256:[a-f0-9]{64}$/u.test(installation.credentialGenerationDigest)) {
    throw new Error("Source App installation digests must be canonical SHA-256 digests.");
  }
  if (typeof installation.credentialGeneration !== "number"
    || !Number.isInteger(installation.credentialGeneration)
    || installation.credentialGeneration <= 0) {
    throw new Error("Source App credentialGeneration must be a positive integer.");
  }
  assertPortGroup(definition, "ingress", ["verify", "normalize"]);
  assertPortGroup(definition, "context", ["readThread"]);
  assertPortGroup(definition, "presentation", ["render"]);
  assertPortGroup(definition, "delivery", ["prepare", "deliver", "reconcile"]);
}
