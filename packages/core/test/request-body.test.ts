import { describe, expect, it } from "vitest";
import { RequestBodyTooLargeError, readRequestTextWithLimit } from "../src/request-body.js";

describe("request body helpers", () => {
  it("reads text bodies up to the configured byte limit", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: "hello"
    });

    await expect(readRequestTextWithLimit(request, { maxBytes: 5 })).resolves.toBe("hello");
  });

  it("rejects streamed bodies after the configured byte limit", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: "hello!"
    });

    await expect(readRequestTextWithLimit(request, { maxBytes: 5 })).rejects.toMatchObject({
      name: "RequestBodyTooLargeError",
      maxBytes: 5
    });
  });

  it("rejects oversized Content-Length headers before reading", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-length": "6" }
    });

    await expect(readRequestTextWithLimit(request, { maxBytes: 5 })).rejects.toBeInstanceOf(
      RequestBodyTooLargeError
    );
  });

  it("rejects stalled body reads after the configured timeout", async () => {
    const request = {
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
          cancel: async () => undefined,
          releaseLock: () => undefined
        })
      }
    } as unknown as Request;

    await expect(readRequestTextWithLimit(request, { maxBytes: 5, timeoutMs: 5 })).rejects.toMatchObject({
      name: "RequestBodyReadTimeoutError",
      timeoutMs: 5
    });
  });
});
