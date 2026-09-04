export type ProjectTargetRef = {
  provider: string;
  owner: string;
  repo: string;
};

export type EventMetadataWithProjectTarget = {
  metadata?: Record<string, unknown>;
};

export function formatProjectTargetRef(ref: ProjectTargetRef): string {
  return `${ref.provider}:${ref.owner}/${ref.repo}`;
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
