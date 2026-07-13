import { describe, expect, it } from "vitest";
import { eventsApiConfigFromEnv } from "../src/config.js";

describe("Slack events ingress environment", () => {
  const requiredEnv = {
    OPENTAG_DISPATCHER_URL: "http://localhost:3030",
    SLACK_SIGNING_SECRET: "signing_secret"
  };

  it("passes one managed channel principal credential through to the ingress client", () => {
    expect(
      eventsApiConfigFromEnv({
        ...requiredEnv,
        OPENTAG_SLACK_APP_ID: "A123",
        OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL: "slack_principal_123"
      })
    ).toMatchObject({
      appId: "A123",
      channelPrincipalCredential: "slack_principal_123"
    });
  });

  it("rejects partial or blank managed principal configuration", () => {
    expect(() =>
      eventsApiConfigFromEnv({
        ...requiredEnv,
        OPENTAG_SLACK_APP_ID: "A123"
      })
    ).toThrow("OPENTAG_SLACK_APP_ID and OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL must be configured together.");
    expect(() =>
      eventsApiConfigFromEnv({
        ...requiredEnv,
        OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL: "slack_principal_123"
      })
    ).toThrow("OPENTAG_SLACK_APP_ID and OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL must be configured together.");
    expect(() =>
      eventsApiConfigFromEnv({
        ...requiredEnv,
        OPENTAG_SLACK_APP_ID: "A123",
        OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL: "   "
      })
    ).toThrow("OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL must be a non-empty string");
  });
});
