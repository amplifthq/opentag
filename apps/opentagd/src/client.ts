import { OpenTagEventSchema, OpenTagRunSchema, type OpenTagEvent, type OpenTagRun } from "@opentag/core";
import type { RepositoryBindingConfig, SlackChannelBindingConfig } from "./config.js";
import type { ClaimedRun, DaemonClient } from "./daemon.js";

function assertOk(response: Response, action: string): void {
  if (!response.ok) {
    throw new Error(`${action} failed: ${response.status}`);
  }
}

function authHeaders(pairingToken: string | undefined): Record<string, string> {
  return pairingToken ? { authorization: `Bearer ${pairingToken}` } : {};
}

export function createDispatcherClient(input: { dispatcherUrl: string; runnerId: string; pairingToken?: string }): DaemonClient {
  const baseUrl = input.dispatcherUrl.replace(/\/$/, "");

  return {
    async claim(): Promise<ClaimedRun | null> {
      const response = await fetch(`${baseUrl}/v1/runners/${input.runnerId}/claim`, {
        method: "POST",
        headers: authHeaders(input.pairingToken)
      });
      if (response.status === 204) return null;
      assertOk(response, "claim");
      const body = (await response.json()) as { run: OpenTagRun; event: OpenTagEvent };
      return {
        run: OpenTagRunSchema.parse(body.run),
        event: OpenTagEventSchema.parse(body.event)
      };
    },

    async markRunning(runId, executor) {
      const response = await fetch(`${baseUrl}/v1/runs/${runId}/running`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(input.pairingToken) },
        body: JSON.stringify({ executor })
      });
      assertOk(response, "markRunning");
    },

    async heartbeat(runId) {
      const response = await fetch(`${baseUrl}/v1/runners/${input.runnerId}/runs/${runId}/heartbeat`, {
        method: "POST",
        headers: authHeaders(input.pairingToken)
      });
      assertOk(response, "heartbeat");
    },

    async progress(runId, progressInput) {
      const response = await fetch(`${baseUrl}/v1/runs/${runId}/progress`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(input.pairingToken) },
        body: JSON.stringify(progressInput)
      });
      assertOk(response, "progress");
    },

    async complete(runId, result) {
      const response = await fetch(`${baseUrl}/v1/runs/${runId}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(input.pairingToken) },
        body: JSON.stringify({ result })
      });
      assertOk(response, "complete");
    }
  };
}

export function createDispatcherAdminClient(input: { dispatcherUrl: string; runnerId: string; pairingToken?: string }) {
  const baseUrl = input.dispatcherUrl.replace(/\/$/, "");

  return {
    async registerRunner(name = input.runnerId): Promise<void> {
      const response = await fetch(`${baseUrl}/v1/runners`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(input.pairingToken) },
        body: JSON.stringify({ runnerId: input.runnerId, name })
      });
      assertOk(response, "registerRunner");
    },

    async bindRepository(binding: RepositoryBindingConfig): Promise<void> {
      const response = await fetch(`${baseUrl}/v1/repo-bindings`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(input.pairingToken) },
        body: JSON.stringify({
          provider: binding.provider,
          owner: binding.owner,
          repo: binding.repo,
          runnerId: input.runnerId,
          workspacePath: binding.checkoutPath,
          defaultExecutor: binding.defaultExecutor
        })
      });
      assertOk(response, "bindRepository");
    },

    async bindSlackChannel(binding: SlackChannelBindingConfig): Promise<void> {
      const response = await fetch(`${baseUrl}/v1/slack-channel-bindings`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(input.pairingToken) },
        body: JSON.stringify(binding)
      });
      assertOk(response, "bindSlackChannel");
    }
  };
}
