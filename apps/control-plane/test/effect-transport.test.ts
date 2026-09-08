import {
  RelayCapabilitiesResponseV1Schema,
  computeEffectEvidenceDigestV1,
  computeEffectEvidencePayloadDigestV1,
  computeEffectFencingTokenDigestV1,
  computeEffectPermitDigestV1,
  computeEffectRequestDigestV1,
  computeEffectTargetDigestV1,
  type EffectAcquireRequestV1,
  type EffectEvidenceEnvelopeV1,
  type EffectExecutePermitV1,
  type EffectRequestV1,
  type EffectViewV1,
} from "@opentag/control-protocol";
import { describe, expect, it, vi } from "vitest";
import { createControlPlaneApplication } from "../src/application.js";
import { EffectAuthorityStoredStateError } from "../src/modules/effects/index.js";

const now = "2026-08-15T12:00:00.000Z";
const principal = {
  organizationId: "org_effect_transport",
  runnerId: "runner_effect_transport",
  credentialId: "credential_effect_transport",
  registrationGeneration: 3,
  credentialGeneration: 2,
};
const capabilities = RelayCapabilitiesResponseV1Schema.parse({
  schemaVersion: 1,
  protocolVersion: "1.0",
  registryVersion: "opentag.control.capabilities/v1",
  capabilities: ["relay.effect-authority.v1"],
  minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
  deployment: { environment: "local", releaseSha: "local" },
});
const target = {
  projectTargetId: "target_effect_transport",
  targetBindingDigest: `sha256:${"a".repeat(64)}`,
  targetBindingGeneration: 1,
  provider: "github" as const,
  owner: "acme",
  repo: "demo",
  remote: "origin",
  baseBranch: "main",
  branch: "opentag/run_effect_transport",
  frozenBaseRevision: "b".repeat(40),
  workspaceTreeDigest: "c".repeat(40),
  expectedHeadSha: "d".repeat(40),
};

async function effectRequest(): Promise<EffectRequestV1> {
  const fencingToken = "opaque_effect_fence";
  const digestInput = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.effect-authority.v1"] as ["relay.effect-authority.v1"],
    requestId: "request_effect_transport",
    effectId: "effect_transport",
    idempotencyKey: "effect:run_effect_transport:draft-pr",
    organizationId: principal.organizationId,
    runnerId: principal.runnerId,
    runnerGeneration: principal.credentialGeneration,
    work: {
      runId: "run_effect_transport",
      attemptId: "attempt_effect_transport",
      attemptNumber: 1,
      epoch: 1,
      fencingToken,
      fencingTokenDigest: await computeEffectFencingTokenDigestV1(fencingToken),
    },
    effectKind: "github.create_draft_pull_request" as const,
    candidate: {
      candidateId: "candidate_effect_transport",
      candidateDigest: `sha256:${"e".repeat(64)}`,
    },
    authority: {
      approvalPolicy: "human_approval_required" as const,
      policySnapshotId: "policy_effect_transport",
      policySnapshotDigest: `sha256:${"f".repeat(64)}`,
      approvalRequestId: "approval_request_effect_transport",
      approvalExpiresAt: "2026-08-15T12:30:00.000Z",
    },
    target,
    requestedAt: now,
  };
  return {
    ...digestInput,
    requestDigest: await computeEffectRequestDigestV1(digestInput),
  };
}

function acquireRequest(): EffectAcquireRequestV1 {
  return {
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.effect-authority.v1"],
    requestId: "acquire_effect_transport",
    organizationId: principal.organizationId,
    runnerId: principal.runnerId,
    runnerGeneration: principal.credentialGeneration,
    acquireJournalDigest: `sha256:${"1".repeat(64)}`,
  };
}

async function executePermit(): Promise<EffectExecutePermitV1> {
  const digestInput = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.effect-authority.v1"] as ["relay.effect-authority.v1"],
    permitKind: "execute" as const,
    permitId: "permit_effect_transport",
    effectId: "effect_transport",
    effectAttemptNumber: 1,
    organizationId: principal.organizationId,
    runnerId: principal.runnerId,
    runnerGeneration: principal.credentialGeneration,
    acquireRequestId: "acquire_effect_transport",
    acquireJournalDigest: `sha256:${"1".repeat(64)}`,
    runId: "run_effect_transport",
    runAttemptId: "attempt_effect_transport",
    runAttemptNumber: 1,
    fencingTokenDigest: `sha256:${"2".repeat(64)}`,
    effectKind: "github.create_draft_pull_request" as const,
    requestDigest: `sha256:${"3".repeat(64)}`,
    targetDigest: await computeEffectTargetDigestV1(target),
    approvalDigest: `sha256:${"4".repeat(64)}`,
    candidate: {
      candidateId: "candidate_effect_transport",
      candidateDigest: `sha256:${"e".repeat(64)}`,
    },
    target,
    issuedAt: now,
    expiresAt: "2026-08-15T12:01:00.000Z",
  };
  return {
    ...digestInput,
    permitDigest: await computeEffectPermitDigestV1(digestInput),
  };
}

async function notStartedEvidence(
  permit: EffectExecutePermitV1,
): Promise<EffectEvidenceEnvelopeV1> {
  const evidence = {
    kind: "not_started" as const,
    acquireJournalDigest: permit.acquireJournalDigest,
    localJournalDigest: `sha256:${"5".repeat(64)}`,
    reason: "provider_io_not_begun" as const,
  };
  const digestInput = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.effect-authority.v1"] as ["relay.effect-authority.v1"],
    evidenceId: "evidence_effect_transport",
    effectId: permit.effectId,
    permitId: permit.permitId,
    effectAttemptNumber: permit.effectAttemptNumber,
    organizationId: permit.organizationId,
    producer: {
      kind: "runner" as const,
      runnerId: permit.runnerId,
      runnerGeneration: permit.runnerGeneration,
    },
    observedAt: now,
    evidence,
    payloadDigest: await computeEffectEvidencePayloadDigestV1(evidence),
  };
  return {
    ...digestInput,
    evidenceDigest: await computeEffectEvidenceDigestV1(digestInput),
  };
}

function effectView(
  state: "requested" | "authorized" = "requested",
): EffectViewV1 {
  return {
    effectId: "effect_transport",
    effectKind: "github.create_draft_pull_request",
    state,
    currentAttemptNumber: 0,
    updatedAt: now,
  };
}

function post(path: string, body: unknown) {
  return new Request(`http://control.test${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer runtime_effect_transport",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function applicationWithEffects(effects: unknown) {
  return createControlPlaneApplication({
    capabilities,
    readiness: { check: async () => ({ ready: true }) },
    control: {
      bootstrap: { authenticate: () => null },
      runners: {
        authenticate: async (token: string) => token === "runtime_effect_transport"
          ? { kind: "authenticated" as const, principal }
          : { kind: "invalid_credential" as const },
      } as never,
      hosted: {} as never,
      effects: effects as never,
    },
  });
}

describe("EffectAuthority Control V1 transport", () => {
  it("exposes only the three Effect endpoints with exact create and replay statuses", async () => {
    const request = await effectRequest();
    const acquire = acquireRequest();
    const permit = await executePermit();
    const evidence = await notStartedEvidence(permit);
    const requested = effectView();
    const recorded: EffectViewV1 = {
      effectId: request.effectId,
      effectKind: request.effectKind,
      state: "retry_eligible",
      currentAttemptNumber: 1,
      currentEvidenceDigest: evidence.evidenceDigest,
      reasonCode: "local.provider_io_not_begun",
      updatedAt: now,
    };
    let requestCount = 0;
    let acquireCount = 0;
    let recordCount = 0;
    const effects = {
      request: vi.fn(async () => ({
        kind: ++requestCount === 1 ? "requested" as const : "replayed" as const,
        effect: requested,
        approvalRequestDigest: `sha256:${"6".repeat(64)}`,
      })),
      acquire: vi.fn(async () => ({
        kind: ++acquireCount === 1 ? "issued" as const : "replayed" as const,
        permit,
      })),
      record: vi.fn(async () => ({
        kind: ++recordCount === 1 ? "recorded" as const : "replayed" as const,
        effect: recorded,
      })),
    };
    const application = applicationWithEffects(effects);

    const requestResponses = [
      await application.fetch(post(`/v1/runners/${principal.runnerId}/effects/request`, request)),
      await application.fetch(post(`/v1/runners/${principal.runnerId}/effects/request`, request)),
    ];
    expect(requestResponses.map((response) => response.status)).toEqual([201, 200]);
    expect(await requestResponses[0]!.json()).toEqual(requested);
    expect(await requestResponses[1]!.json()).toEqual(requested);

    const acquireResponses = [
      await application.fetch(post(`/v1/runners/${principal.runnerId}/effects/acquire`, acquire)),
      await application.fetch(post(`/v1/runners/${principal.runnerId}/effects/acquire`, acquire)),
    ];
    expect(acquireResponses.map((response) => response.status)).toEqual([201, 200]);
    expect(await acquireResponses[0]!.json()).toEqual(permit);
    expect(await acquireResponses[1]!.json()).toEqual(permit);

    const evidenceResponses = [
      await application.fetch(post(
        `/v1/runners/${principal.runnerId}/effects/${request.effectId}/evidence`, evidence,
      )),
      await application.fetch(post(
        `/v1/runners/${principal.runnerId}/effects/${request.effectId}/evidence`, evidence,
      )),
    ];
    expect(evidenceResponses.map((response) => response.status)).toEqual([201, 200]);
    expect(await evidenceResponses[0]!.json()).toEqual(recorded);
    expect(await evidenceResponses[1]!.json()).toEqual(recorded);
    expect(effects.request).toHaveBeenCalledWith({ principal, request });
    expect(effects.acquire).toHaveBeenCalledWith({ principal, request: acquire });
    expect(effects.record).toHaveBeenCalledWith({ principal, evidence });
  });

  it("conceals empty and policy-blocked acquire outcomes as the same empty poll", async () => {
    let calls = 0;
    const application = applicationWithEffects({
      request: vi.fn(),
      record: vi.fn(),
      acquire: vi.fn(async () => ++calls === 1
        ? { kind: "empty" as const }
        : { kind: "blocked" as const, reason: "approval_expired_before_permit" }),
    });
    const first = await application.fetch(post(
      `/v1/runners/${principal.runnerId}/effects/acquire`, acquireRequest(),
    ));
    const second = await application.fetch(post(
      `/v1/runners/${principal.runnerId}/effects/acquire`, {
        ...acquireRequest(), requestId: "acquire_effect_transport_blocked",
      },
    ));
    expect([first.status, second.status]).toEqual([204, 204]);
    expect([await first.text(), await second.text()]).toEqual(["", ""]);
  });

  it("logs a stable stored-authority error without exposing it to the caller", async () => {
    const request = await effectRequest();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const application = applicationWithEffects({
        request: vi.fn(async () => {
          throw new EffectAuthorityStoredStateError(
            "EFFECT_AUTHORITY_STORED_WORKSPACE_INVALID",
          );
        }),
        acquire: vi.fn(),
        record: vi.fn(),
      });
      const response = await application.fetch(post(
        `/v1/runners/${principal.runnerId}/effects/request`,
        request,
      ));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body).toEqual({ error: "internal_error", requestId: expect.any(String) });
      expect(JSON.stringify(body)).not.toContain("EFFECT_AUTHORITY_STORED_WORKSPACE_INVALID");
      expect(errorLog).toHaveBeenCalledWith("control_plane_request_failed", {
        requestId: expect.any(String),
        method: "POST",
        path: `/v1/runners/${principal.runnerId}/effects/request`,
        classification: "stored_effect_authority_invalid",
        errorCode: "EFFECT_AUTHORITY_STORED_WORKSPACE_INVALID",
      });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("fails closed on invalid bodies, digest conflicts, and tenant or path mismatch", async () => {
    const request = await effectRequest();
    const permit = await executePermit();
    const evidence = await notStartedEvidence(permit);
    const effects = {
      request: vi.fn(async () => ({ kind: "conflict" as const,
        reason: "request_digest_mismatch" })),
      acquire: vi.fn(async () => ({ kind: "conflict" as const,
        reason: "acquire_replay_conflict" })),
      record: vi.fn(async () => ({ kind: "conflict" as const,
        reason: "evidence_replay_conflict" })),
    };
    const application = applicationWithEffects(effects);

    const invalidBody = await application.fetch(post(
      `/v1/runners/${principal.runnerId}/effects/request`, { effectId: request.effectId },
    ));
    expect(invalidBody.status).toBe(400);

    const digestConflict = await application.fetch(post(
      `/v1/runners/${principal.runnerId}/effects/request`, {
        ...request, requestDigest: `sha256:${"9".repeat(64)}`,
      },
    ));
    expect(digestConflict.status).toBe(409);
    expect(await digestConflict.json()).toMatchObject({ error: "idempotency_conflict" });

    const acquireConflict = await application.fetch(post(
      `/v1/runners/${principal.runnerId}/effects/acquire`, acquireRequest(),
    ));
    const evidenceConflict = await application.fetch(post(
      `/v1/runners/${principal.runnerId}/effects/${request.effectId}/evidence`, evidence,
    ));
    expect([acquireConflict.status, evidenceConflict.status]).toEqual([409, 409]);
    expect(await acquireConflict.json()).toMatchObject({ error: "idempotency_conflict" });
    expect(await evidenceConflict.json()).toMatchObject({ error: "idempotency_conflict" });

    const wrongTenant = await application.fetch(post(
      `/v1/runners/${principal.runnerId}/effects/request`, {
        ...request, organizationId: "org_other",
      },
    ));
    const wrongRunnerPath = await application.fetch(post(
      "/v1/runners/runner_other/effects/acquire", acquireRequest(),
    ));
    const wrongEffectPath = await application.fetch(post(
      `/v1/runners/${principal.runnerId}/effects/effect_other/evidence`, evidence,
    ));
    expect([wrongTenant.status, wrongRunnerPath.status, wrongEffectPath.status])
      .toEqual([409, 409, 409]);
    expect(effects.request).toHaveBeenCalledTimes(1);
    expect(effects.acquire).toHaveBeenCalledTimes(1);
    expect(effects.record).toHaveBeenCalledTimes(1);

    const unauthenticated = await application.fetch(new Request(
      `http://control.test/v1/runners/${principal.runnerId}/effects/acquire`,
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(acquireRequest()) },
    ));
    expect(unauthenticated.status).toBe(401);
  });

  it("does not retain any superseded publication route", async () => {
    const application = applicationWithEffects({
      request: vi.fn(), acquire: vi.fn(), record: vi.fn(),
    });
    const oldRoutes = [
      "/v1/runners/runner_effect_transport/runs/run_effect_transport/publication/ownership",
      "/v1/runners/runner_effect_transport/publication/claim-next",
      "/v1/runners/runner_effect_transport/runs/run_effect_transport/publication/begin",
      "/v1/runners/runner_effect_transport/runs/run_effect_transport/publication/receipt",
      "/v1/runners/runner_effect_transport/runs/run_effect_transport/publication/reconcile",
      "/v1/runners/runner_effect_transport/runs/run_effect_transport/publication/complete",
    ];
    const responses = await Promise.all(oldRoutes.map((route) =>
      application.fetch(post(route, {}))));
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404]);
  });
});
