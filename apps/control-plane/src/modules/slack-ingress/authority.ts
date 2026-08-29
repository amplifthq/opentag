import type { SourceThreadCommandAuthorityPorts, SourceThreadAuthorityEnvelope } from "@opentag/source-app-runtime";
import type { HostedRunCoordinator } from "../hosted-runs/index.js";
import type { PermissionCoordinator } from "../hosted-runs/permissions.js";

function envelope(input: { authority?: SourceThreadAuthorityEnvelope }, requestId?: string) {
  const authority = input.authority;
  if (!authority || (requestId !== undefined && authority.pendingRequestId !== requestId)) return null;
  return authority;
}

export function createControlPlaneSourceThreadAuthority(input: {
  hosted: HostedRunCoordinator; permissions: PermissionCoordinator; clock: { now(): Date };
}): SourceThreadCommandAuthorityPorts {
  return {
    async status(command) {
      const authority = envelope(command); if (!authority) return { outcome: "rejected", reason: "authority_invalid" };
      const view = await input.hosted.inspect({ organizationId: authority.organizationId, runId: authority.runId });
      return view ? { outcome: "completed", value: view }
        : { outcome: "rejected", reason: "run_not_found" };
    },
    async cancel(command) {
      const authority = envelope(command); if (!authority) return { outcome: "rejected", reason: "authority_invalid" };
      const result = await input.hosted.cancelRun({ organizationId: authority.organizationId,
        runId: authority.runId, reason: command.reason });
      return result.kind === "cancelled" || result.kind === "terminal"
        ? { outcome: "completed", value: result }
        : { outcome: "rejected", reason: "run_not_found" };
    },
    async approve(command) {
      const authority = envelope(command, command.requestId);
      if (!authority) return { outcome: "rejected", reason: "authority_invalid" };
      if (command.decision === "allow_run") {
        return { outcome: "rejected", reason: "allow_run_not_supported" };
      }
      const result = await input.permissions.resolve({ principal: {
        organizationId: authority.organizationId, actorId: command.actor.id },
        runnerId: authority.runnerId, decision: {
          schemaVersion: 1, protocolVersion: "1.0", requiredCapabilities: ["relay.permission.v1"],
          requestId: `slack_${command.commandId}`, operationId: command.commandId,
          organizationId: authority.organizationId, runId: authority.runId,
          attempt: { attemptId: authority.attemptId, attemptNumber: authority.attemptNumber,
            epoch: authority.attemptEpoch, fencingTokenDigest: authority.fencingTokenDigest },
          actionId: authority.actionId, permissionRequestId: authority.pendingRequestId,
          permissionRequestDigest: authority.permissionRequestDigest,
          policySnapshotDigest: authority.policyDigest, decisionId: command.commandId,
          decision: "allow_once", decidedAt: input.clock.now().toISOString(),
        } });
      return result.kind === "resolved" || result.kind === "replayed"
        ? { outcome: "completed", value: result.receipt }
        : { outcome: "rejected", reason: result.kind };
    },
    async reject(command) {
      const authority = envelope(command, command.requestId);
      if (!authority) return { outcome: "rejected", reason: "authority_invalid" };
      const result = await input.permissions.resolve({ principal: {
        organizationId: authority.organizationId, actorId: command.actor.id },
        runnerId: authority.runnerId, decision: {
          schemaVersion: 1, protocolVersion: "1.0", requiredCapabilities: ["relay.permission.v1"],
          requestId: `slack_${command.commandId}`, operationId: command.commandId,
          organizationId: authority.organizationId, runId: authority.runId,
          attempt: { attemptId: authority.attemptId, attemptNumber: authority.attemptNumber,
            epoch: authority.attemptEpoch, fencingTokenDigest: authority.fencingTokenDigest },
          actionId: authority.actionId, permissionRequestId: authority.pendingRequestId,
          permissionRequestDigest: authority.permissionRequestDigest,
          policySnapshotDigest: authority.policyDigest, decisionId: command.commandId,
          decision: "deny", decidedAt: input.clock.now().toISOString(),
        } });
      return result.kind === "resolved" || result.kind === "replayed"
        ? { outcome: "completed", value: result.receipt }
        : { outcome: "rejected", reason: result.kind };
    },
    async bind() { return { outcome: "rejected", reason: "binding_authority_unavailable" }; },
    async unbind() { return { outcome: "rejected", reason: "binding_authority_unavailable" }; },
  };
}
