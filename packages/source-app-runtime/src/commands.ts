import { OpenTagActorRefSchema, type OpenTagActorRef } from "@opentag/core";
import type { SourceAppDefinition } from "./definition.js";

export type SourceThreadCommand =
  | { type: "status"; commandId: string; actor: OpenTagActorRef }
  | { type: "cancel"; commandId: string; actor: OpenTagActorRef; reason: string }
  | { type: "approve"; commandId: string; actor: OpenTagActorRef; requestId: string;
      decision: "allow_once" | "allow_run" }
  | { type: "reject"; commandId: string; actor: OpenTagActorRef; requestId: string }
  | { type: "bind"; commandId: string; actor: OpenTagActorRef; bindingDigest: string }
  | { type: "unbind"; commandId: string; actor: OpenTagActorRef; bindingDigest: string };

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
  status: ["type", "commandId", "actor"],
  cancel: ["type", "commandId", "actor", "reason"],
  approve: ["type", "commandId", "actor", "requestId", "decision"],
  reject: ["type", "commandId", "actor", "requestId"],
  bind: ["type", "commandId", "actor", "bindingDigest"],
  unbind: ["type", "commandId", "actor", "bindingDigest"]
} as const;

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
