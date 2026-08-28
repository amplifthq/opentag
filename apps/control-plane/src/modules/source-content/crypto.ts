import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export type RelayContentKey = { key: Buffer; keyVersion: string };

export function loadRelayContentKey(reference: { file: string; keyVersion: string }): RelayContentKey {
  try {
    const stored = readFileSync(reference.file);
    let key: Buffer;
    if (stored.length === 32) key = Buffer.from(stored);
    else {
      const encoded = stored.toString("utf8").trim();
      key = /^[a-f0-9]{64}$/iu.test(encoded)
        ? Buffer.from(encoded, "hex")
        : Buffer.from(encoded, "base64");
    }
    if (key.length !== 32 || !reference.keyVersion) {
      key.fill(0);
      throw new Error("invalid");
    }
    return { key, keyVersion: reference.keyVersion };
  } catch {
    throw new Error("source_content_key_invalid");
  }
}
export type SourceContentContext = {
  organizationId: string; installationId: string; sourceAppId: string;
  sourceDeliveryId: string; sourceMessageId: string; sourceVersionRef: string;
  purpose: string; contentId: string;
};

const stable = (value: unknown) => JSON.stringify(value);
export const digest = (value: unknown) => createHash("sha256").update(
  typeof value === "string" ? value : stable(value), "utf8",
).digest("hex");

export function sourceContentAad(context: SourceContentContext): Buffer {
  return Buffer.from(stable([
    "opentag.relay.source-content/v1", context.organizationId,
    context.installationId, context.sourceAppId, context.sourceDeliveryId,
    context.sourceMessageId, context.sourceVersionRef, context.purpose,
    context.contentId,
  ]), "utf8");
}

function assertKey(key: RelayContentKey): void {
  if (key.key.length !== 32 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(key.keyVersion)) {
    throw new Error("source_content_key_invalid");
  }
}

function encryptAesGcm(plaintext: Buffer, key: Buffer, aad: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

function decryptAesGcm(input: { ciphertext: Buffer; nonce: Buffer; tag: Buffer }, key: Buffer, aad: Buffer) {
  const decipher = createDecipheriv("aes-256-gcm", key, input.nonce);
  decipher.setAAD(aad); decipher.setAuthTag(input.tag);
  return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
}

export function encryptSourceContent(input: {
  key: RelayContentKey; context: SourceContentContext; plaintext: Buffer;
}) {
  assertKey(input.key);
  const aad = sourceContentAad(input.context);
  const dek = randomBytes(32);
  try {
    const content = encryptAesGcm(input.plaintext, dek, aad);
    const wrapAad = Buffer.from(stable([
      "opentag.relay.source-content-dek/v1", input.key.keyVersion,
      digest(aad), input.context.purpose, input.context.contentId,
    ]), "utf8");
    const wrapped = encryptAesGcm(dek, input.key.key, wrapAad);
    return { ciphertext: content.ciphertext, contentNonce: content.nonce,
      contentTag: content.tag, wrappedDek: wrapped.ciphertext,
      wrappingNonce: wrapped.nonce, wrappingTag: wrapped.tag,
      aadDigest: digest(aad), keyVersion: input.key.keyVersion };
  } finally { dek.fill(0); }
}

export function decryptSourceContent(input: {
  key: RelayContentKey; context: SourceContentContext; ciphertext: Buffer;
  contentNonce: Buffer; contentTag: Buffer; wrappedDek: Buffer;
  wrappingNonce: Buffer; wrappingTag: Buffer; aadDigest: string; keyVersion: string;
}): Buffer {
  assertKey(input.key);
  const aad = sourceContentAad(input.context);
  if (input.key.keyVersion !== input.keyVersion || digest(aad) !== input.aadDigest) {
    throw new Error("source_content_context_mismatch");
  }
  const wrapAad = Buffer.from(stable([
    "opentag.relay.source-content-dek/v1", input.keyVersion, input.aadDigest,
    input.context.purpose, input.context.contentId,
  ]), "utf8");
  let dek: Buffer | undefined;
  try {
    dek = decryptAesGcm({ ciphertext: input.wrappedDek, nonce: input.wrappingNonce,
      tag: input.wrappingTag }, input.key.key, wrapAad);
    return decryptAesGcm({ ciphertext: input.ciphertext, nonce: input.contentNonce,
      tag: input.contentTag }, dek, aad);
  } catch (error) {
    if (error instanceof Error && error.message === "source_content_context_mismatch") throw error;
    throw new Error("source_content_decryption_failed");
  } finally { dek?.fill(0); }
}
