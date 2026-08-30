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
  readonly #highWater = new Map<string, Readonly<Pick<SourceAppInstallation,
    "bindingDigest" | "credentialGeneration" | "credentialGenerationDigest">>>();

  static #key(organizationId: string, appId: string, appInstanceId: string): string {
    return JSON.stringify([organizationId, appId, appInstanceId]);
  }

  register<RawDelivery, NativePresentation, NativeRequest>(
    definition: SourceAppDefinition<RawDelivery, NativePresentation, NativeRequest>
  ): this {
    assertSourceAppDefinition(definition);
    const key = SourceAppRegistry.#key(definition.installation.organizationId,
      definition.appId, definition.installation.appInstanceId);
    const current = this.#apps.get(key);
    const previous = current?.installation ?? this.#highWater.get(key);
    if (previous) {
      const next = definition.installation;
      if (next.credentialGeneration < previous.credentialGeneration)
        throw new Error("Source App credential generation downgrade");
      if (next.credentialGeneration === previous.credentialGeneration) {
        if (next.bindingDigest !== previous.bindingDigest
          || next.credentialGenerationDigest !== previous.credentialGenerationDigest)
          throw new Error("Source App equal generation mismatch");
        if (current) return this;
      }
    }
    this.#apps.set(key, registrationSnapshot(definition as RegisteredSourceApp));
    this.#highWater.set(key, Object.freeze({ bindingDigest: definition.installation.bindingDigest,
      credentialGeneration: definition.installation.credentialGeneration,
      credentialGenerationDigest: definition.installation.credentialGenerationDigest }));
    return this;
  }

  replaceAppSnapshot(appId: string,
    definitions: readonly SourceAppDefinition<unknown, unknown, unknown>[]): this {
    const replacement = new Map([...this.#apps].filter(([, value]) => value.appId !== appId));
    const nextHighWater = new Map(this.#highWater);
    for (const definition of definitions) {
      assertSourceAppDefinition(definition);
      if (definition.appId !== appId) throw new Error("Source App snapshot appId mismatch");
      const key = SourceAppRegistry.#key(definition.installation.organizationId,
        definition.appId, definition.installation.appInstanceId);
      if (replacement.has(key)) throw new Error("Source App snapshot duplicate identity");
      const previous = this.#apps.get(key)?.installation ?? this.#highWater.get(key);
      if (previous && definition.installation.credentialGeneration < previous.credentialGeneration)
        throw new Error("Source App credential generation downgrade");
      if (previous && definition.installation.credentialGeneration === previous.credentialGeneration
        && (definition.installation.bindingDigest !== previous.bindingDigest
          || definition.installation.credentialGenerationDigest !== previous.credentialGenerationDigest))
        throw new Error("Source App equal generation mismatch");
      replacement.set(key, registrationSnapshot(definition));
      nextHighWater.set(key, Object.freeze({ bindingDigest: definition.installation.bindingDigest,
        credentialGeneration: definition.installation.credentialGeneration,
        credentialGenerationDigest: definition.installation.credentialGenerationDigest }));
    }
    this.#apps.clear();
    for (const [key, value] of replacement) this.#apps.set(key, value);
    this.#highWater.clear();
    for (const [key, value] of nextHighWater) this.#highWater.set(key, value);
    return this;
  }

  resolve(appId: string): RegisteredSourceAppDefinition | undefined {
    const matches = [...this.#apps.values()].filter((definition) => definition.appId === appId);
    return matches.length === 1 ? matches[0] : undefined;
  }

  deliveryAuthorities() {
    return [...this.#apps.values()].map((definition) => ({
      organizationId: definition.installation.organizationId, appId: definition.appId,
      appInstanceId: definition.installation.appInstanceId,
      bindingDigest: definition.installation.bindingDigest,
      credentialGeneration: definition.installation.credentialGeneration,
      credentialGenerationDigest: definition.installation.credentialGenerationDigest,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }

  resolveDelivery(input: SourceAppInstallation & { appId: string }): RegisteredSourceAppDefinition | undefined {
    const definition = this.#apps.get(SourceAppRegistry.#key(input.organizationId,
      input.appId, input.appInstanceId));
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
