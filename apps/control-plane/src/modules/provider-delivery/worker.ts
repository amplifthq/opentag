import type { DeliveryClaimAuthority, ProviderSideEffectKernel } from "@opentag/delivery-runtime";

type Kernel = Pick<ProviderSideEffectKernel<object>, "deliverNext" | "recoverStrandedBegun">;
type PreloadResult = { registered: number; healthy: readonly DeliveryClaimAuthority[];
  failures: readonly unknown[] };
const RESTART_EVIDENCE = "sha256:323861ebb04dc43a1725514126023129654b8dcf64e6be5958174af1550f6c39";

export function createProviderDeliveryWorker(input: { kernel: Kernel;
  preloadSourceApps(): Promise<PreloadResult>; clock: { now(): Date } }) {
  let startupRecovered = false;
  return { async processNext() {
    let recovered = 0;
    if (!startupRecovered) {
      recovered = await input.kernel.recoverStrandedBegun({
        before: input.clock.now().toISOString(), evidenceDigest: RESTART_EVIDENCE,
      });
      startupRecovered = true;
    }
    let preload: PreloadResult;
    try { preload = await input.preloadSourceApps(); }
    catch { return { kind: "preload_unavailable" as const, recovered }; }
    const result = await input.kernel.deliverNext({ authorities: preload.healthy });
    return result === null ? { kind: "empty" as const, recovered, failures: preload.failures }
      : { kind: "delivered" as const, recovered, failures: preload.failures, result,
          providerDelivery: { state: result.outcome,
            ...("errorCode" in result && result.errorCode
              ? { reasonCode: result.errorCode } : {}) } };
  } };
}

/** Compatibility one-shot seam; scheduling and retry truth remain outside this function. */
export async function runOneProviderDelivery(kernel: Pick<ProviderSideEffectKernel<object>, "deliverNext">) {
  return kernel.deliverNext();
}
