import { createOpenTagClient, type BoundedCompletionWaiverInput } from "@opentag/client";
import type { PolicyScope } from "@opentag/core";
import {
  defaultConfigPath,
  readCliConfig
} from "./config.js";
import { formatCompletionExplanation } from "./status.js";

const POLICY_SCOPES: PolicyScope[] = [
  "organization_default",
  "work_context_owner_container",
  "work_item_override"
];

export type CompletionWaiveCommandOptions = {
  config?: string;
  run: string;
  gate: string[];
  reason: string;
  actorProvider: string;
  actorId: string;
  actorHandle?: string;
  scope: string;
  policyScope: string;
  waivedAt?: string;
  expiresAt?: string;
};

export async function runCompletionWaiveCommand(
  options: CompletionWaiveCommandOptions,
  dependencies: { fetchImpl?: typeof fetch; now?: () => string; log?: (message: string) => void } = {}
): Promise<void> {
  if (options.scope !== "selected_gates") {
    throw new Error("--scope must be selected_gates for a bounded Phase 1 completion waiver.");
  }
  if (!POLICY_SCOPES.includes(options.policyScope as PolicyScope)) {
    throw new Error(`--policy-scope must be one of: ${POLICY_SCOPES.join(", ")}.`);
  }
  const gateIds = [...new Set(options.gate.map((gateId) => gateId.trim()).filter(Boolean))].sort();
  if (gateIds.length === 0) throw new Error("At least one non-empty --gate is required.");
  const waivedAt = options.waivedAt ?? dependencies.now?.() ?? new Date().toISOString();
  const configPath = options.config ?? defaultConfigPath();
  const config = readCliConfig(configPath);
  const pairingToken = config.daemon.pairingToken;
  if (!pairingToken) {
    throw new Error("Completion waivers require daemon.pairingToken; a runner token cannot authorize governance changes.");
  }
  const client = createOpenTagClient({
    dispatcherUrl: config.daemon.dispatcherUrl,
    pairingToken,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {})
  });
  const waiver: BoundedCompletionWaiverInput = {
    actor: {
      provider: options.actorProvider,
      providerUserId: options.actorId,
      ...(options.actorHandle ? { handle: options.actorHandle } : {})
    },
    reason: options.reason,
    scope: "selected_gates",
    policyScope: options.policyScope as PolicyScope,
    gateIds,
    waivedAt,
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {})
  };
  const result = await client.waiveCompletion({ runId: options.run, waiver });
  const log = dependencies.log ?? console.log;
  log([
    `Completion waiver: ${result.outcome}`,
    `Waiver: ${result.waiver.id}`,
    `Actor: ${result.waiver.actor.provider}:${result.waiver.actor.providerUserId}`,
    `Reason: ${result.waiver.reason}`,
    `Gates: ${result.waiver.gateIds.join(", ")}`,
    ...formatCompletionExplanation(result.completion)
  ].join("\n"));
}
