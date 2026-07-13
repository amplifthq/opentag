const REPOSITORY_FREE_PERMISSION_SCOPES: ReadonlySet<string> = new Set([
  "chat:postMessage",
  "reactions:write",
  "runner:local",
  "issue:create",
  "issue:comment",
  "agent:activity",
  "network:restricted"
]);

export function isRepositoryFreePermissionScope(scope: string): boolean {
  return REPOSITORY_FREE_PERMISSION_SCOPES.has(scope);
}
