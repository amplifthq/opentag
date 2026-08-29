import { DeliveryIntentV2Schema, type DeliveryIntentV2 } from "@opentag/delivery-contract";
type Resolver<P> = (presentation: P) => Promise<{ intent: DeliveryIntentV2; persistedPayload: unknown } | null>;
type Submitter = { enqueue(intent: DeliveryIntentV2, payload: unknown): Promise<{ outcome: "queued" }> };
export class UnifiedDeliveryProducer<Presentation> {
  readonly #resolveIntent: Resolver<Presentation> | undefined;
  readonly #submitter: Submitter | undefined;
  constructor(input: { resolveIntent?: Resolver<Presentation>; submitter?: Submitter }) {
    this.#resolveIntent = input.resolveIntent; this.#submitter = input.submitter;
  }
  async enqueue(presentation: Presentation) {
    if (!this.#resolveIntent || !this.#submitter) return { outcome: "activation_blocked" } as const;
    const resolved = await this.#resolveIntent(presentation);
    if (!resolved) return { outcome: "activation_blocked" } as const;
    const intent = DeliveryIntentV2Schema.parse(resolved.intent);
    const submitted = await this.#submitter.enqueue(intent, resolved.persistedPayload);
    if (submitted.outcome !== "queued") throw new Error("Delivery submitter did not confirm a durable enqueue.");
    return { outcome: "queued", sideEffectIntentId: intent.sideEffectIntentId } as const;
  }
}
export type UnifiedDeliveryEnqueuer<P> = Pick<UnifiedDeliveryProducer<P>, "enqueue">;
