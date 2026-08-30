import type { DeliveryExternalResourceLookupDescriptor, DeliveryIntentV2 } from "@opentag/delivery-contract";
import type { DeliveryKernelRepository } from "../src/repository.js";
import { expect } from "vitest";

export async function verifyDeliveryRepositoryContract(input: {
  repository: DeliveryKernelRepository; intent: DeliveryIntentV2; payload: unknown;
  digest: string; lookup: DeliveryExternalResourceLookupDescriptor;
}) {
  await input.repository.recordIntent(input.intent, input.payload);
  await input.repository.recordIntent(input.intent, input.payload);
  const claimed = await input.repository.claimNext(); expect(claimed).not.toBeNull();
  expect(await input.repository.getIntent(claimed!)).toMatchObject({ outcome: "hydrated",
    journalIntentDigest: claimed!.journalIntentDigest });
  expect(await input.repository.releaseUnusedClaim(claimed!)).toBe(true);
  expect(await input.repository.renewLease(claimed!)).toBeNull();
  const reclaimed = await input.repository.claimNext(); expect(reclaimed).not.toBeNull();
  const renewed = await input.repository.renewLease(reclaimed!); expect(renewed).not.toBeNull();
  expect(await input.repository.finalizeStrandedBegun({ before: "1970-01-01T00:00:00.000Z",
    evidenceDigest: input.digest })).toBe(0);
  expect(await input.repository.findAcceptedExternalResource(input.lookup)).toEqual({ outcome: "none" });
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
  for (const drifted of [
    { ...begun!, outcome: "accepted" as const,
      evidenceDigest: `sha256:${"f".repeat(64)}` },
    { ...begun!, outcome: "rejected" as const, evidenceDigest: input.digest,
      errorCode: "slack_rejected" as const },
    { ...begun!, outcome: "accepted" as const, evidenceDigest: input.digest,
      externalResourceId: "drifted", externalResourceDigest: input.digest },
  ]) {
    await expect(Promise.resolve().then(() =>
      input.repository.settleOrReadTerminal(drifted))).rejects.toThrow(/terminal.*conflict/u);
  }
  expect(await input.repository.claimNext()).toBeNull();
}
