import { describe, expect, it } from "vitest";
import {
  OpenTagIntegrationManifestSchema,
  selectReplyTargetsForPurpose,
  type OpenTagReplyTargetRef
} from "../src/integration-protocol.js";

function acpManifest() {
  return {
    protocol: "opentag.integration.v1",
    id: "hermes",
    label: "Hermes",
    bindings: {
      hermesAcp: {
        kind: "stdio",
        command: "hermes",
        args: ["acp"]
      },
      channelGateway: {
        kind: "stdio",
        command: "/opt/opentag/hermes-channel"
      }
    },
    roles: {
      agent: {
        protocol: "agent-client-protocol",
        protocolVersion: 1,
        binding: "hermesAcp"
      },
      channel: {
        protocol: "opentag.channel.v1",
        binding: "channelGateway",
        ownership: {
          mode: "managed",
          exclusive: true
        }
      }
    },
    resources: {
      "github.repository": { refs: true, read: true },
      "linear.issue": { refs: true, read: true, write: true },
      "custom.report": { refs: false, read: true }
    }
  } as const;
}

describe("OpenTag integration manifest", () => {
  it("accepts ACP and provider-neutral channel roles over stdio bindings", () => {
    const manifest = OpenTagIntegrationManifestSchema.parse(acpManifest());

    expect(manifest.bindings.hermesAcp).toEqual({
      kind: "stdio",
      command: "hermes",
      args: ["acp"]
    });
    expect(manifest.roles.agent).toEqual({
      protocol: "agent-client-protocol",
      protocolVersion: 1,
      binding: "hermesAcp"
    });
    expect(manifest.roles.channel?.ownership).toEqual({ mode: "managed", exclusive: true });
    expect(manifest.resources["custom.report"]).toEqual({ refs: false, read: true, write: false });
  });

  it("rejects an empty binding map", () => {
    const manifest = acpManifest();

    expect(() =>
      OpenTagIntegrationManifestSchema.parse({
        ...manifest,
        bindings: {},
        roles: {}
      })
    ).toThrow("at least one binding");
  });

  it("rejects agent and channel roles that reference missing bindings", () => {
    const manifest = acpManifest();

    expect(() =>
      OpenTagIntegrationManifestSchema.parse({
        ...manifest,
        roles: {
          ...manifest.roles,
          agent: { ...manifest.roles.agent, binding: "missing" }
        }
      })
    ).toThrow("missing binding");

    expect(() =>
      OpenTagIntegrationManifestSchema.parse({
        ...manifest,
        roles: {
          ...manifest.roles,
          channel: { ...manifest.roles.channel, binding: "missing" }
        }
      })
    ).toThrow("missing binding");
  });

  it.each(["", "   ", ".", "..", "./hermes", "bin/hermes", "../hermes", "C:agent"])(
    "rejects a blank or relative command: %j",
    (command) => {
      const manifest = acpManifest();

      expect(() =>
        OpenTagIntegrationManifestSchema.parse({
          ...manifest,
          bindings: {
            ...manifest.bindings,
            hermesAcp: { ...manifest.bindings.hermesAcp, command }
          }
        })
      ).toThrow();
    }
  );

  it("rejects the unshipped legacy executor role and protocol", () => {
    const manifest = acpManifest();
    const removedProtocol = ["opentag", "executor", "v1"].join(".");
    const removedProfile = ["stdio", "jsonl-basic"].join("-");

    expect(() =>
      OpenTagIntegrationManifestSchema.parse({
        ...manifest,
        roles: {
          executor: {
            protocol: removedProtocol,
            profile: removedProfile,
            binding: "hermesAcp"
          }
        }
      })
    ).toThrow();

    expect(() =>
      OpenTagIntegrationManifestSchema.parse({
        ...manifest,
        roles: {
          agent: {
            protocol: removedProtocol,
            protocolVersion: 1,
            binding: "hermesAcp"
          }
        }
      })
    ).toThrow();
  });

  it("rejects legacy fields on the ACP agent role", () => {
    const manifest = acpManifest();
    const removedProfile = ["stdio", "jsonl-basic"].join("-");

    expect(() =>
      OpenTagIntegrationManifestSchema.parse({
        ...manifest,
        roles: {
          agent: {
            ...manifest.roles.agent,
            profile: removedProfile,
            capabilities: { supportsStreaming: false }
          }
        }
      })
    ).toThrow();
  });

  it.each([
    { OPENTAG_MODE: "safe" },
    { GITHUB_TOKEN: "github_pat_literal-must-never-be-in-a-manifest" }
  ])("rejects literal environment values in reusable bindings: %j", (env) => {
    const manifest = acpManifest();

    expect(() =>
      OpenTagIntegrationManifestSchema.parse({
        ...manifest,
        bindings: {
          ...manifest.bindings,
          hermesAcp: { ...manifest.bindings.hermesAcp, env }
        }
      })
    ).toThrow();
  });
});

describe("selectReplyTargetsForPurpose", () => {
  it("selects all-purpose and matching provider-neutral reply targets", () => {
    const replyTo: OpenTagReplyTargetRef[] = [
      { channel: { provider: "chat-a", id: "all-1" }, purpose: "all" },
      { channel: { provider: "chat-a", id: "progress-1" }, purpose: "progress" },
      { channel: { provider: "tracker-b", id: "final" }, purpose: "final" },
      { channel: { provider: "tracker-b", id: "all-2" }, purpose: "all" },
      { channel: { provider: "tracker-b", id: "error" }, purpose: "error" },
      { channel: { provider: "chat-a", id: "approval" }, purpose: "approval" }
    ];

    expect(selectReplyTargetsForPurpose(replyTo, "progress").map((target) => target.channel.id)).toEqual([
      "all-1",
      "progress-1",
      "all-2"
    ]);
    expect(selectReplyTargetsForPurpose(replyTo, "final").map((target) => target.channel.id)).toEqual([
      "all-1",
      "final",
      "all-2"
    ]);
    expect(selectReplyTargetsForPurpose(replyTo, "error").map((target) => target.channel.id)).toEqual([
      "all-1",
      "all-2",
      "error"
    ]);
    expect(selectReplyTargetsForPurpose(replyTo, "approval").map((target) => target.channel.id)).toEqual([
      "all-1",
      "all-2",
      "approval"
    ]);
  });
});
