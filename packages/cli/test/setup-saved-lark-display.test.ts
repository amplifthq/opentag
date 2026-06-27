import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatSavedLarkCredentialsHint } from "../src/platforms/lark/display.js";
import { runSetupCommand } from "../src/setup.js";
import type { PromptAdapter, PromptOption } from "../src/ui/prompts.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function testPrompts(overrides: Partial<PromptAdapter> = {}): PromptAdapter {
  return {
    intro() {},
    outro() {},
    note() {},
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
    },
    ...overrides
  };
}

describe("saved Lark Personal Agent display", () => {
  it("shows safe details for the saved Lark Personal Agent choice", async () => {
    const projectPath = tempDir();
    const configPath = join(tempDir(), "config.json");
    const legacyDirectory = join(projectPath, ".opentag", "lark");
    mkdirSync(legacyDirectory, { recursive: true });
    const legacyConfigPath = join(legacyDirectory, "lark.local.json");
    writeFileSync(
      legacyConfigPath,
      `${JSON.stringify({
        appId: "cli_1234567890abcdef",
        appSecret: "legacy_secret_should_not_render",
        domain: "feishu",
        botOpenId: "ou_abcdef1234567890"
      })}\n`
    );
    chmodSync(legacyConfigPath, 0o600);

    let savedHint: string | undefined;
    const notes: string[] = [];

    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        language: "en",
        platform: "lark",
        executor: "echo",
        start: false,
        force: true
      },
      {
        prompts: testPrompts({
          note(message) {
            notes.push(message);
          },
          async select(input) {
            if (input.message === "How should OpenTag connect to Lark / Feishu?") {
              savedHint = input.options.find((option) => option.value === "saved")?.hint;
              return "saved";
            }
            return input.initialValue ?? input.options[0]!.value;
          }
        })
      }
    );

    const expectedSummary =
      "Feishu | App ID cli_12...abcdef | Bot Open ID ou_abc...567890 | from legacy start-lark config";
    expect(savedHint).toBe(expectedSummary);
    expect(savedHint).not.toContain("legacy_secret_should_not_render");

    const reviewNote = notes.find((note) => note.includes("Review your OpenTag setup:")) ?? "";
    expect(reviewNote).toContain(`Personal Agent: ${expectedSummary}`);
    expect(reviewNote).not.toContain("legacy_secret_should_not_render");
  });

  it("formats saved Lark Personal Agent details in Chinese without rendering secrets", () => {
    const hint = formatSavedLarkCredentialsHint(
      {
        appId: "cli_1234567890abcdef",
        appSecret: "secret_should_not_render",
        domain: "lark",
        botOpenId: "ou_abcdef1234567890",
        source: "opentag_config"
      },
      "zh-CN"
    );

    expect(hint).toBe("Lark | App ID cli_12...abcdef | Bot Open ID ou_abc...567890 | 来源: OpenTag 配置");
    expect(hint).not.toContain("secret_should_not_render");
  });
});
