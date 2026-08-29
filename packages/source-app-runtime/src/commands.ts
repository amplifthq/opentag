import { OpenTagActorRefSchema, type OpenTagActorRef } from "@opentag/core";
import type { SourceAppDefinition } from "./definition.js";

export type SourceThreadAuthorityEnvelope = {
  organizationId: string; installationId: string; bindingId: string; sourceThreadId: string;
  runId: string; pendingRequestId: string; approvalEpoch: string;
  runnerId: string; attemptId: string; attemptNumber: number; attemptEpoch: number;
  fencingTokenDigest: string; permissionRequestDigest: string; actionId: string;
  actionDescriptorDigest: string; frozenCeilingDigest: string;
  policyDigest: string; actionTokenIdentity: string;
};
type CommandAuthority = { authority?: SourceThreadAuthorityEnvelope };

export type SourceThreadCommand =
  | ({ type: "status"; commandId: string; actor: OpenTagActorRef } & CommandAuthority)
  | ({ type: "cancel"; commandId: string; actor: OpenTagActorRef; reason: string } & CommandAuthority)
  | { type: "approve"; commandId: string; actor: OpenTagActorRef; requestId: string;
      decision: "allow_once" | "allow_run"; authority?: SourceThreadAuthorityEnvelope }
  | ({ type: "reject"; commandId: string; actor: OpenTagActorRef; requestId: string } & CommandAuthority)
  | ({ type: "bind"; commandId: string; actor: OpenTagActorRef; bindingDigest: string } & CommandAuthority)
  | ({ type: "unbind"; commandId: string; actor: OpenTagActorRef; bindingDigest: string } & CommandAuthority);

export type SourceThreadCommandResult =
  | { outcome: "completed"; value?: unknown }
  | { outcome: "rejected"; reason: string }
  | { outcome: "authority_unavailable" }
  | { outcome: "unsupported_capability"; capability: "threads" | "interactiveActions" };

export type SourceThreadCommandAuthorityPorts = {
  status(command: Extract<SourceThreadCommand, { type: "status" }>): Promise<SourceThreadCommandResult>;
  cancel(command: Extract<SourceThreadCommand, { type: "cancel" }>): Promise<SourceThreadCommandResult>;
  approve(command: Extract<SourceThreadCommand, { type: "approve" }>): Promise<SourceThreadCommandResult>;
  reject(command: Extract<SourceThreadCommand, { type: "reject" }>): Promise<SourceThreadCommandResult>;
  bind(command: Extract<SourceThreadCommand, { type: "bind" }>): Promise<SourceThreadCommandResult>;
  unbind(command: Extract<SourceThreadCommand, { type: "unbind" }>): Promise<SourceThreadCommandResult>;
};

const commandFields = {
  status: ["type", "commandId", "actor", "authority"],
  cancel: ["type", "commandId", "actor", "reason", "authority"],
  approve: ["type", "commandId", "actor", "requestId", "decision", "authority"],
  reject: ["type", "commandId", "actor", "requestId", "authority"],
  bind: ["type", "commandId", "actor", "bindingDigest", "authority"],
  unbind: ["type", "commandId", "actor", "bindingDigest", "authority"]
} as const;

const authorityFields = ["organizationId", "installationId", "bindingId", "sourceThreadId", "runId",
  "pendingRequestId", "approvalEpoch", "runnerId", "attemptId", "attemptNumber", "attemptEpoch",
  "fencingTokenDigest", "permissionRequestDigest", "actionId",
  "actionDescriptorDigest", "frozenCeilingDigest",
  "policyDigest", "actionTokenIdentity"] as const;
function parseAuthority(input: unknown): SourceThreadAuthorityEnvelope {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Source Thread authority envelope is invalid.");
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== authorityFields.length
    || Object.keys(value).some((key) => !(authorityFields as readonly string[]).includes(key))) {
    throw new Error("Source Thread authority envelope contains an undeclared field.");
  }
  for (const field of ["organizationId", "installationId", "bindingId", "sourceThreadId", "runId",
    "pendingRequestId", "approvalEpoch", "runnerId", "attemptId", "actionId"] as const) {
    if (typeof value[field] !== "string" || !(value[field] as string).trim()) {
      throw new Error("Source Thread authority envelope is invalid.");
    }
  }
  if (!Number.isInteger(value.attemptNumber) || (value.attemptNumber as number) <= 0
    || !Number.isInteger(value.attemptEpoch) || (value.attemptEpoch as number) <= 0) {
    throw new Error("Source Thread authority envelope is invalid.");
  }
  for (const field of ["fencingTokenDigest", "permissionRequestDigest", "actionDescriptorDigest",
    "frozenCeilingDigest", "policyDigest", "actionTokenIdentity"] as const) {
    if (typeof value[field] !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value[field] as string)) {
      throw new Error("Source Thread authority envelope is invalid.");
    }
  }
  return value as SourceThreadAuthorityEnvelope;
}

export const SourceThreadCommandSchema = {
  parse(input: unknown): SourceThreadCommand {
    if (!input || typeof input !== "object") throw new Error("Invalid Source Thread command.");
    const value = input as Record<string, unknown>;
    if (typeof value.type !== "string" || !(value.type in commandFields)) {
      throw new Error("Invalid Source Thread command type.");
    }
    const type = value.type as keyof typeof commandFields;
    if (Object.keys(value).some((key) => !(commandFields[type] as readonly string[]).includes(key))) {
      throw new Error("Source Thread command contains an undeclared field.");
    }
    if (typeof value.commandId !== "string" || value.commandId.trim().length === 0) {
      throw new Error("Source Thread commandId must be a non-empty string.");
    }
    OpenTagActorRefSchema.parse(value.actor);
    const detailKey = type === "cancel" ? "reason"
      : type === "approve" || type === "reject" ? "requestId"
      : type === "bind" || type === "unbind" ? "bindingDigest"
      : undefined;
    if (detailKey && (typeof value[detailKey] !== "string" || value[detailKey].trim().length === 0)) {
      throw new Error(`Source Thread ${detailKey} must be a non-empty string.`);
    }
    if (type === "approve" && value.decision !== "allow_once" && value.decision !== "allow_run") {
      throw new Error("Source Thread approval decision must be allow_once or allow_run.");
    }
    if (value.authority !== undefined) value.authority = parseAuthority(value.authority);
    return value as SourceThreadCommand;
  }
};

export async function executeSourceThreadCommand(input: {
  adapter: Pick<SourceAppDefinition<unknown, unknown, unknown>, "capabilities">;
  command: SourceThreadCommand;
  authority?: SourceThreadCommandAuthorityPorts;
}): Promise<SourceThreadCommandResult> {
  const command = SourceThreadCommandSchema.parse(input.command) as SourceThreadCommand;
  const capability = command.type === "approve" || command.type === "reject"
    ? "interactiveActions"
    : "threads";
  if (!input.adapter.capabilities[capability]) {
    return { outcome: "unsupported_capability", capability };
  }
  if (!input.authority) return { outcome: "authority_unavailable" };

  switch (command.type) {
    case "status": return input.authority.status(command);
    case "cancel": return input.authority.cancel(command);
    case "approve": return input.authority.approve(command);
    case "reject": return input.authority.reject(command);
    case "bind": return input.authority.bind(command);
    case "unbind": return input.authority.unbind(command);
  }
}
