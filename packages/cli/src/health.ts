async function fetchWithTimeout(input: {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<Response> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    return await fetchImpl(input.url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeRelayHealth(input: {
  relayUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<boolean> {
  const healthUrl = `${input.relayUrl.replace(/\/$/u, "")}/healthz`;
  try {
    const response = await fetchWithTimeout({
      url: healthUrl,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      timeoutMs: input.timeoutMs,
    });
    return response.ok;
  } catch {
    return false;
  }
}
