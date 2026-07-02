import { createPublicKey, verify } from "node:crypto";

// DER SPKI prefix for Ed25519; prepended to a raw 32-byte key so
// `crypto.createPublicKey` accepts it (avoids a third-party Ed25519 dependency).
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function isHex(value: string): boolean {
  return value.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(value);
}

function ed25519PublicKeyFromRawHex(publicKeyHex: string) {
  const raw = Buffer.from(publicKeyHex, "hex");
  if (raw.length !== 32) {
    throw new Error("Discord Ed25519 public key must be 32 bytes");
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki"
  });
}

/**
 * Verify Discord's Ed25519 interaction signature over `timestamp + rawBody`.
 * Callers must verify the raw (unparsed) body BEFORE `JSON.parse`. Malformed
 * input returns `false` rather than throwing, so the handler can answer 401.
 */
export function verifyDiscordSignature(input: {
  publicKey: string;
  signature: string;
  timestamp: string;
  rawBody: string;
}): boolean {
  if (!input.publicKey || !input.signature || !input.timestamp) return false;
  if (!isHex(input.publicKey) || !isHex(input.signature)) return false;
  try {
    const key = ed25519PublicKeyFromRawHex(input.publicKey);
    return verify(null, Buffer.from(input.timestamp + input.rawBody), key, Buffer.from(input.signature, "hex"));
  } catch {
    return false;
  }
}
