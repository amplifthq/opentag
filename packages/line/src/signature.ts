import { createHmac, timingSafeEqual } from "node:crypto";

export function computeLineSignature(input: { channelSecret: string; rawBody: string }): string {
  return createHmac("sha256", input.channelSecret).update(input.rawBody).digest("base64");
}

export function verifyLineSignature(input: { channelSecret: string; rawBody: string; signature: string }): boolean {
  const expected = Buffer.from(computeLineSignature(input));
  const actual = Buffer.from(input.signature);
  const length = Math.max(expected.length, actual.length);
  const paddedExpected = Buffer.alloc(length);
  const paddedActual = Buffer.alloc(length);
  expected.copy(paddedExpected);
  actual.copy(paddedActual);
  return timingSafeEqual(paddedExpected, paddedActual) && expected.length === actual.length;
}