import {
  assertSourceAppDefinition,
  type SourceAppDefinition,
  type SourceAppInstallation
} from "./definition.js";

type RegisteredSourceApp = SourceAppDefinition<unknown, unknown, unknown>;

export type RegisteredSourceAppDefinition = Readonly<
  Omit<RegisteredSourceApp, "capabilities" | "installation" | "ingress" | "context" | "presentation" | "delivery"> & {
    readonly capabilities: Readonly<RegisteredSourceApp["capabilities"]>;
    readonly installation: Readonly<RegisteredSourceApp["installation"]>;
    readonly ingress: Readonly<RegisteredSourceApp["ingress"]>;
    readonly context: Readonly<RegisteredSourceApp["context"]>;
    readonly presentation: Readonly<RegisteredSourceApp["presentation"]>;
    readonly delivery: Readonly<RegisteredSourceApp["delivery"]>;
  }
>;

function registrationSnapshot(definition: RegisteredSourceApp): RegisteredSourceAppDefinition {
  return Object.freeze({
    appId: definition.appId,
    protocol: definition.protocol,
    capabilities: Object.freeze({ ...definition.capabilities }),
    installation: Object.freeze({ ...definition.installation }),
    ingress: Object.freeze({
      verify: definition.ingress.verify,
      normalize: definition.ingress.normalize,
      ...(definition.ingress.normalizeResult ? { normalizeResult: definition.ingress.normalizeResult } : {})
    }),
    context: Object.freeze({ readThread: definition.context.readThread }),
    presentation: Object.freeze({ render: definition.presentation.render }),
    delivery: Object.freeze({
      prepare: definition.delivery.prepare,
      deliver: definition.delivery.deliver,
      reconcile: definition.delivery.reconcile
    })
  });
}

export class SourceAppRegistry {
  readonly #apps = new Map<string, RegisteredSourceAppDefinition>();

  register<RawDelivery, NativePresentation, NativeRequest>(
    definition: SourceAppDefinition<RawDelivery, NativePresentation, NativeRequest>
  ): this {
    assertSourceAppDefinition(definition);
    if (this.#apps.has(definition.appId)) {
      throw new Error(`Source App already registered: ${definition.appId}`);
    }
    this.#apps.set(definition.appId, registrationSnapshot(definition as RegisteredSourceApp));
    return this;
  }

  resolve(appId: string): RegisteredSourceAppDefinition | undefined {
    return this.#apps.get(appId);
  }

  resolveDelivery(input: SourceAppInstallation & { appId: string }): RegisteredSourceAppDefinition | undefined {
    const definition = this.#apps.get(input.appId);
    if (!definition) return undefined;
    const installation = definition.installation;
    return installation.appInstanceId === input.appInstanceId
      && installation.bindingDigest === input.bindingDigest
      && installation.credentialGeneration === input.credentialGeneration
      && installation.credentialGenerationDigest === input.credentialGenerationDigest
      ? definition
      : undefined;
  }
}
