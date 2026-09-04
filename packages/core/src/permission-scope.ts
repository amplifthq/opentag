const REPOSITORY_FREE_PERMISSION_SCOPES: ReadonlySet<string> = new Set([
  "chat:postMessage",
  "reactions:write",
  "runner:local",
  "agent:activity",
  "network:restricted"
]);

export function isRepositoryFreePermissionScope(scope: string): boolean {
  return REPOSITORY_FREE_PERMISSION_SCOPES.has(scope);
}
