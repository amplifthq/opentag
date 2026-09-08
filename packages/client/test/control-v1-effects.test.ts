import {
  computeEffectEvidenceDigestV1,
  computeEffectEvidencePayloadDigestV1,
  computeEffectFencingTokenDigestV1,
  computeEffectPermitDigestV1,
  computeEffectRequestDigestV1,
  computeEffectTargetDigestV1,
  type EffectEvidenceEnvelopeV1,
  type EffectExecutePermitV1,
  type EffectRequestV1,
  type EffectViewV1,
} from "@opentag/control-protocol";
import { describe, expect, it, vi } from "vitest";
import { createOpenTagClient } from "../src/index.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const baseUrl = "https://control.example/base";

function response(body: unknown, status: number, url: string): Response {
  const result = status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

function client(fetchImpl: typeof fetch) {
  return createOpenTagClient({
    controlPlaneUrl: baseUrl,
    controlCredential: { kind: "runtime", token: "runtime_secret" },
    fetchImpl,
  });
}

function target() {
  return {
    projectTargetId: "target_1",
    targetBindingDigest: digest("a"),
    targetBindingGeneration: 4,
    provider: "github" as const,
    owner: "acme",
    repo: "demo",
    remote: "origin",
    baseBranch: "main",
    branch: "opentag/run_1",
    frozenBaseRevision: "b".repeat(40),
    workspaceTreeDigest: "c".repeat(40),
    expectedHeadSha: "d".repeat(40),
  };
}

async function effectRequest(): Promise<EffectRequestV1> {
  const fencingToken = "fence_1";
  const input = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.effect-authority.v1"] as const,
    requestId: "request_1",
    effectId: "effect_1",
    idempotencyKey: "effect_request_1",
    organizationId: "org_1",
    runnerId: "runner_1",
    runnerGeneration: 2,
    work: {
      runId: "run_1",
      attemptId: "attempt_1",
      attemptNumber: 3,
      epoch: 3,
      fencingToken,
      fencingTokenDigest: await computeEffectFencingTokenDigestV1(fencingToken),
    },
    effectKind: "github.create_draft_pull_request" as const,
    candidate: { candidateId: "candidate_1", candidateDigest: digest("f") },
    authority: {
      approvalPolicy: "human_approval_required" as const,
      policySnapshotId: "policy_1",
      policySnapshotDigest: digest("4"),
      approvalRequestId: "approval_request_1",
      approvalExpiresAt: "2026-09-05T01:17:03.004Z",
    },
    target: target(),
    requestedAt: "2026-09-05T01:02:03.004Z",
  };
  return { ...input, requestDigest: await computeEffectRequestDigestV1(input) };
}

function effectView(state: "requested" | "retry_eligible" = "requested"): EffectViewV1 {
  if (state === "retry_eligible") {
    return {
      effectId: "effect_1",
      effectKind: "github.create_draft_pull_request",
      state,
      currentAttemptNumber: 1,
      currentEvidenceDigest: digest("9"),
      reasonCode: "local.provider_io_not_begun",
      updatedAt: "2026-09-05T01:02:04.004Z",
    };
  }
  return {
    effectId: "effect_1",
    effectKind: "github.create_draft_pull_request",
    state,
    currentAttemptNumber: 0,
    updatedAt: "2026-09-05T01:02:04.004Z",
  };
}

async function executePermit(): Promise<EffectExecutePermitV1> {
  const effectTarget = target();
  const input = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.effect-authority.v1"] as const,
    permitId: "permit_1",
    permitKind: "execute" as const,
    effectId: "effect_1",
    effectAttemptNumber: 1,
    organizationId: "org_1",
    runnerId: "runner_1",
    runnerGeneration: 2,
    acquireRequestId: "acquire_1",
    acquireJournalDigest: digest("8"),
    runId: "run_1",
    runAttemptId: "attempt_1",
    runAttemptNumber: 3,
    fencingTokenDigest: digest("e"),
    effectKind: "github.create_draft_pull_request" as const,
    requestDigest: digest("1"),
    targetDigest: await computeEffectTargetDigestV1(effectTarget),
    approvalDigest: digest("3"),
    candidate: { candidateId: "candidate_1", candidateDigest: digest("f") },
    target: effectTarget,
    issuedAt: "2026-09-05T01:02:03.004Z",
    expiresAt: "2026-09-05T01:07:03.004Z",
  };
  return { ...input, permitDigest: await computeEffectPermitDigestV1(input) };
}

async function absentEvidence(): Promise<EffectEvidenceEnvelopeV1> {
  const evidence = {
    kind: "absent" as const,
    observationScope: {
      provider: "github" as const,
      repository: { owner: "acme", repo: "demo" },
      baseBranch: "main",
      headBranch: "opentag/run_1",
      expectedHeadSha: "d".repeat(40),
      bindingGeneration: 4,
      targetBindingDigest: digest("a"),
      observationPolicy: "github.exact_draft_pr.v1" as const,
      observedAt: "2026-09-05T01:08:03.004Z",
    },
  };
  const input = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.effect-authority.v1"] as const,
    evidenceId: "evidence_1",
    effectId: "effect_1",
    permitId: "permit_1",
    effectAttemptNumber: 1,
    organizationId: "org_1",
    producer: { kind: "runner" as const, runnerId: "runner_1", runnerGeneration: 2 },
    observedAt: "2026-09-05T01:08:03.004Z",
    evidence,
    payloadDigest: await computeEffectEvidencePayloadDigestV1(evidence),
  };
  return { ...input, evidenceDigest: await computeEffectEvidenceDigestV1(input) };
}

describe("Control V1 Effect Authority transport", () => {
  it("posts one sealed logical Effect request", async () => {
    const request = await effectRequest();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(`${baseUrl}/v1/runners/runner_1/effects/request`);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer runtime_secret");
      expect(JSON.parse(String(init?.body))).toEqual(request);
      return response(effectView(), 201, String(url));
    });

    await expect(client(fetchImpl).requestEffectControlV1(request)).resolves.toEqual(effectView());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a corrupted request digest before network I/O", async () => {
    const request = await effectRequest();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(client(fetchImpl).requestEffectControlV1({
      ...request,
      requestDigest: digest("0"),
    })).rejects.toThrow("invalid_effect_request_digest");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps an empty acquire and verifies every returned permit", async () => {
    const acquire = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.effect-authority.v1"] as const,
      requestId: "acquire_1",
      organizationId: "org_1",
      runnerId: "runner_1",
      runnerGeneration: 2,
      acquireJournalDigest: digest("8"),
    };
    const emptyFetch = vi.fn<typeof fetch>(async (url) => response(undefined, 204, String(url)));
    await expect(client(emptyFetch).acquireEffectControlV1(acquire)).resolves.toBeNull();

    const permit = await executePermit();
    const permitFetch = vi.fn<typeof fetch>(async (url) => response(permit, 201, String(url)));
    await expect(client(permitFetch).acquireEffectControlV1(acquire)).resolves.toEqual(permit);

    const { permitDigest: _permitDigest, ...mismatchedJournalInput } = {
      ...permit,
      acquireJournalDigest: digest("7"),
    };
    const mismatchedJournalPermit = {
      ...mismatchedJournalInput,
      permitDigest: await computeEffectPermitDigestV1(mismatchedJournalInput),
    };
    const mismatchedJournalFetch = vi.fn<typeof fetch>(async (url) =>
      response(mismatchedJournalPermit, 201, String(url)));
    await expect(client(mismatchedJournalFetch).acquireEffectControlV1(acquire))
      .rejects.toThrow("invalid_effect_permit_identity");

    const corruptFetch = vi.fn<typeof fetch>(async (url) => response({
      ...permit,
      permitDigest: digest("0"),
    }, 201, String(url)));
    await expect(client(corruptFetch).acquireEffectControlV1(acquire))
      .rejects.toThrow("invalid_effect_permit_digest");
  });

  it("posts sealed evidence and rejects corruption before network I/O", async () => {
    const envelope = await absentEvidence();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(
        `${baseUrl}/v1/runners/runner_1/effects/effect_1/evidence`,
      );
      expect(JSON.parse(String(init?.body))).toEqual(envelope);
      return response(effectView("retry_eligible"), 201, String(url));
    });
    await expect(client(fetchImpl).recordEffectEvidenceControlV1(envelope))
      .resolves.toEqual(effectView("retry_eligible"));

    const noNetwork = vi.fn<typeof fetch>();
    await expect(client(noNetwork).recordEffectEvidenceControlV1({
      ...envelope,
      payloadDigest: digest("0"),
    })).rejects.toThrow("invalid_effect_evidence_digest");
    expect(noNetwork).not.toHaveBeenCalled();
  });
});
