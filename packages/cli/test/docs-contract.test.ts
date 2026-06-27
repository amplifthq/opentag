import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("platform setup docs contract", () => {
  it("keeps Slack setup docs aligned with the official Socket Mode and Events API requirements", () => {
    const english = repoFile("docs/platforms/slack.en.md");
    const chinese = repoFile("docs/platforms/slack.zh-CN.md");
    const combined = `${english}\n${chinese}`;

    expect(combined).toContain("https://docs.slack.dev/apis/events-api/using-socket-mode/");
    expect(combined).toContain("https://docs.slack.dev/authentication/verifying-requests-from-slack/");
    expect(combined).toContain("https://api.slack.com/apps");
    expect(combined).toContain("connections:write");
    expect(combined).toContain("app_mentions:read");
    expect(combined).toContain("chat:write");
    expect(combined).toContain("app_mention");
    expect(combined).toContain("Do not enter a Request URL for Socket Mode");
    expect(combined).toContain("Socket Mode 不需要填写 Request URL");
    expect(combined).toContain("GitHub repository target");
    expect(combined).toContain("GitHub token");
  });

  it("keeps GitHub setup docs aligned with webhook, token, and apply-1 pull request requirements", () => {
    const english = repoFile("docs/platforms/github.en.md");
    const chinese = repoFile("docs/platforms/github.zh-CN.md");
    const combined = `${english}\n${chinese}`;

    expect(combined).toContain("https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks");
    expect(combined).toContain("https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries");
    expect(combined).toContain("https://github.com/settings/personal-access-tokens/new");
    expect(combined).toContain("Issue comments");
    expect(combined).toContain("Pull request review comments");
    expect(combined).toContain("Issues");
    expect(combined).toContain("Pull requests");
    expect(combined).toContain("apply 1");
    expect(combined).toContain("Content type");
    expect(combined).toContain("application/json");
  });
});
