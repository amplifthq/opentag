import { DEFAULT_LINEAR_GRAPHQL_URL } from "./normalize.js";

export type FetchLike = typeof fetch;

export const DEFAULT_LINEAR_REQUEST_TIMEOUT_MS = 15_000;

function linearAuthorizationHeader(token: string): string {
  const trimmed = token.trim();
  if (/^bearer\s+/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("lin_api_")) return trimmed;
  return `Bearer ${trimmed}`;
}

function graphqlOperationName(query: string): string | undefined {
  return query.match(/\b(?:query|mutation)\s+([A-Za-z0-9_]+)/u)?.[1];
}

export async function linearGraphql<T>(input: {
  token: string;
  graphqlUrl?: string;
  query: string;
  variables: Record<string, unknown>;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}): Promise<T> {
  const operationName = graphqlOperationName(input.query);
  const response = await input.fetchImpl(input.graphqlUrl ?? DEFAULT_LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: linearAuthorizationHeader(input.token),
      "content-type": "application/json"
    },
    body: JSON.stringify({ query: input.query, variables: input.variables }),
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_LINEAR_REQUEST_TIMEOUT_MS)
  });
  const payload = (await response.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message?: string } | null | undefined> };
  if (!response.ok || payload.errors?.length) {
    const errorMessage = payload.errors?.map((error) => error?.message).filter(Boolean).join("; ");
    throw new Error(`Linear GraphQL${operationName ? ` ${operationName}` : ""} failed: ${response.status} ${errorMessage ?? "unknown_error"}`);
  }
  if (!payload.data) {
    throw new Error(`Linear GraphQL${operationName ? ` ${operationName}` : ""} returned no data.`);
  }
  return payload.data;
}
