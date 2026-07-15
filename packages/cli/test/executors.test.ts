import { describe, expect, it } from "vitest";
import { defaultExecutorId, detectExecutors } from "../src/catalogs/executors.js";
import { formatExecutorCapabilityCatalog, formatExecutorsCommandOutput, runExecutorsCommand } from "../src/commands/executors.js";

describe("executor catalog", () => {
  it("uses OPENTAG_HERMES_COMMAND for Hermes detection", () => {
    const detections = detectExecutors({ PATH: "", OPENTAG_HERMES_COMMAND: process.execPath } as NodeJS.ProcessEnv);
    const hermes = detections.find((executor) => executor.id === "hermes");

    expect(hermes).toMatchObject({ available: true, reason: `Found ${process.execPath} on PATH` });
    expect(defaultExecutorId({ detections })).toBe("hermes");
  });

  it("uses OPENTAG_OPENCLAW_COMMAND for OpenClaw detection", () => {
    const detections = detectExecutors({ PATH: "", OPENTAG_OPENCLAW_COMMAND: process.execPath } as NodeJS.ProcessEnv);
    const openclaw = detections.find((executor) => executor.id === "openclaw");

    expect(openclaw).toMatchObject({ available: true, reason: `Found ${process.execPath} on PATH` });
    expect(defaultExecutorId({ detections })).toBe("openclaw");
  });

  it("formats executor runtime capabilities next to executor availability", () => {
    const output = formatExecutorsCommandOutput({ PATH: "" } as NodeJS.ProcessEnv);

    expect(output).toContain("Coding agents:");
    expect(output).toContain("Codex: needs setup (Could not find npx on PATH; pinned package @agentclientprotocol/codex-acp@1.1.2 needs setup)");
    expect(output).toContain("Claude Code: needs setup (Could not find npx on PATH; pinned package @agentclientprotocol/claude-agent-acp@0.59.0 needs setup)");
    expect(output).toContain("Cursor: not found (Could not find cursor-agent on PATH)");
    expect(output).toContain("OpenCode: needs setup (Could not find npx on PATH; pinned package opencode-ai@1.18.1 needs setup)");
    expect(output).toContain("OpenClaw: not found (Could not find openclaw on PATH)");
    expect(output).toContain("Echo: dev/test only");
    expect(output).toContain("Executor capabilities:");
    const capabilityLines = output.split("\n").filter((line) => line.includes("invocation=")).map((line) => line.trim());
    const lineFor = (label: string) => capabilityLines.find((line) => line.startsWith(`${label}:`)) ?? "";
    const codex = lineFor("Codex");
    expect(codex).toContain("invocation=spawn, profile=no, streaming=yes, cancel=yes");
    expect(codex).toContain("progress=audit, approval=opentag_policy");
    expect(codex).toContain("context=context_packet,context_pointers,workspace");
    expect(codex).toContain("prompt=opentag, write=workspace, conversation=request");
    expect(codex).toContain("prompt_mutation=none, raw_context=no, write_actions=propose");
    expect(codex).toContain("secrets=none, completion=stream_event");
    expect(lineFor("Hermes")).toContain("profile=yes, streaming=yes, cancel=yes");
    expect(lineFor("OpenClaw")).toContain("profile=yes, streaming=yes, cancel=no");
  });

  it("routes command output through the supplied logger", () => {
    const lines: unknown[] = [];

    runExecutorsCommand({
      env: { PATH: "" } as NodeJS.ProcessEnv,
      logger: {
        log(message) {
          lines.push(message);
        }
      }
    });

    expect(lines).toHaveLength(1);
    expect(String(lines[0])).toContain(formatExecutorCapabilityCatalog());
  });
});
