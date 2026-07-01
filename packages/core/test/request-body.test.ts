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
});
