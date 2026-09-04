import {
  computeGitHubProjectTargetBindingDigestV1,
  RelayCapabilitiesResponseV1Schema,
} from "@opentag/control-protocol";
import { describe, expect, it, vi } from "vitest";
import { createControlPlaneApplication } from "../src/application.js";

const capabilities = RelayCapabilitiesResponseV1Schema.parse({
  schemaVersion: 1,
  protocolVersion: "1.0",
  registryVersion: "opentag.control.capabilities/v1",
  capabilities: ["relay.readiness.v1", "relay.repository-binding.v1"],
  minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
  deployment: { environment: "local", releaseSha: "local" },
  artifact: {
    packageName: "@opentag/control-plane",
    packageVersion: "0.0.0",
  },
});

describe("Control Plane Fetch application", () => {
  it("forwards raw Slack Events API and interactivity bodies to the typed ingress", async () => {
    const calls: Array<{ kind: string; installationId: string; body: string }> = [];
    const readiness = vi.fn(async () => ({ ready: false as const,
      reason: "migrations_pending" as const }));
    const application = createControlPlaneApplication({ capabilities,
      readiness: { check: readiness },
      slack: {
        async receiveEvents(installationId, request) {
          calls.push({ kind: "events", installationId,
            body: new TextDecoder().decode(request.rawBody) });
          return { status: 200, body: { ok: true } };
        },
        async receiveInteractivity(installationId, request) {
          calls.push({ kind: "interactivity", installationId,
            body: new TextDecoder().decode(request.rawBody) });
          return { status: 200, body: { ok: true } };
        }
      } });
    const event = await application.fetch(new Request(
      "http://control.test/v1/providers/slack/events/install_1",
      { method: "POST", body: "event-body" }));
    const action = await application.fetch(new Request(
      "http://control.test/v1/providers/slack/interactivity/install_1",
      { method: "POST", body: "action-body" }));
    expect([event.status, action.status]).toEqual([200, 200]);
    expect(calls).toEqual([
      { kind: "events", installationId: "install_1", body: "event-body" },
      { kind: "interactivity", installationId: "install_1", body: "action-body" }
    ]);
    expect(readiness).not.toHaveBeenCalled();
  });
  it("keeps liveness independent from database readiness", async () => {
    let readinessChecks = 0;
    const application = createControlPlaneApplication({
      capabilities,
      readiness: {
        async check() {
          readinessChecks += 1;
          return { ready: false, reason: "database_unavailable" };
        },
      },
    });

    const response = await application.fetch(new Request("http://control.test/healthz"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(readinessChecks).toBe(0);
  });

  it("fails readiness closed without leaking dependency details", async () => {
    const application = createControlPlaneApplication({
      capabilities,
      readiness: {
        async check() {
          return { ready: false, reason: "database_unavailable" };
        },
      },
    });

    const response = await application.fetch(new Request("http://control.test/readyz"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      reason: "database_unavailable",
    });
  });

  it("serves canonical anonymous Control V1 capabilities", async () => {
    const application = createControlPlaneApplication({
      capabilities,
      readiness: {
        async check() {
          return { ready: true };
        },
      },
    });

    const response = await application.fetch(
      new Request("http://control.test/v1/relay/capabilities"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(capabilities);
    expect(RelayCapabilitiesResponseV1Schema.safeParse(body).success).toBe(true);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("upserts a Project Target only for the exact runtime authority and route identity", async () => {
    const principal = {
      organizationId: "org_1",
      runnerId: "runner_1",
      credentialId: "credential_1",
      registrationGeneration: 3,
      credentialGeneration: 2,
    };
    const target = {
      projectTargetId: "target_1",
      provider: "github" as const,
      owner: "acme",
      repo: "demo",
      defaultExecutor: "codex",
      defaultBranch: "main",
    };
    const bindingDigest = await computeGitHubProjectTargetBindingDigestV1(target);
    const context = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      contextKind: "runner_control" as const,
      ...principal,
      capabilities: ["relay.repository-binding.v1"] as const,
      targets: [{ ...target, bindingDigest }],
      observedAt: "2026-08-15T06:00:00.000Z",
    };
    const upsertProjectTarget = vi.fn(async () => ({
      kind: "upserted" as const,
      context,
    }));
    const application = createControlPlaneApplication({
      capabilities,
      readiness: { check: async () => ({ ready: true }) },
      control: {
        bootstrap: { authenticate: () => null },
        runners: {
          authenticate: async (token: string) => token === "runtime_secret"
            ? { kind: "authenticated" as const, principal }
            : { kind: "invalid_credential" as const },
          upsertProjectTarget,
        } as never,
        hosted: {} as never,
      },
    });
    const request = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.repository-binding.v1"] as const,
      requestId: "request_target_1",
      expectedAuthority: {
        credentialId: principal.credentialId,
        registrationGeneration: principal.registrationGeneration,
        credentialGeneration: principal.credentialGeneration,
      },
      target,
    };
    const accepted = await application.fetch(new Request(
      "http://control.test/v1/runners/runner_1/project-targets/target_1",
      { method: "PUT", headers: { authorization: "Bearer runtime_secret",
        "content-type": "application/json" }, body: JSON.stringify(request) },
    ));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual(context);
    expect(upsertProjectTarget).toHaveBeenCalledWith({ principal, request });

    const mismatched = await application.fetch(new Request(
      "http://control.test/v1/runners/runner_1/project-targets/target_other",
      { method: "PUT", headers: { authorization: "Bearer runtime_secret",
        "content-type": "application/json" }, body: JSON.stringify(request) },
    ));
    expect(mismatched.status).toBe(409);
    expect(await mismatched.json()).toMatchObject({
      error: "stale_attempt",
      requestId: request.requestId,
    });
    expect(upsertProjectTarget).toHaveBeenCalledTimes(1);

    upsertProjectTarget.mockResolvedValueOnce({
      kind: "conflict",
      reason: "target_not_bound_to_slack",
    } as never);
    const unbound = await application.fetch(new Request(
      "http://control.test/v1/runners/runner_1/project-targets/target_1",
      { method: "PUT", headers: { authorization: "Bearer runtime_secret",
        "content-type": "application/json" }, body: JSON.stringify(request) },
    ));
    expect(unbound.status).toBe(409);
    expect(await unbound.json()).toMatchObject({
      error: "target_not_bound_to_slack",
      requestId: request.requestId,
    });
  });

  it("prevents caching authenticated console and secret responses", async () => {
    const application = createControlPlaneApplication({
      capabilities,
      readiness: { check: async () => ({ ready: true }) },
      console: {
        publicOrigin: "http://control.test",
        identity: {} as never,
        reads: {} as never,
      },
    });

    const response = await application.fetch(
      new Request("http://control.test/api/console/session"),
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("serves Agent Presence only through an authenticated tenant-scoped read", async () => {
    const presence = vi.fn(async (principal: { organizationId: string }) => ({
      state: "available" as const,
      reason: `ready for ${principal.organizationId}`,
      agents: [],
    }));
    const application = createControlPlaneApplication({
      capabilities,
      readiness: { check: async () => ({ ready: true }) },
      console: {
        publicOrigin: "http://control.test",
        identity: {
          authenticateSession: async (token: string) => token === "session_1"
            ? {
                kind: "authenticated" as const,
                principal: {
                  operatorId: "operator_1",
                  organizationId: "org_1",
                  role: "viewer" as const,
                  email: "viewer@example.test",
                  displayName: "Viewer",
                },
              }
            : { kind: "invalid_credential" as const },
        } as never,
        reads: { presence } as never,
      },
    });

    const unauthorized = await application.fetch(
      new Request("http://control.test/api/console/presence"),
    );
    expect(unauthorized.status).toBe(401);
    expect(presence).not.toHaveBeenCalled();

    const authorized = await application.fetch(new Request(
      "http://control.test/api/console/presence",
      { headers: { cookie: "opentag_session=session_1" } },
    ));
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      presence: {
        state: "available",
        reason: "ready for org_1",
        agents: [],
      },
    });
    expect(presence).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "org_1",
    }));
  });

  it("returns a bounded retry response when console login is throttled", async () => {
    let observedNetworkKey: string | undefined;
    const application = createControlPlaneApplication({
      capabilities,
      readiness: { check: async () => ({ ready: true }) },
      console: {
        publicOrigin: "http://control.test",
        identity: {
          login: async (command: { networkKey?: string }) => {
            observedNetworkKey = command.networkKey;
            return {
              kind: "rate_limited" as const,
              retryAfterMs: 120_000,
            };
          },
        } as never,
        reads: {} as never,
      },
    });
    const response = await application.fetch(new Request(
      "http://control.test/api/console/session",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://control.test",
        },
        body: JSON.stringify({
          email: "owner@example.test",
          password: "wrong password value",
        }),
      },
    ));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(observedNetworkKey).toBe("direct-fetch");
  });

  it("never trusts forwarded client addresses and disables the network bucket behind a trusted edge", async () => {
    let observedNetworkKey: string | undefined;
    const application = createControlPlaneApplication({
      capabilities,
      readiness: { check: async () => ({ ready: true }) },
      console: {
        publicOrigin: "https://control.test",
        loginNetworkMode: "trusted-edge",
        identity: {
          login: async (command: { networkKey?: string }) => {
            observedNetworkKey = command.networkKey;
            return { kind: "invalid_credential" as const };
          },
        } as never,
        reads: {} as never,
      },
    });
    const response = await application.fetch(new Request(
      "https://control.test/api/console/session",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://control.test",
          "x-forwarded-for": "198.51.100.22",
          "cf-connecting-ip": "198.51.100.23",
        },
        body: JSON.stringify({
          email: "owner@example.test",
          password: "wrong password value",
        }),
      },
    ));

    expect(response.status).toBe(401);
    expect(observedNetworkKey).toBeUndefined();
  });

  it("returns a bounded JSON 404 for an unknown API path", async () => {
    const application = createControlPlaneApplication({
      capabilities,
      readiness: {
        async check() {
          return { ready: true };
        },
      },
    });

    const response = await application.fetch(new Request("http://control.test/v1/unknown"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Route not found." },
    });
  });

});
