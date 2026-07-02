import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyDiscordSignature } from "../src/signature.js";

/** Generate a throwaway Ed25519 key pair and return the raw 32-byte public key
 * (hex) plus a signer over `timestamp + body`. The SPKI DER export is a 12-byte
 * prefix followed by the 32 raw key bytes, so the last 32 bytes are the raw key
 * Discord would surface as the application public key. These are ephemeral test
 * keys, never real credentials. */
function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const signHex = (timestamp: string, body: string) => sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  return { publicKeyHex, signHex };
}

describe("verifyDiscordSignature", () => {
  const timestamp = "1719900000";
  const body = JSON.stringify({ type: 1 });

  it("returns true for a valid signature over timestamp + body", () => {
    const { publicKeyHex, signHex } = makeSigner();
    expect(
      verifyDiscordSignature({ publicKey: publicKeyHex, signature: signHex(timestamp, body), timestamp, rawBody: body })
    ).toBe(true);
  });

  it("returns false when the body is tampered after signing", () => {
    const { publicKeyHex, signHex } = makeSigner();
    const signature = signHex(timestamp, body);
    expect(
      verifyDiscordSignature({ publicKey: publicKeyHex, signature, timestamp, rawBody: `${body} ` })
    ).toBe(false);
  });

  it("returns false when the timestamp differs from the signed one", () => {
    const { publicKeyHex, signHex } = makeSigner();
    const signature = signHex(timestamp, body);
    expect(
      verifyDiscordSignature({ publicKey: publicKeyHex, signature, timestamp: "1719900001", rawBody: body })
    ).toBe(false);
  });

  it("returns false for a signature made with a different key", () => {
    const signer = makeSigner();
    const other = makeSigner();
    expect(
      verifyDiscordSignature({
        publicKey: signer.publicKeyHex,
        signature: other.signHex(timestamp, body),
        timestamp,
        rawBody: body
      })
    ).toBe(false);
  });

  it("returns false for a non-hex or wrong-length public key", () => {
    const { signHex } = makeSigner();
    const signature = signHex(timestamp, body);
    expect(verifyDiscordSignature({ publicKey: "not-hex", signature, timestamp, rawBody: body })).toBe(false);
    expect(verifyDiscordSignature({ publicKey: "abcd", signature, timestamp, rawBody: body })).toBe(false);
  });

  it("returns false when required fields are empty", () => {
    const { publicKeyHex, signHex } = makeSigner();
    const signature = signHex(timestamp, body);
    expect(verifyDiscordSignature({ publicKey: "", signature, timestamp, rawBody: body })).toBe(false);
    expect(verifyDiscordSignature({ publicKey: publicKeyHex, signature: "", timestamp, rawBody: body })).toBe(false);
    expect(verifyDiscordSignature({ publicKey: publicKeyHex, signature, timestamp: "", rawBody: body })).toBe(false);
  });
});
