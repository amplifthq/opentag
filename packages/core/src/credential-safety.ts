const CREDENTIAL_NAME_PATTERN = /(?:^|[_-])(?:auth(?:orization|entication)?|bearer|cookie|credential|password|passphrase|private[_-]?key|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|refresh[_-]?token|session|signature|signed)(?:$|[_-])/iu;
const KNOWN_TOKEN_PATTERN = /(?:\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}\b|\bglpat-[A-Za-z0-9_-]{8,}\b|\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]{8,}\b|\bsk_(?:live|test)_[A-Za-z0-9_-]{8,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b)/u;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/u;
const PRIVATE_KEY_HEADER_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u;
const CREDENTIAL_ASSIGNMENT_PATTERN = /(?:authorization|authentication|cookie|credential|password|passphrase|private[ _-]?key|secret|token|api[ _-]?key|access[ _-]?key|client[ _-]?secret|refresh[ _-]?token|signature)\s*[:=]\s*\S+/iu;
const SAFE_DISPLAY_RESOURCE_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:", "git+http:", "git+https:", "git+ssh:"]);

export function isCredentialFieldName(value: string): boolean {
  const normalized = value.trim().replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
  return CREDENTIAL_NAME_PATTERN.test(`_${normalized}_`) || /^(?:x-amz|x-goog|x-oss|x-ms)-(?:credential|signature|security-token|algorithm)$/u.test(normalized);
}

export function containsCredentialLikeData(value: string): boolean {
  if (KNOWN_TOKEN_PATTERN.test(value) || JWT_PATTERN.test(value) || BEARER_PATTERN.test(value) ||
    PRIVATE_KEY_PATTERN.test(value) || PRIVATE_KEY_HEADER_PATTERN.test(value) || CREDENTIAL_ASSIGNMENT_PATTERN.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
    for (const [key, queryValue] of url.searchParams) {
      if (isCredentialFieldName(key) || KNOWN_TOKEN_PATTERN.test(queryValue) || JWT_PATTERN.test(queryValue) || BEARER_PATTERN.test(queryValue)) return true;
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return true;
    }
    return KNOWN_TOKEN_PATTERN.test(decodedPath) || JWT_PATTERN.test(decodedPath) || BEARER_PATTERN.test(decodedPath) || CREDENTIAL_ASSIGNMENT_PATTERN.test(decodedPath);
  } catch {
    return false;
  }
}

export function isCredentialSafeText(value: string): boolean {
  return !containsCredentialLikeData(value);
}

export function isCredentialSafeDisplayResource(value: string): boolean {
  if (!isCredentialSafeText(value)) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return true;
  try {
    const url = new URL(value);
    return SAFE_DISPLAY_RESOURCE_PROTOCOLS.has(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function isCredentialSafeValue(value: unknown): boolean {
  if (typeof value === "string") return isCredentialSafeText(value);
  if (Array.isArray(value)) return value.every(isCredentialSafeValue);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .every(([key, child]) => !isCredentialFieldName(key) && isCredentialSafeValue(child));
  }
  return value === null || value === undefined || typeof value === "number" || typeof value === "boolean";
}

export function redactCredentialLikeData(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu, "[redacted private key]")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu, "[redacted private key header]")
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}\b/gu, "[redacted]")
    .replace(/\bglpat-[A-Za-z0-9_-]{8,}\b/gu, "[redacted]")
    .replace(/\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]{8,}\b/gu, "[redacted]")
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9_-]{8,}\b/gu, "[redacted]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer [redacted]")
    .replace(/((?:authorization|authentication|cookie|credential|password|passphrase|private[ _-]?key|secret|token|api[ _-]?key|access[ _-]?key|client[ _-]?secret|refresh[ _-]?token|signature)\s*[:=]\s*)\S+/giu, "$1[redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/giu, "$1");
}
