import type { DeliveryExternalResourceLookupDescriptor, DeliveryIntentV2 } from "@opentag/delivery-contract";
import type { DeliveryKernelRepository } from "../src/repository.js";
import { expect } from "vitest";
import type { DeliveryClaimAuthority } from "../src/repository.js";

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

export async function verifyExtendedDeliveryRepositoryContract(input: {
  repository: DeliveryKernelRepository;
  createCase(name: string, deadline: string, binding?: "healthy" | "broken"): {
    intent: DeliveryIntentV2; payload: unknown; lookup: DeliveryExternalResourceLookupDescriptor };
  setNow(value: string): void; digest: string; healthyAuthority: DeliveryClaimAuthority;
}) {
  input.setNow("2026-08-30T00:00:10.000Z");
  const expired = input.createCase("expired", "2026-08-30T00:00:09.000Z");
  await input.repository.recordIntent(expired.intent, expired.payload);
  expect(await input.repository.claimNext()).toBeNull();

  input.setNow("2026-08-30T00:00:20.000Z");
  const frozen = input.createCase("begin-deadline", "2026-08-30T00:00:30.000Z");
  await input.repository.recordIntent(frozen.intent, frozen.payload);
  const frozenClaim = await input.repository.claimNext(); expect(frozenClaim).not.toBeNull();
  input.setNow("2026-08-30T00:00:31.000Z");
  expect(await input.repository.markBegin({ ...frozenClaim!, installationBeginMarkerId: "deadline-install",
    installationBeginMarkerDigest: input.digest, scopeBeginMarkerId: "deadline-scope",
    scopeBeginMarkerDigest: input.digest })).toBeNull();

  input.setNow("2026-08-30T00:01:00.000Z");
  const stranded = input.createCase("stranded", "2026-08-30T00:02:00.000Z");
  await input.repository.recordIntent(stranded.intent, stranded.payload);
  const strandedClaim = await input.repository.claimNext(); expect(strandedClaim).not.toBeNull();
  const strandedBegin = await input.repository.markBegin({ ...strandedClaim!,
    installationBeginMarkerId: "stranded-install", installationBeginMarkerDigest: input.digest,
    scopeBeginMarkerId: "stranded-scope", scopeBeginMarkerDigest: input.digest });
  expect(strandedBegin).not.toBeNull();
  input.setNow("2026-08-30T00:01:30.000Z");
  expect(await input.repository.finalizeStrandedBegun({ before: "2026-08-30T00:01:30.000Z",
    evidenceDigest: input.digest })).toBe(1);
  await expect(Promise.resolve().then(() => input.repository.settleOrReadTerminal({ ...strandedBegin!,
    outcome: "accepted", evidenceDigest: input.digest }))).rejects.toThrow(/terminal.*conflict/u);

  const accepted = input.createCase("lookup-one", "2026-08-30T00:03:00.000Z");
  await input.repository.recordIntent(accepted.intent, accepted.payload);
  const acceptedClaim = await input.repository.claimNext(); expect(acceptedClaim).not.toBeNull();
  const acceptedBegin = await input.repository.markBegin({ ...acceptedClaim!,
    installationBeginMarkerId: "lookup-one-install", installationBeginMarkerDigest: input.digest,
    scopeBeginMarkerId: "lookup-one-scope", scopeBeginMarkerDigest: input.digest });
  await input.repository.settleOrReadTerminal({ ...acceptedBegin!, outcome: "accepted",
    evidenceDigest: input.digest, externalResourceId: "resource-one",
    externalResourceDigest: input.digest });
  expect(await input.repository.findAcceptedExternalResource(accepted.lookup)).toEqual({
    outcome: "exact", externalResourceId: "resource-one", externalResourceDigest: input.digest });
  const duplicate = input.createCase("lookup-two", "2026-08-30T00:03:00.000Z");
  await input.repository.recordIntent(duplicate.intent, duplicate.payload);
  const duplicateClaim = await input.repository.claimNext(); expect(duplicateClaim).not.toBeNull();
  const duplicateBegin = await input.repository.markBegin({ ...duplicateClaim!,
    installationBeginMarkerId: "lookup-two-install", installationBeginMarkerDigest: input.digest,
    scopeBeginMarkerId: "lookup-two-scope", scopeBeginMarkerDigest: input.digest });
  await input.repository.settleOrReadTerminal({ ...duplicateBegin!, outcome: "accepted",
    evidenceDigest: input.digest, externalResourceId: "resource-two",
    externalResourceDigest: `sha256:${"e".repeat(64)}` });
  expect(await input.repository.findAcceptedExternalResource(accepted.lookup)).toEqual({ outcome: "ambiguous" });

  const broken = input.createCase("broken-authority", "2026-08-30T00:03:00.000Z", "broken");
  const healthy = input.createCase("healthy-authority", "2026-08-30T00:03:00.000Z", "healthy");
  await input.repository.recordIntent(broken.intent, broken.payload);
  await input.repository.recordIntent(healthy.intent, healthy.payload);
  const healthyClaim = await input.repository.claimNext({ authorities: [input.healthyAuthority] });
  expect(healthyClaim?.intentId).toBe(healthy.intent.sideEffectIntentId);
  expect(await input.repository.releaseUnusedClaim(healthyClaim!)).toBe(true);
  expect((await input.repository.claimNext({ authorities: [input.healthyAuthority] }))?.intentId)
    .toBe(healthy.intent.sideEffectIntentId);
}
