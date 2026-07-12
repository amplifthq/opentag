#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const mode = process.env.OPENTAG_ACP_TEST_MODE ?? "success";

if (mode === "malformed-live") {
  await writeFile(join(process.cwd(), "acp-child-pid.txt"), `${process.pid}\n`);
  process.stdout.write("this is not an ACP frame\n");
  await new Promise(() => undefined);
}

if (mode === "child-exit") {
  process.stderr.write("SENTINEL_CHILD_STDERR_SECRET\n");
  process.exit(7);
}

const sessions = new Map();

async function record(cwd, name, value) {
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, name), `${JSON.stringify(value, null, 2)}\n`);
}

const app = acp
  .agent({ name: "opentag-test-agent" })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "opentag-test-agent", version: "1.0.0" }
  }))
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    if (mode === "delay-session") {
      await record(ctx.params.cwd, "acp-session-new-started.json", { started: true });
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { cwd: ctx.params.cwd, cancelled: false });
    await record(ctx.params.cwd, "acp-session.json", {
      cwd: ctx.params.cwd,
      mcpServers: ctx.params.mcpServers,
      pid: process.pid,
      inheritedSecret: process.env.OPENTAG_ACP_HOST_SECRET ?? null,
      explicitValue: process.env.OPENTAG_ACP_EXPLICIT ?? null
    });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw new Error("unknown test session");
    const text = ctx.params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    await record(session.cwd, "acp-prompt.json", { text });

    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Complete the OpenTag run", priority: "high", status: "in_progress" }]
      }
    });
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: process.env.OPENTAG_ACP_TEST_TOOL_TITLE ?? "Write ACP output",
        kind: "edit",
        status: "in_progress"
      }
    });

    if (mode === "permission") {
      const permission = await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId: ctx.params.sessionId,
        toolCall: {
          toolCallId: "material-1",
          title: process.env.OPENTAG_ACP_TEST_PERMISSION_TITLE ?? "Publish report",
          kind: "execute",
          status: "pending",
          rawInput: {
            provider: process.env.OPENTAG_ACP_TEST_PROVIDER ?? "npm",
            connectionId: process.env.OPENTAG_ACP_TEST_CONNECTION ?? "npm:team",
            package: process.env.OPENTAG_ACP_TEST_RESOURCE ?? "@acme/report",
            tag: process.env.OPENTAG_ACP_TEST_VERSION ?? "next",
            ...(process.env.OPENTAG_ACP_TEST_ENVIRONMENT ? { environment: process.env.OPENTAG_ACP_TEST_ENVIRONMENT } : {}),
            ...(process.env.OPENTAG_ACP_TEST_FORCE ? { force: process.env.OPENTAG_ACP_TEST_FORCE === "true" } : {}),
            ...(process.env.OPENTAG_ACP_TEST_VISIBILITY ? { visibility: process.env.OPENTAG_ACP_TEST_VISIBILITY } : {}),
            authorization: `Bearer ${process.env.OPENTAG_ACP_TEST_SECRET ?? "fixture-secret-token"}`
          }
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-run", name: "Allow for session", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" }
        ]
      });
      await record(session.cwd, "acp-permission.json", permission);
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "material-1",
          status: "completed"
        }
      });
    }

    if (mode === "cancel" || mode === "cancel-notify-failure") {
      await writeFile(join(session.cwd, "acp-output.txt"), "recoverable cancellation delta\n");
      await record(session.cwd, "acp-waiting.json", { waiting: true });
      if (mode === "cancel-notify-failure") process.stdin.destroy();
      while (!session.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await record(session.cwd, "acp-cancelled.json", { cancelled: true });
      return { stopReason: "cancelled" };
    }

    await writeFile(join(session.cwd, "acp-output.txt"), "created by the ACP fixture\n");
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed"
      }
    });
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: process.env.OPENTAG_ACP_TEST_OUTPUT ?? "ACP fixture completed the requested work."
        }
      }
    });
    return { stopReason: mode === "refusal" ? "refusal" : "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (session) session.cancelled = true;
  });

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
await app.connect(stream);
