import { createHmac, timingSafeEqual } from "node:crypto";

export function computeSlackSignature(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
}): string {
  const base = `v0:${input.timestamp}:${input.rawBody}`;
  const digest = createHmac("sha256", input.signingSecret)
    .update(base)
    .digest("hex");
  return `v0=${digest}`;
}

export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
}): boolean {
  const expected = Buffer.from(computeSlackSignature(input));
  const actual = Buffer.from(input.signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function verifySlackTimestamp(input: {
  timestamp: string;
  nowMs: number;
  toleranceSeconds?: number;
}): boolean {
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const toleranceSeconds = input.toleranceSeconds ?? 300;
  const ageSeconds = Math.abs(
    Math.floor(input.nowMs / 1_000) - timestampSeconds,
  );
  return ageSeconds <= toleranceSeconds;
}
