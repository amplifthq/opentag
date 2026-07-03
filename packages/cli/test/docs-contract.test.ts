import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("platform setup docs contract", () => {
  it("keeps the agent-readable install guide aligned with OpenTag source-thread boundaries", () => {
    const guide = repoFile("docs/agent-install.md");
    const readme = repoFile("README.md");
    const normalizedGuide = guide.replace(/\s+/g, " ");

    expect(readme).toContain("[Agent-readable install guide](docs/agent-install.md)");
    expect(guide).toContain("OpenTag is a source-thread action layer for coding agents");
    expect(normalizedGuide).toContain("OpenTag is not a general chat remote-control cockpit");
    expect(guide).toContain("Project Target");
    expect(guide).toContain("RunScope");
    expect(guide).toContain("Readiness");
    expect(guide).toContain("OpenTagRunResult.artifacts");
    expect(normalizedGuide).toContain("patches, reports, screenshots, log summaries, and pull request links");
    expect(guide).toContain("opentag platforms");
    expect(guide).toContain("opentag executors");
    expect(guide).toContain("opentag service status");
    expect(guide).toContain("opentag doctor");
    expect(guide).toContain("opentag status");
    expect(guide).toContain("Keep external runtime integration on OpenTag-owned APIs and data shapes.");
    expect(normalizedGuide).toContain("run lifecycle, idempotency key, terminal semantics, audit visibility");
    expect(guide).toContain("runner-scoped authentication");
    expect(guide).not.toContain("register_ack");
    expect(guide).not.toContain("ws://");
  });

  it("keeps the OpenTag skill aligned with Codex askhuman setup guidance", () => {
    const skill = repoFile("skills/opentag/SKILL.md");

    expect(skill).toContain("request_user_input");
    expect(skill).toContain("askhuman");
    expect(skill).toContain("Codex Plan mode");
    expect(skill).toContain("Codex Default mode cannot render askhuman choice cards");
    expect(skill).toContain("runtime-provided Plan-mode transition");
    expect(skill).toContain("askhuman cannot render from Default mode");
    expect(skill).toContain("Do not claim a Plan-mode handoff happened");
    expect(skill).toContain("do not ask the user to switch modes");
    expect(skill).toContain("do not ask the same choices in plain text");
    expect(skill).toContain("do not present a plain-text fallback");
    expect(skill).toContain("do not continue with CLI defaults");
    expect(skill).toContain("Never request secrets through askhuman");
    expect(skill).toContain("Do not ask setup users to run `codex exec` directly");
    expect(skill).toContain("check `codex exec --help` first");
    expect(skill).toContain("only use flags that the installed Codex version advertises");
    expect(skill).toContain("Npm Registry And Network Failures");
    expect(skill).toContain("ENOTFOUND");
    expect(skill).toContain("EAI_AGAIN");
    expect(skill).toContain("ETIMEDOUT");
    expect(skill).toContain("ECONNRESET");
    expect(skill).toContain("TLS certificate errors");
    expect(skill).toContain("npm config get registry");
    expect(skill).toContain("npm config get proxy");
    expect(skill).toContain("npm config get https-proxy");
    expect(skill).toContain("registry.npmjs.org");
    expect(skill).toContain("npm view @opentag/cli version --fetch-timeout=15000");
    expect(skill).toContain("proxy-scoped npm registry retry");
    expect(skill).toContain(
      'HTTPS_PROXY="<proxy-url>" HTTP_PROXY="<proxy-url>" npm view @opentag/cli version --fetch-timeout=15000'
    );
    expect(skill).toContain("Only after npm registry metadata is reachable");
    expect(skill).toContain("npx --yes @opentag/cli --help");
    expect(skill).toContain("do not permanently change `npm config` without explicit user confirmation");
    expect(skill).toContain("Only use a proxy URL the user provides or that is already active in the environment");
    expect(skill).toContain("npm cache metadata exists");
    expect(skill).toContain("`npx --offline` or `npm pack --offline`");
    expect(skill).toContain("do not claim the CLI is available offline");
    expect(skill).toContain("Platform: Slack, GitHub, Lark / Feishu, or LINE Messenger");
    expect(skill).toContain("Coding agent: Codex, Claude Code, or Echo");
    expect(skill).toContain("Local project: the current working directory");
    expect(skill).toContain("Slack Socket Mode vs Events API");
    expect(skill).toContain("Lark / Feishu tenant for manual app setup");
    expect(skill).toContain("Lark scan vs manual setup");
    expect(skill).toContain("LINE webhook port");
    expect(skill).toContain("default project binding vs bind later");
    expect(skill).toContain("--platform");
    expect(skill).toContain("--executor");
    expect(skill).toContain("--project");
    expect(skill).toContain("--slack-mode");
    expect(skill).toContain("--tenant");
    expect(skill).toContain("--lark-setup");
    expect(skill).toContain("--line-port");
    expect(skill).toContain("--binding");
    expect(skill).toContain(
      "Stop before entering any credential, token, app ID, app secret, signing secret, channel ID, repository name, or unconfirmed project path."
    );
    expect(skill).not.toContain("agent-owned flow control");
    expect(skill).not.toContain("trigger the Codex Plan-mode transition or handoff first");
    expect(skill).not.toContain("ask for the same choices in plain text instead");
  });

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
    expect(combined).toContain("Create from manifest");
    expect(combined).toContain("/invite @OpenTag");
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
    expect(combined).toContain("3050");
    expect(combined).toContain("--github-port");
  });

  it("keeps LINE setup docs aligned with Messaging API webhook requirements", () => {
    const english = repoFile("docs/platforms/line.en.md");
    const chinese = repoFile("docs/platforms/line.zh-CN.md");
    const combined = `${english}\n${chinese}`;

    expect(combined).toContain("https://developers.line.biz/console/");
    expect(combined).toContain("https://developers.line.biz/en/docs/messaging-api/receiving-messages/");
    expect(combined).toContain("https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/");
    expect(combined).toContain("Channel secret");
    expect(combined).toContain("Channel access token");
    expect(combined).toContain("x-line-signature");
    expect(combined).toContain("3070");
    expect(combined).toContain("/line/events/<accountId>");
  });
});
