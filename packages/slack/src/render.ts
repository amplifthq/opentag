import type { OpenTagRunResult } from "@opentag/core";

export type SlackTextBlock = {
  type: "section";
  text: {
    type: "mrkdwn";
    text: string;
  };
};

export type SlackDividerBlock = {
  type: "divider";
};

export type SlackBlock = SlackTextBlock | SlackDividerBlock;

export type SlackMessagePayload = {
  channel: string;
  text: string;
  thread_ts?: string;
  ts?: string;
  blocks?: SlackBlock[];
};

function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function markdownToSlackMrkdwn(text: string): string {
  const links: string[] = [];
  const withoutLinks = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    const token = `\u0000SLACK_LINK_${links.length}\u0000`;
    links.push(`<${url}|${escapeSlackText(label)}>`);
    return token;
  });
  const converted = escapeSlackText(withoutLinks)
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*");
  return links.reduce((output, link, index) => output.replace(`\u0000SLACK_LINK_${index}\u0000`, link), converted);
}

export function renderSlackAcknowledgement(runId: string): string {
  return `I picked this up: \`${runId}\``;
}

export function renderSlackFinalResult(result: OpenTagRunResult): string {
  const lines = [`Finished with *${result.conclusion}*.`, "", markdownToSlackMrkdwn(result.summary)];

  if (result.verification?.length) {
    lines.push("", "*Verification*");
    for (const check of result.verification) {
      lines.push(`- \`${check.command}\`: ${check.outcome}`);
    }
  }

  if (result.nextAction) {
    lines.push("", `*Next action*: ${markdownToSlackMrkdwn(result.nextAction)}`);
  }

  return lines.join("\n");
}

export function createSlackFinalResultBlocks(result: OpenTagRunResult): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Finished with ${result.conclusion}.*\n${markdownToSlackMrkdwn(result.summary)}`
      }
    }
  ];

  if (result.verification?.length) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: markdownToSlackMrkdwn(["*Verification*", ...result.verification.map((check) => `- \`${check.command}\`: ${check.outcome}`)].join("\n"))
      }
    });
  }

  if (result.nextAction) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Next action*: ${markdownToSlackMrkdwn(result.nextAction)}`
      }
    });
  }

  return blocks;
}

export function createSlackPostMessagePayload(input: { channelId: string; text: string; threadTs: string; blocks?: SlackBlock[] }): SlackMessagePayload {
  return {
    channel: input.channelId,
    text: markdownToSlackMrkdwn(input.text),
    thread_ts: input.threadTs,
    ...(input.blocks?.length ? { blocks: input.blocks } : {})
  };
}

export function createSlackUpdateMessagePayload(input: { channelId: string; text: string; messageTs: string; blocks?: SlackBlock[] }): SlackMessagePayload {
  return {
    channel: input.channelId,
    text: markdownToSlackMrkdwn(input.text),
    ts: input.messageTs,
    ...(input.blocks?.length ? { blocks: input.blocks } : {})
  };
}
