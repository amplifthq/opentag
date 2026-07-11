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
    expect(output).toContain("Codex: not found");
    expect(output).toContain("Echo: dev/test only");
    expect(output).toContain("Executor capabilities:");
    expect(output).toContain("Codex: invocation=spawn");
    expect(output).toContain("profile=no");
    expect(output).toContain("progress=audit");
    expect(output).toContain("approval=opentag_policy");
    expect(output).toContain("context=context_packet,context_pointers,workspace");
    expect(output).toContain("prompt=executor_adapter");
    expect(output).toContain("write=workspace");
    expect(output).toContain("conversation=request");
    expect(output).toContain("prompt_mutation=none");
    expect(output).toContain("raw_context=no");
    expect(output).toContain("write_actions=none");
    expect(output).toContain("secrets=openai_api_key");
    expect(output).toContain("Hermes: invocation=spawn, profile=no");
    expect(output).toContain("completion=process_exit");
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
