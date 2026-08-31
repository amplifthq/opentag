import { describe, expect, it } from "vitest";
import {
  createSlackTeamRelayProjectionBlocks,
  renderSlackTeamRelayProjection,
} from "../src/render.js";
import { createSlackSourceApp } from "../src/source-app.js";

const waiting = {
  kind: "source_thread_projection" as const,
  runId: "run_1",
  generation: 2,
  state: "waiting_for_runner" as const,
  title: "Waiting for your paired Runner",
  summary: "OpenTag will start automatically if the paired Runner becomes eligible before the claim deadline.",
  runOutcome: "pending" as const,
  controls: [
    { kind: "status" as const, actionId: "status_2", generation: 2 },
    { kind: "cancel" as const, actionId: "cancel_2", generation: 2 },
  ],
};

describe("Slack team relay projection", () => {
  it("renders exact semantic copy without deciding lifecycle state", () => {
    const text = renderSlackTeamRelayProjection(waiting);
    expect(text).toContain("Waiting for your paired Runner");
    expect(text).not.toContain("Working on it");
    expect(text).toContain("Run: `run_1`");
  });

  it("renders one action row bound to the current projection generation", () => {
    const blocks = createSlackTeamRelayProjectionBlocks(waiting);
    expect(blocks.filter((block) => block.type === "actions")).toHaveLength(1);
    expect(JSON.stringify(blocks)).toContain("opentag_projection_run_1_2");
    expect(JSON.stringify(blocks)).toContain("opentag:decision:status");
    expect(JSON.stringify(blocks)).toContain("opentag:decision:cancel");
  });

  it("renders provider delivery failure independently from terminal Run success", () => {
    const text = renderSlackTeamRelayProjection({
      ...waiting,
      generation: 3,
      state: "proposal_ready",
      title: "Proposal ready",
      summary: "The governed proposal is complete.",
      runOutcome: "succeeded",
      controls: [],
      providerDelivery: {
        state: "outcome_unknown",
        reasonCode: "delivery_restart_after_begin",
        message: "Slack status delivery outcome is unknown.",
      },
    });
    expect(text).toContain("Proposal ready");
    expect(text).toContain("Slack status delivery outcome is unknown.");
    expect(text).not.toContain("Run failed");
  });

  it("preserves only projection controls through the authenticated Source App renderer", () => {
    const app = createSlackSourceApp({ installation: {
      organizationId: "org_1", appInstanceId: "app_1", bindingDigest: `sha256:${"a".repeat(64)}`,
      credentialGeneration: 1, credentialGenerationDigest: `sha256:${"b".repeat(64)}`,
    }, signingSecret: "secret", botUserId: "U_APP", resolveCredential: async () => "unused" });
    const rendered = app.presentation.render({ protocol: "opentag.channel.v1", commandId: "command_1",
      operation: "create", replyTarget: { provider: "slack", channel: { provider: "slack", id: "C1" } },
      presentation: waiting });
    expect(rendered.blocks?.filter((block) => block.type === "actions")).toHaveLength(1);
  });
});
