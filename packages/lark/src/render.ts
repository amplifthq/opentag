import {
  createFinalSummaryPresentation,
  type OpenTagActionReceiptPresentation,
  type OpenTagDoctorCheckPresentation,
  type OpenTagDoctorSummaryPresentation,
  type OpenTagFinalSummaryPresentation,
  type OpenTagPresentationAction,
  type OpenTagRunStatusPresentation,
  type OpenTagRunResult,
  type OpenTagSourceThreadStatusPresentation
} from "@opentag/core";

export type LarkCardText = {
  tag: "plain_text" | "lark_md";
  content: string;
};

export type LarkCardElement =
  | {
      tag: "div";
      text: LarkCardText;
    }
  | {
      tag: "hr";
    }
  | {
      tag: "note";
      elements: LarkCardText[];
    };

export type LarkCard = {
  config: {
    wide_screen_mode: boolean;
    update_multi?: boolean;
  };
  header: {
    template: "green" | "red" | "yellow" | "blue" | "grey";
    title: {
      tag: "plain_text";
      content: string;
    };
  };
  elements: LarkCardElement[];
};

export type LarkRenderOptions = {
  auditRunId?: string;
};

function larkPlain(value: string): string {
  return value.replace(/`/g, "");
}

function auditCommand(runId: string): string {
  return `opentag status --run ${runId}`;
}

export function renderLarkAcknowledgement(runId: string): string {
  return ["Received. OpenTag is working.", `Run: ${runId}`, `Use /status here for queue state; audit locally with ${auditCommand(runId)}.`].join("\n");
}

export function renderLarkRunStatusPresentation(presentation: OpenTagRunStatusPresentation): string {
  if (presentation.state === "received") {
    return renderLarkAcknowledgement(presentation.runId);
  }
  if (presentation.state === "queued") {
    return ["Queued behind an active run.", `Run: ${presentation.runId}`, "Use /status here for queue details."].join("\n");
  }
  if (presentation.state === "waiting_for_approval") {
    return ["Waiting for your review.", `Run: ${presentation.runId}`, "Review the action receipt in this thread, or use /status here for details."].join("\n");
  }
  if (presentation.state === "running") {
    return [presentation.message ?? "OpenTag is working.", `Run: ${presentation.runId}`, "Use /status here for details."].join("\n");
  }
  return [
    `OpenTag run ${presentation.state}.`,
    `Run: ${presentation.runId}`,
    ...(presentation.nextAction ? [presentation.nextAction] : [`Audit locally with ${auditCommand(presentation.runId)}.`])
  ].join("\n");
}

function larkRunStatusHeaderTemplate(state: OpenTagRunStatusPresentation["state"]): LarkCard["header"]["template"] {
  if (state === "received" || state === "queued" || state === "running") return "blue";
  if (state === "waiting_for_approval") return "yellow";
  if (state === "completed") return "green";
  if (state === "failed" || state === "timed_out") return "red";
  if (state === "cancelled" || state === "interrupted") return "grey";
  return "blue";
}

function larkRunStatusTitle(state: OpenTagRunStatusPresentation["state"]): string {
  if (state === "received") return "OpenTag received this";
  if (state === "queued") return "OpenTag queued this";
  if (state === "running") return "OpenTag is working";
  if (state === "waiting_for_approval") return "OpenTag is waiting for review";
  return `OpenTag ${state}`;
}

export function createLarkRunStatusCard(presentation: OpenTagRunStatusPresentation): LarkCard {
  const statusText = renderLarkRunStatusPresentation(presentation);
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template: larkRunStatusHeaderTemplate(presentation.state),
      title: {
        tag: "plain_text",
        content: larkRunStatusTitle(presentation.state)
      }
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: statusText
        }
      }
    ]
  };
}

export function renderLarkFinalResult(result: OpenTagRunResult, options: LarkRenderOptions = {}): string {
  return renderLarkFinalSummaryPresentation(
    createFinalSummaryPresentation({
      result,
      ...(options.auditRunId ? { auditRunId: options.auditRunId } : {})
    })
  );
}

export function renderLarkFinalSummaryPresentation(presentation: OpenTagFinalSummaryPresentation): string {
  const lines = [`Finished with ${presentation.outcome}.`, "", presentation.summary];

  if (presentation.verification?.length) {
    lines.push("", "Verification");
    for (const check of presentation.verification) {
      lines.push(`- ${check.command}: ${check.outcome}`);
    }
  }

  if (presentation.nextActions?.length) {
    lines.push("", `Next action: ${presentation.nextActions[0]}`);
  }
  if (presentation.auditRunId) {
    lines.push("", `Audit: opentag status --run ${presentation.auditRunId}`);
  }

  return lines.join("\n");
}

function larkHeaderTemplate(outcome: string): LarkCard["header"]["template"] {
  if (outcome === "success") return "green";
  if (outcome === "failure") return "red";
  if (outcome === "cancelled") return "grey";
  if (outcome === "needs_human") return "blue";
  return "yellow";
}

function compactCardText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function compactMultilineText(text: string, maxLength: number): string {
  const compact = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function larkMarkdownList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function larkSummaryHeading(line: string): string | undefined {
  const trimmed = line.trim();
  const markdownHeading = trimmed.match(/^#{1,6}\s+(.+)$/);
  if (markdownHeading?.[1]) return larkPlain(markdownHeading[1]).trim();
  const boldHeading = trimmed.match(/^\*\*(.+?)\*\*$/);
  if (boldHeading?.[1]) return larkPlain(boldHeading[1]).trim();
  return undefined;
}

function larkPlainSummaryLine(line: string): string {
  return larkPlain(line)
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .trimEnd();
}

function larkSummarySections(summary: string): Array<{ title?: string; content: string }> {
  const sections: Array<{ title?: string; lines: string[] }> = [];
  let current: { title?: string; lines: string[] } = { lines: [] };

  function flush(): void {
    while (current.lines.at(-1) === "") current.lines.pop();
    const content = current.lines.join("\n").trim();
    if (current.title || content) {
      sections.push({ ...(current.title ? { title: current.title } : {}), lines: content ? content.split("\n") : [] });
    }
  }

  for (const rawLine of summary.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) continue;

    const heading = larkSummaryHeading(trimmed);
    if (heading) {
      flush();
      current = { title: heading, lines: [] };
      continue;
    }

    if (trimmed.length === 0) {
      if (current.lines.length > 0 && current.lines.at(-1) !== "") current.lines.push("");
      continue;
    }

    current.lines.push(larkPlainSummaryLine(rawLine).trim());
  }
  flush();

  return sections.map((section) => ({
    ...(section.title ? { title: section.title } : {}),
    content: compactMultilineText(section.lines.join("\n"), 600)
  }));
}

function larkFinalSummaryElements(summary: string): LarkCardElement[] {
  const sections = larkSummarySections(summary);
  const visibleSections = sections.slice(0, 3);
  const elements: LarkCardElement[] = [];

  for (const section of visibleSections) {
    if (section.title) {
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**${section.title}**`
        }
      });
    }
    if (section.content) {
      elements.push({
        tag: "div",
        text: {
          tag: "plain_text",
          content: section.content
        }
      });
    }
  }

  if (sections.length > visibleSections.length) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: "Summary preview truncated. Full detail is available in the audit/status output."
        }
      ]
    });
  }

  return elements.length > 0
    ? elements
    : [
        {
          tag: "div",
          text: {
            tag: "plain_text",
            content: compactMultilineText(larkPlain(summary), 900)
          }
        }
      ];
}

function larkActionDecisionLabel(decision: OpenTagPresentationAction["visibleDecisions"][number], index: number): string {
  if (decision === "apply") return `Apply now: apply ${index}`;
  if (decision === "approve") return `Approve only: approve ${index}`;
  if (decision === "continue") return `Continue: continue ${index}`;
  return `Reject: reject ${index}`;
}

function larkActionDetails(action: OpenTagPresentationAction): string[] {
  const rowDetails = action.detailRows?.map((row) => `${row.label}: ${larkPlain(row.value)}`) ?? [];
  if (rowDetails.length > 0) return rowDetails.map((detail) => compactCardText(detail, 180));

  const details = [`Target: ${action.targetLabel}`];
  if (action.setupReason) details.push(`Status: ${action.setupReason}`);
  if (action.details?.length) details.push(...action.details.slice(0, 3));
  return details.map((detail) => compactCardText(larkPlain(detail), 180));
}

function larkActionReceiptMarkdown(input: { title: string; actions: OpenTagPresentationAction[] }, options: { includeTitle?: boolean } = {}): string | undefined {
  if (input.actions.length === 0) return undefined;
  const visibleActions = input.actions.slice(0, 5);
  const lines = [
    ...(options.includeTitle === false ? [] : [`**${input.title}**`]),
    "Choose a command in this source thread. Details stay in OpenTag audit/status."
  ];
  for (const action of visibleActions) {
    lines.push("", `**${action.index}. ${compactCardText(action.title, 180)}**`);
    lines.push(...larkMarkdownList(larkActionDetails(action)).split("\n"));
    lines.push(...larkMarkdownList(action.visibleDecisions.map((decision) => larkActionDecisionLabel(decision, action.index))).split("\n"));
  }
  const remaining = input.actions.length - visibleActions.length;
  if (remaining > 0) {
    lines.push("", `Showing first ${visibleActions.length} of ${input.actions.length} actions. Use opentag status locally for full detail.`);
  }
  return lines.join("\n");
}

function larkFinalSummaryActionReceiptMarkdown(presentation: OpenTagFinalSummaryPresentation): string | undefined {
  const actions = presentation.actions ?? [];
  if (!presentation.actionReceiptTitle || actions.length === 0) return undefined;
  return larkActionReceiptMarkdown({ title: presentation.actionReceiptTitle, actions });
}

function larkActionReceiptHeaderTemplate(actions: OpenTagPresentationAction[]): LarkCard["header"]["template"] {
  if (actions.some((action) => action.state === "needs_setup" || action.state === "unsupported")) return "yellow";
  if (actions.some((action) => action.state === "ready_to_apply" || action.state === "needs_approval")) return "blue";
  return "grey";
}

export function createLarkFinalSummaryCard(presentation: OpenTagFinalSummaryPresentation): LarkCard {
  const elements: LarkCardElement[] = larkFinalSummaryElements(presentation.summary);

  if (presentation.verification?.length) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: ["**Verification**", larkMarkdownList(presentation.verification.slice(0, 5).map((check) => `${larkPlain(check.command)}: ${check.outcome}`))].join(
          "\n"
        )
      }
    });
  }

  if (presentation.changedFiles?.length) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: ["**Changed files**", larkMarkdownList(presentation.changedFiles.slice(0, 8).map(larkPlain))].join("\n")
      }
    });
  }

  if (presentation.nextActions?.length) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: ["**Next action**", larkMarkdownList(presentation.nextActions.map((action) => compactCardText(action, 240)))].join("\n")
      }
    });
  }

  const actionReceipt = larkFinalSummaryActionReceiptMarkdown(presentation);
  if (actionReceipt) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: actionReceipt
      }
    });
  }

  if (presentation.auditRunId) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: `Audit: opentag status --run ${presentation.auditRunId}`
        }
      ]
    });
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template: larkHeaderTemplate(presentation.outcome),
      title: {
        tag: "plain_text",
        content: `Finished: ${presentation.outcome}`
      }
    },
    elements
  };
}

export function renderLarkActionReceiptPresentation(presentation: OpenTagActionReceiptPresentation): string {
  return [
    presentation.title,
    "",
    larkActionReceiptMarkdown({ title: presentation.title, actions: presentation.actions }, { includeTitle: false }) ?? "No source-thread actions.",
    ...(presentation.auditRunId ? ["", `Audit: opentag status --run ${presentation.auditRunId}`] : [])
  ].join("\n");
}

export function createLarkActionReceiptCard(presentation: OpenTagActionReceiptPresentation): LarkCard {
  const elements: LarkCardElement[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: larkActionReceiptMarkdown({ title: presentation.title, actions: presentation.actions }, { includeTitle: false }) ?? "No source-thread actions."
      }
    }
  ];

  if (presentation.auditRunId) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: `Audit: opentag status --run ${presentation.auditRunId}`
        }
      ]
    });
  }

  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: larkActionReceiptHeaderTemplate(presentation.actions),
      title: {
        tag: "plain_text",
        content: presentation.title.replace(/:$/, "")
      }
    },
    elements
  };
}

function larkDoctorHeaderTemplate(checks: OpenTagDoctorCheckPresentation[]): LarkCard["header"]["template"] {
  if (checks.some((check) => check.status === "fail")) return "red";
  if (checks.some((check) => check.status === "warn" || check.status === "unknown")) return "yellow";
  return "green";
}

function larkStatusHeaderTemplate(presentation: OpenTagSourceThreadStatusPresentation): LarkCard["header"]["template"] {
  if (presentation.bindingState === "unbound") return "yellow";
  if (presentation.activeRun) return "blue";
  return "green";
}

function checkStatusLabel(status: OpenTagDoctorCheckPresentation["status"]): string {
  return status.toUpperCase();
}

export function createLarkDoctorSummaryCard(presentation: OpenTagDoctorSummaryPresentation): LarkCard {
  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: larkDoctorHeaderTemplate(presentation.checks),
      title: {
        tag: "plain_text",
        content: presentation.title.replace(/:$/, "")
      }
    },
    elements: presentation.checks.map((check) => ({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**${checkStatusLabel(check.status)} ${check.name}**${check.message ? `\n${compactCardText(check.message, 500)}` : ""}`
      }
    }))
  };
}

export function createLarkSourceThreadStatusCard(presentation: OpenTagSourceThreadStatusPresentation): LarkCard {
  const elements: LarkCardElement[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          presentation.sourceContainer ? `**Source container**\n${presentation.sourceContainer}` : undefined,
          `**Project Target**\n${presentation.projectTarget ?? "not bound"}`,
          `**Active run**\n${
            presentation.activeRun
              ? `${presentation.activeRun.id} (${presentation.activeRun.status})${
                  presentation.activeRun.updatedAt ? `, updated ${presentation.activeRun.updatedAt}` : ""
                }`
              : "none"
          }`,
          presentation.currentCommand ? `**Command**\n${compactCardText(presentation.currentCommand, 240)}` : undefined
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n\n")
      }
    }
  ];

  const queuedTotal = presentation.queuedFollowUpsTotal ?? presentation.queuedFollowUps.length;
  const queuedIds = presentation.queuedFollowUps.map((followUp) => {
    const status = followUp.status ? ` (${followUp.status})` : "";
    const command = followUp.command ? `: ${compactCardText(followUp.command, 120)}` : "";
    return `${followUp.id}${status}${command}`;
  });
  const queuedOverflow = Math.max(queuedTotal - queuedIds.length, 0);
  const queuedSummary =
    queuedTotal === 0
      ? "none"
      : `${queuedTotal}${queuedIds.length ? ` (${queuedIds.join(", ")}${queuedOverflow > 0 ? `, +${queuedOverflow} more` : ""})` : ""}`;

  elements.push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: ["**Queued follow-ups**", queuedSummary, "", "**Next action**", compactCardText(presentation.nextAction, 360)].join("\n")
    }
  });

  if (presentation.stopHint || presentation.detailHint) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: [presentation.stopHint ? `Stop/timeout: ${presentation.stopHint}` : undefined, presentation.detailHint ? `Details: ${presentation.detailHint}` : undefined]
            .filter((line): line is string => Boolean(line))
            .join(" ")
        }
      ]
    });
  }

  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: larkStatusHeaderTemplate(presentation),
      title: {
        tag: "plain_text",
        content: presentation.title.replace(/:$/, "")
      }
    },
    elements
  };
}

// Lark text message content is a JSON-encoded `{ "text": "..." }` string.
export function createLarkTextMessageContent(text: string): string {
  return JSON.stringify({ text });
}

// Lark interactive message content is a JSON-encoded card object.
export function createLarkInteractiveMessageContent(card: LarkCard): string {
  return JSON.stringify(card);
}
