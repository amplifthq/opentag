import { randomUUID } from "node:crypto";
import { createOpenTagClient } from "@opentag/client";
import type { SlackEventProcessorInput } from "./events.js";

export type SlackDispatcherEventConfig = {
  dispatcherUrl: string;
  dispatcherToken?: string;
};

export function createSlackDispatcherEventProcessorInput(config: SlackDispatcherEventConfig): SlackEventProcessorInput {
  const dispatcherClient = createOpenTagClient({
    dispatcherUrl: config.dispatcherUrl,
    ...(config.dispatcherToken ? { pairingToken: config.dispatcherToken } : {})
  });

  return {
    async resolveChannelBinding(input) {
      try {
        const { binding } = await dispatcherClient.getChannelBinding({
          provider: "slack",
          accountId: input.teamId,
          conversationId: input.channelId
        });
        return {
          teamId: binding.accountId,
          channelId: binding.conversationId,
          repoProvider: binding.repoProvider,
          owner: binding.owner,
          repo: binding.repo
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes("channel_binding_not_found")) {
          return null;
        }
        throw error;
      }
    },
    async createRun(event) {
      const runId = `run_${randomUUID()}`;
      const created = await dispatcherClient.createRun({ runId, event });
      return created.outcome === "run_created" ? { runId: created.run.id } : { runId };
    },
    async submitThreadAction(action) {
      await dispatcherClient.submitThreadAction(action);
    },
    now: () => new Date().toISOString()
  };
}
