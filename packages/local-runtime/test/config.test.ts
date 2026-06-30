import { describe, expect, it } from "vitest";
import { parseDaemonConfig } from "../src/config.js";

const baseRepository = {
  owner: "acme",
  repo: "widgets",
  checkoutPath: "/tmp/acme-widgets"
};

describe("parseDaemonConfig defaultExecutor", () => {
  it("accepts the built-in executors", () => {
    for (const executor of ["echo", "codex", "claude-code", "hermes"]) {
      const config = parseDaemonConfig({
        repositories: [{ ...baseRepository, defaultExecutor: executor }]
      });
      expect(config.repositories[0].defaultExecutor).toBe(executor);
    }
  });

  it("accepts a custom executor id so standalone runners can register their own", () => {
    const config = parseDaemonConfig({
      repositories: [{ ...baseRepository, defaultExecutor: "custom-runner" }]
    });
    expect(config.repositories[0].defaultExecutor).toBe("custom-runner");
  });

  it("trims executor ids before storing them", () => {
    const config = parseDaemonConfig({
      repositories: [{ ...baseRepository, defaultExecutor: " custom-runner " }]
    });
    expect(config.repositories[0].defaultExecutor).toBe("custom-runner");
  });

  it("defaults defaultExecutor to echo when omitted", () => {
    const config = parseDaemonConfig({ repositories: [{ ...baseRepository }] });
    expect(config.repositories[0].defaultExecutor).toBe("echo");
  });

  it("rejects an empty executor id", () => {
    expect(() =>
      parseDaemonConfig({
        repositories: [{ ...baseRepository, defaultExecutor: "" }]
      })
    ).toThrow();
  });

  it("rejects a whitespace-only executor id", () => {
    expect(() =>
      parseDaemonConfig({
        repositories: [{ ...baseRepository, defaultExecutor: "   " }]
      })
    ).toThrow();
  });
});

describe("parseDaemonConfig Hermes config", () => {
  it("trims Hermes config strings", () => {
    const config = parseDaemonConfig({
      repositories: [{ ...baseRepository, defaultExecutor: "hermes" }],
      hermes: {
        command: " custom-hermes ",
        profile: " opentag-fixed ",
        profileTemplate: " opentag-{provider}-{owner}-{repo} "
      }
    });

    expect(config.hermes).toEqual({
      command: "custom-hermes",
      profile: "opentag-fixed",
      profileTemplate: "opentag-{provider}-{owner}-{repo}"
    });
  });

  it("rejects whitespace-only Hermes config strings", () => {
    expect(() =>
      parseDaemonConfig({
        repositories: [{ ...baseRepository, defaultExecutor: "hermes" }],
        hermes: {
          profileTemplate: "   "
        }
      })
    ).toThrow();
  });
});
