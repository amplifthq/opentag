import { describe, expect, it } from "vitest";
import { nodeCommandRunner } from "../src/command.js";

describe("nodeCommandRunner stdin EPIPE guard", () => {
  it("resolves without an uncaught EPIPE when a large prompt is written to a child that closes stdin early", async () => {
    // The child reads nothing and exits immediately, closing its stdin while a
    // prompt larger than the OS pipe buffer (~64KB) is still draining. That
    // combination — large input AND an early-exiting child — is what triggers
    // the EPIPE on the writer side. A short prompt would fit in the buffer and
    // never surface the error.
    const largeInput = "x".repeat(1024 * 1024); // 1 MiB, well over the pipe buffer

    let unhandled: unknown;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on("uncaughtException", onUnhandled);
    process.on("unhandledRejection", onUnhandled);

    try {
      const result = await nodeCommandRunner.run(
        process.execPath,
        ["-e", "process.exit(0)"],
        { input: largeInput }
      );

      expect(result.exitCode).toBe(0);

      // Give the event loop a tick so any deferred EPIPE would surface.
      await new Promise((r) => setTimeout(r, 25));
      expect(unhandled).toBeUndefined();
    } finally {
      process.off("uncaughtException", onUnhandled);
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
