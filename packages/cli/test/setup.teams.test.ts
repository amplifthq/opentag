import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePlatformId } from "../src/catalogs/platforms.js";
import { readCliConfig } from "../src/config.js";
import { runSetupCommand } from "../src/setup.js";
import type { PromptAdapter, PromptOption } from "../src/ui/prompts.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function testPrompts(notes: string[] = []): PromptAdapter {
  return {
    intro() {},
    outro() {},
    note(message) {
      notes.push(message);
    },
    async select<Value extends string>(input: { options: Array<PromptOption<Value>>; initialValue?: Value }): Promise<Value> {
      return input.initialValue ?? input.options[0]!.value;
    },
    async text(input) {
      return input.initialValue ?? "";
    },
    async password() {
      return "secret_prompt";
    },
    async confirm() {
      return true;
    }
  };
}

describe("teams platform catalog", () => {
  it("parses teams as a known platform id", () => {
    expect(parsePlatformId("teams")).toBe("teams");
  });
});

describe("OpenTag CLI setup Teams platform", () => {
  it("writes a Microsoft Teams config from scripted setup", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "teams",
        executor: "echo",
        teamsAppId: "teams_app_id",
        teamsAppPassword: "teams_app_password",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.teams).toEqual({
      appId: "teams_app_id",
      appPassword: "teams_app_password",
      webhookPath: "/teams/messages"
    });
    expect(config.preferences?.lastSetup).toMatchObject({
      platforms: ["teams"]
    });
  });
});
