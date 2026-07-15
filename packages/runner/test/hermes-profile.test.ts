import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/command.js";
import { probeHermesProfile } from "../src/hermes-profile.js";

describe("Hermes profile readiness", () => {
  it("probes the configured fixed profile", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, cwd: options.cwd });
        return { exitCode: 0, stdout: "Hermes Agent v0.18.2", stderr: "" };
      }
    };

    await expect(probeHermesProfile({
      runner,
      hermesCommand: "/opt/hermes/bin/hermes",
      profile: "opentag-review",
      cwd: "/tmp/repository"
    })).resolves.toEqual({ ready: true });
    expect(calls).toEqual([{
      command: "/opt/hermes/bin/hermes",
      args: ["-p", "opentag-review", "--version"],
      cwd: "/tmp/repository"
    }]);
  });

  it("returns actionable guidance when the fixed profile is unavailable", async () => {
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 1, stdout: "", stderr: "Profile 'opentag' does not exist" };
      }
    };

    await expect(probeHermesProfile({ runner, cwd: "/tmp/repository" })).resolves.toEqual({
      ready: false,
      reason:
        "Hermes profile 'opentag' is not ready: Profile 'opentag' does not exist " +
        "Create it with `hermes profile create opentag` or configure daemon.hermes.profile to an existing dedicated profile."
    });
  });
});
