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

  it("formats executor runtime capabilities next to executor availability", () => {
    const output = formatExecutorsCommandOutput({ PATH: "" } as NodeJS.ProcessEnv);

    expect(output).toContain("Coding agents:");
    expect(output).toContain("Codex: needs setup (Could not find npx on PATH; pinned package @agentclientprotocol/codex-acp@1.1.2 needs setup)");
    expect(output).toContain("Claude Code: needs setup (Could not find npx on PATH; pinned package @agentclientprotocol/claude-agent-acp@0.59.0 needs setup)");
    expect(output).toContain("Cursor: not found (Could not find cursor-agent on PATH)");
    expect(output).toContain("OpenCode: needs setup (Could not find npx on PATH; pinned package opencode-ai@1.18.1 needs setup)");
    expect(output).toContain("Echo: dev/test only");
    expect(output).toContain("Executor capabilities:");
    expect(output).toContain("Codex: invocation=spawn");
    expect(output).toContain("profile=no");
    expect(output).toContain("progress=audit");
    expect(output).toContain("approval=opentag_policy");
    expect(output).toContain("context=context_packet,context_pointers,workspace");
    expect(output).toContain("prompt=opentag");
    expect(output).toContain("write=workspace");
    expect(output).toContain("conversation=request");
    expect(output).toContain("prompt_mutation=none");
    expect(output).toContain("raw_context=no");
    expect(output).toContain("write_actions=propose");
    expect(output).toContain("secrets=none");
    expect(output).toContain("Hermes: invocation=spawn, profile=yes");
    expect(output).toContain("completion=stream_event");
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
