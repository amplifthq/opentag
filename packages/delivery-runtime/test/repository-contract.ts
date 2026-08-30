import type { DeliveryIntentV2 } from "@opentag/delivery-contract";
import type { DeliveryKernelRepository } from "../src/repository.js";
import { expect } from "vitest";

export async function verifyDeliveryRepositoryContract(input: {
  repository: DeliveryKernelRepository; intent: DeliveryIntentV2; payload: unknown;
  digest: string;
}) {
  await input.repository.recordIntent(input.intent, input.payload);
  await input.repository.recordIntent(input.intent, input.payload);
  const claimed = await input.repository.claimNext(); expect(claimed).not.toBeNull();
  const renewed = await input.repository.renewLease(claimed!); expect(renewed).not.toBeNull();
  const begun = await input.repository.markBegin({ ...renewed!,
    installationBeginMarkerId: "shared-installation",
    installationBeginMarkerDigest: input.digest,
    scopeBeginMarkerId: "shared-scope", scopeBeginMarkerDigest: input.digest });
  expect(begun).not.toBeNull();
  const terminal = await input.repository.settleOrReadTerminal({ ...begun!, outcome: "accepted",
    evidenceDigest: input.digest });
  expect(terminal).toMatchObject({ outcome: "accepted", intentId: input.intent.sideEffectIntentId });
  expect(await input.repository.settleOrReadTerminal({ ...begun!, outcome: "accepted",
    evidenceDigest: input.digest })).toEqual(terminal);
  expect(await input.repository.claimNext()).toBeNull();
}
