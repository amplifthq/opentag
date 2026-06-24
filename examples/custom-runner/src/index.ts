import { createOpenTagClient } from "@opentag/client";
import type { ExecutorAdapter } from "@opentag/runner";

const dispatcherUrl = process.env.OPENTAG_DISPATCHER_URL ?? "http://localhost:3030";
const pairingToken = process.env.OPENTAG_PAIRING_TOKEN;
const runnerId = process.env.OPENTAG_RUNNER_ID ?? "runner_custom";
const workspacePath = process.env.OPENTAG_WORKSPACE_PATH ?? process.cwd();

const executor: ExecutorAdapter = {
  id: "custom",
  displayName: "Custom Example Executor",
  async canRun() {
    return { ready: true };
  },
  async run(input, sink) {
    await sink.emit({
      type: "executor.started",
      message: `Custom executor received: ${input.command.rawText}`,
      at: new Date().toISOString()
    });

    await sink.emit({
      type: "executor.completed",
      message: "Custom executor completed without changing files",
      at: new Date().toISOString()
    });

    return {
      conclusion: "success",
      summary: `Custom runner handled '${input.command.rawText}' in ${input.workspacePath}`,
      verification: [
        {
          command: "custom-runner",
          outcome: "passed",
          excerpt: "No external command was required."
        }
      ]
    };
  },
  async cancel() {
    return;
  }
};

const client = createOpenTagClient({
  dispatcherUrl,
  ...(pairingToken ? { pairingToken } : {})
});

const claimed = await client.claim({ runnerId });
if (!claimed) {
  console.log("No OpenTag run available.");
  process.exit(0);
}

const readiness = await executor.canRun({
  runId: claimed.run.id,
  workspacePath,
  command: claimed.event.command,
  context: claimed.event.context
});

if (!readiness.ready) {
  await client.complete({
    runId: claimed.run.id,
    result: {
      conclusion: "needs_human",
      summary: readiness.reason ?? `${executor.displayName} is not ready`
    }
  });
  process.exit(0);
}

await client.markRunning({ runId: claimed.run.id, executor: executor.id });

const result = await executor.run(
  {
    runId: claimed.run.id,
    workspacePath,
    command: claimed.event.command,
    context: claimed.event.context
  },
  {
    emit: (event) =>
      client.progress({
        runId: claimed.run.id,
        type: event.type,
        message: event.message,
        at: event.at
      })
  }
);

await client.complete({ runId: claimed.run.id, result });

console.log(`Completed OpenTag run ${claimed.run.id} with ${executor.id}.`);
