import {
  assertSourceAppDefinition,
  type SourceAppDefinition,
  type SourceAppInstallation
} from "./definition.js";

type RegisteredSourceApp = SourceAppDefinition<unknown, unknown, unknown>;

export class SourceAppRegistry {
  readonly #apps = new Map<string, RegisteredSourceApp>();

  register<RawDelivery, NativePresentation, NativeRequest>(
    definition: SourceAppDefinition<RawDelivery, NativePresentation, NativeRequest>
  ): this {
    assertSourceAppDefinition(definition as RegisteredSourceApp);
    if (this.#apps.has(definition.appId)) {
      throw new Error(`Source App already registered: ${definition.appId}`);
    }
    this.#apps.set(definition.appId, Object.freeze(definition) as RegisteredSourceApp);
    return this;
  }

  resolve(appId: string): RegisteredSourceApp | undefined {
    return this.#apps.get(appId);
  }

  resolveDelivery(input: SourceAppInstallation & { appId: string }): RegisteredSourceApp | undefined {
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
