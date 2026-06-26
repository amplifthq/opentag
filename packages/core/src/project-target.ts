export type ProjectTargetRef = {
  provider: string;
  owner: string;
  repo: string;
};

export type EventMetadataWithProjectTarget = {
  metadata?: Record<string, unknown>;
};

const PROJECT_TARGET_REF_PATTERN = /^(?:([\w-]+):)?([\w.-]+)\/([\w.-]+)$/;

function normalizeLocalPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function safeProjectSegment(value: string, fallback: string): string {
  const safe = value
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || fallback;
}

function basename(path: string): string {
  const segments = normalizeLocalPath(path).split("/").filter(Boolean);
  return segments.at(-1) ?? "project";
}

function stableHash(value: string): string {
  let first = 0xdeadbeef ^ value.length;
  let second = 0x41c6ce57 ^ value.length;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }

  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);

  return `${(second >>> 0).toString(36)}${(first >>> 0).toString(36)}`.slice(0, 12);
}

export function formatProjectTargetRef(ref: ProjectTargetRef): string {
  return `${ref.provider}:${ref.owner}/${ref.repo}`;
}

export function parseProjectTargetRef(value: string): ProjectTargetRef {
  const match = value.match(PROJECT_TARGET_REF_PATTERN);
  if (!match) {
    throw new Error(`Invalid Project Target ref: ${value}`);
  }
  return {
    provider: match[1] ?? "github",
    owner: match[2] as string,
    repo: match[3] as string
  };
}

function nonBlankMetadataString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function projectTargetRefFromEvent(input: EventMetadataWithProjectTarget | null | undefined): ProjectTargetRef | null {
  const metadata = input?.metadata;
  if (!metadata) return null;

  const owner = nonBlankMetadataString(metadata["owner"]);
  const repo = nonBlankMetadataString(metadata["repo"]);
  if (!owner || !repo) return null;

  const rawProvider = metadata["repoProvider"];
  const provider = rawProvider === undefined ? "github" : nonBlankMetadataString(rawProvider);
  if (!provider) return null;

  return {
    provider,
    owner,
    repo
  };
}

export function projectTargetRefFromLocalPath(path: string): ProjectTargetRef {
  const normalizedPath = normalizeLocalPath(path);
  return {
    provider: "local",
    owner: `path_${stableHash(normalizedPath)}`,
    repo: safeProjectSegment(basename(path), "project")
  };
}
