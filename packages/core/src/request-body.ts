export const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const DEFAULT_REQUEST_BODY_READ_TIMEOUT_MS = 10_000;

export class RequestBodyTooLargeError extends Error {
  readonly maxBytes: number;
  readonly contentLength?: number;

  constructor(input: { maxBytes: number; contentLength?: number }) {
    super(`Request body exceeds ${input.maxBytes} byte(s).`);
    this.name = "RequestBodyTooLargeError";
    this.maxBytes = input.maxBytes;
    if (input.contentLength !== undefined) {
      this.contentLength = input.contentLength;
    }
  }
}

export class RequestBodyReadTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(input: { timeoutMs: number }) {
    super(`Request body read timed out after ${input.timeoutMs}ms.`);
    this.name = "RequestBodyReadTimeoutError";
    this.timeoutMs = input.timeoutMs;
  }
}

async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  remainingMs: number,
  configuredTimeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (remainingMs <= 0) {
    await reader.cancel();
    throw new RequestBodyReadTimeoutError({ timeoutMs: configuredTimeoutMs });
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          void reader.cancel();
          reject(new RequestBodyReadTimeoutError({ timeoutMs: configuredTimeoutMs }));
        }, remainingMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function readRequestTextWithLimit(
  request: Request,
  input: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<string> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_REQUEST_BODY_READ_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new RequestBodyTooLargeError({ maxBytes, contentLength: parsedLength });
    }
  }

  const stream = request.body;
  if (!stream) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await readChunkWithTimeout(reader, deadlineAt - Date.now(), timeoutMs);
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError({ maxBytes });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
