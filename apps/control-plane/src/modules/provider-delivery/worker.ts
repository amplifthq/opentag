import type { ProviderSideEffectKernel } from "@opentag/delivery-runtime";

/** One delivery iteration. Scheduling remains outside this module; retry truth stays in the kernel/repository. */
export async function runOneProviderDelivery(kernel: Pick<ProviderSideEffectKernel<object>, "deliverNext">) {
  return kernel.deliverNext();
}
