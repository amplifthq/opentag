import { describe, expect, it } from "vitest";
import { formatPlatformCapabilityCatalog, formatPlatformsCommandOutput, runPlatformsCommand } from "../src/commands/platforms.js";

describe("platform catalog command", () => {
  it("formats platform runtime capabilities next to setup support", () => {
    const output = formatPlatformsCommandOutput();

    expect(output).toContain("CLI setup support:");
    expect(output).toContain("Lark / Feishu: Setup wizard ready");
    expect(output).toContain("Telegram: Setup wizard ready");
    expect(output).toContain("Discord: Setup wizard ready");
    expect(output).toContain("Platform capabilities:");
    expect(output).toContain("Lark / Feishu: events=yes");
    expect(output).toContain("Slack: events=yes");
    expect(output).toContain("GitHub: events=yes");
    expect(output).toContain("Linear: events=yes");
    expect(output).toContain("Telegram: events=yes");
    expect(output).toContain("Discord: events=yes");
    expect(output).toContain("rich=yes");
    expect(output).toContain("liveness=");
  });

  it("routes command output through the supplied logger", () => {
    const lines: unknown[] = [];

    runPlatformsCommand({
      logger: {
        log(message) {
          lines.push(message);
        }
      }
    });

    expect(lines).toHaveLength(1);
    expect(String(lines[0])).toContain(formatPlatformCapabilityCatalog());
  });
});
