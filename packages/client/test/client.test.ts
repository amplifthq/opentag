import { computeGitHubProjectTargetBindingDigestV1 } from "@opentag/control-protocol";
import { describe, expect, it } from "vitest";
import {
  createOpenTagClient,
  OpenTagControlV1HttpError
} from "../src/index.js";

function jsonResponse(
  body: unknown,
  status = 200,
  url = "http://dispatcher.test/response",
  headers: HeadersInit = {}
): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) }
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function runnerRegistrationRequest() {
  return {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.registration.v1"] as const,
    requestId: "request_registration_1",
    operationId: "operation_registration_1",
    runnerId: "runner_private_1",
    displayName: "Private runner",
    capabilities: ["relay.registration.v1"] as const
  };
}

function freshRunnerCredentialResponse(input = runnerRegistrationRequest()) {
  return {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    operationId: input.operationId,
    organizationId: "org_1",
    runnerId: input.runnerId,
    registrationGeneration: 1,
    credentialGeneration: 1,
    credentialId: "credential_runtime_1",
    credentialPurpose: "runtime" as const,
    createdAt: "2026-08-08T00:00:00.000Z",
    runnerToken: "runtime_secret_value",
    replayed: false as const
  };
}

function replayedRunnerCredentialResponse(input = runnerRegistrationRequest()) {
  const { runnerToken: _runnerToken, ...response } = freshRunnerCredentialResponse(input);
  return { ...response, replayed: true as const };
}

function projectTargetUpsertRequest() {
  return {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.repository-binding.v1"] as const,
    requestId: "request_project_target_1",
    expectedAuthority: {
      credentialId: "credential_runtime_1",
      registrationGeneration: 3,
      credentialGeneration: 2,
    },
    target: {
      projectTargetId: "target/private app",
      provider: "github" as const,
      owner: "Acme",
      repo: "Private.App",
      defaultExecutor: "codex",
      defaultBranch: "Release/V1",
    },
  };
}

const bootstrapControlCredential = {
  kind: "bootstrap_pairing" as const,
  token: "bootstrap_pairing_secret"
};

const recoveryControlCredential = {
  kind: "recovery_pairing" as const,
  token: "recovery_pairing_secret"
};

describe("@opentag/client Control V1", () => {
  it("rejects the removed dispatcherUrl option instead of treating it as an alias", () => {
    expect(() => createOpenTagClient({
      dispatcherUrl: "https://control.example",
    } as never)).toThrow("OpenTag Control Plane URL is invalid.");
  });

  it("redeems hosted source content over the authenticated paired route", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const digest = (value: string) => `sha256:${value.repeat(64)}`;
    const request = {
      schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.source-content-redeem.v1"] as const,
      requestId: "request_redeem", operationId: "operation_redeem",
      organizationId: "org_1", runnerId: "runner_1", runId: "run_1",
      expectedAuthority: { credentialId: "credential_1",
        registrationGeneration: 1, credentialGeneration: 1 },
      attempt: { attemptId: "attempt_1", attemptNumber: 1, epoch: 1,
        fencingTokenDigest: digest("1"), leaseExpiresAt: "2026-08-30T01:00:00.000Z" },
      grant: { grantId: "grant_1", token: "grant_token_1", keyVersion: "relay-v1",
        fenceDigest: digest("1"), contentIds: ["content_1"], purpose: "source_context" as const,
        expiresAt: "2026-08-30T01:00:00.000Z" },
      admissionEnvelopeDigest: digest("2"),
      contentEnvelope: { contentId: "content_1", sourceVersionRef: "source_version_1",
        aadDigest: "a".repeat(64), keyVersion: "relay-v1", envelopeDigest: digest("3"),
        payloadDigest: "sha256:282ae7754c324606c1bc679b45b0429b475518dd51732d7787b83c0c1b714f3e" },
    };
    const response = { kind: "hosted_source_content_redeemed" as const,
      schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      requestId: request.requestId, operationId: request.operationId,
      organizationId: request.organizationId, runnerId: request.runnerId,
      runId: request.runId, attempt: request.attempt,
      admissionEnvelopeDigest: request.admissionEnvelopeDigest,
      contentEnvelope: request.contentEnvelope,
      content: { contentId: "content_1", payload: { text: "private" } },
      payloadDigest: request.contentEnvelope.payloadDigest,
      redeemedAt: "2026-08-30T00:00:00.000Z" };
    const client = createOpenTagClient({ controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "runtime", token: "runtime_secret" },
      fetchImpl: async (url, init) => { requests.push({ url: String(url), init });
        return jsonResponse(response, 200, String(url)); } });

    await expect(client.redeemHostedSourceContentControlV1({ runnerId: "runner_1", request }))
      .resolves.toEqual(response);
    expect(requests[0]?.url).toBe(
      "http://dispatcher.test/v1/runners/runner_1/runs/run_1/source-content/redeem",
    );
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: "Bearer runtime_secret" });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(request);
  });
  it("fetches strict runner control context with the runtime credential", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const context = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      contextKind: "runner_control" as const,
      organizationId: "org_1",
      runnerId: "runner_private_1",
      credentialId: "credential_runtime_1",
      registrationGeneration: 1,
      credentialGeneration: 1,
      capabilities: ["relay.readiness.v1"] as const,
      targets: [{
        projectTargetId: "target_1",
        bindingDigest: `sha256:${"a".repeat(64)}`,
        provider: "github",
        owner: "acme",
        repo: "app",
        defaultExecutor: "echo",
        defaultBranch: "main",
      }],
      observedAt: "2026-08-09T00:00:00.000Z",
    };
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "runtime", token: "runtime_secret" },
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
        return jsonResponse(context, 200, String(url));
      },
    });
    await expect(client.getRunnerControlContextV1({ runnerId: "runner_private_1" })).resolves.toEqual(context);
    expect(requests).toEqual([{
      url: "http://dispatcher.test/v1/runners/runner_private_1/control-context",
      authorization: "Bearer runtime_secret",
    }]);
  });

  it("upserts one canonical GitHub Project Target with runtime authority and returns its strict context readback", async () => {
    const input = projectTargetUpsertRequest();
    const canonicalTarget = {
      ...input.target,
      owner: "acme",
      repo: "private.app",
    };
    const bindingDigest = await computeGitHubProjectTargetBindingDigestV1(
      canonicalTarget,
    );
    const context = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      contextKind: "runner_control" as const,
      organizationId: "org_1",
      runnerId: "runner/private 1",
      credentialId: input.expectedAuthority.credentialId,
      registrationGeneration: input.expectedAuthority.registrationGeneration,
      credentialGeneration: input.expectedAuthority.credentialGeneration,
      capabilities: ["relay.repository-binding.v1"] as const,
      targets: [{
        projectTargetId: canonicalTarget.projectTargetId,
        bindingDigest,
        provider: canonicalTarget.provider,
        owner: canonicalTarget.owner,
        repo: canonicalTarget.repo,
        defaultExecutor: canonicalTarget.defaultExecutor,
        defaultBranch: canonicalTarget.defaultBranch,
      }],
      observedAt: "2026-08-09T00:00:00.000Z",
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test/",
      controlCredential: { kind: "runtime", token: "runtime_secret" },
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse(context, 200, String(url));
      },
    });

    await expect(client.upsertRunnerProjectTargetControlV1({
      runnerId: context.runnerId,
      projectTargetId: input.target.projectTargetId,
      request: input,
    })).resolves.toEqual(context);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "http://dispatcher.test/v1/runners/runner%2Fprivate%201/project-targets/target%2Fprivate%20app",
    );
    expect(requests[0]?.init?.method).toBe("PUT");
    expect(new Headers(requests[0]?.init?.headers).get("authorization"))
      .toBe("Bearer runtime_secret");
    const requestBody = JSON.parse(String(requests[0]?.init?.body));
    expect(requestBody).toEqual({ ...input, target: canonicalTarget });
    expect(requestBody.target).not.toHaveProperty("bindingDigest");
  });

  it("rejects a Project Target route/body identity mismatch before transport", async () => {
    let requested = false;
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "runtime", token: "runtime_secret" },
      fetchImpl: async () => {
        requested = true;
        return jsonResponse({});
      },
    });
    await expect(client.upsertRunnerProjectTargetControlV1({
      runnerId: "runner_1",
      projectTargetId: "target_other",
      request: projectTargetUpsertRequest(),
    })).rejects.toThrow("Project Target route identity does not match");
    expect(requested).toBe(false);
  });

  it.each([
    ["unknown response field", "invalid_control_v1_response", { extra: true }],
    ["credential identity mismatch", "response_identity_mismatch", { credentialId: "credential_other" }],
    ["generation mismatch", "response_generation_mismatch", { credentialGeneration: 3 }],
  ])("fails closed for a Project Target %s", async (_caseName, expectedFailure, override) => {
    const input = projectTargetUpsertRequest();
    const canonicalTarget = { ...input.target, owner: "acme", repo: "private.app" };
    const context = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      contextKind: "runner_control",
      organizationId: "org_1",
      runnerId: "runner_1",
      credentialId: input.expectedAuthority.credentialId,
      registrationGeneration: input.expectedAuthority.registrationGeneration,
      credentialGeneration: input.expectedAuthority.credentialGeneration,
      capabilities: ["relay.repository-binding.v1"],
      targets: [{
        projectTargetId: canonicalTarget.projectTargetId,
        bindingDigest: await computeGitHubProjectTargetBindingDigestV1(canonicalTarget),
        provider: "github",
        owner: canonicalTarget.owner,
        repo: canonicalTarget.repo,
        defaultExecutor: canonicalTarget.defaultExecutor,
        defaultBranch: canonicalTarget.defaultBranch,
      }],
      observedAt: "2026-08-09T00:00:00.000Z",
      ...override,
    };
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "runtime", token: "runtime_secret" },
      fetchImpl: async (url) => jsonResponse(context, 200, String(url)),
    });
    await expect(client.upsertRunnerProjectTargetControlV1({
      runnerId: "runner_1",
      projectTargetId: input.target.projectTargetId,
      request: input,
    })).rejects.toMatchObject({
      status: 200,
      responseBody: expectedFailure,
    });
  });

  it("rejects a Project Target readback whose binding digest does not commit to the declaration", async () => {
    const input = projectTargetUpsertRequest();
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "runtime", token: "runtime_secret" },
      fetchImpl: async (url) => jsonResponse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        contextKind: "runner_control",
        organizationId: "org_1",
        runnerId: "runner_1",
        credentialId: input.expectedAuthority.credentialId,
        registrationGeneration: input.expectedAuthority.registrationGeneration,
        credentialGeneration: input.expectedAuthority.credentialGeneration,
        capabilities: ["relay.repository-binding.v1"],
        targets: [{
          projectTargetId: input.target.projectTargetId,
          bindingDigest: `sha256:${"f".repeat(64)}`,
          provider: "github",
          owner: "acme",
          repo: "private.app",
          defaultExecutor: input.target.defaultExecutor,
          defaultBranch: input.target.defaultBranch,
        }],
        observedAt: "2026-08-09T00:00:00.000Z",
      }, 200, String(url)),
    });
    await expect(client.upsertRunnerProjectTargetControlV1({
      runnerId: "runner_1",
      projectTargetId: input.target.projectTargetId,
      request: input,
    })).rejects.toMatchObject({
      status: 200,
      responseBody: "response_identity_mismatch",
    });
  });

  it("requires a Project Target error response to echo the mutation requestId", async () => {
    const input = projectTargetUpsertRequest();
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "runtime", token: "runtime_secret" },
      fetchImpl: async (url) => jsonResponse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        error: "stale_control_authority",
        message: "The runtime authority is stale.",
        requestId: "request_other",
      }, 409, String(url)),
    });
    await expect(client.upsertRunnerProjectTargetControlV1({
      runnerId: "runner_1",
      projectTargetId: input.target.projectTargetId,
      request: input,
    })).rejects.toMatchObject({
      status: 409,
      responseBody: "response_identity_mismatch",
    });
  });

  it("preserves target_not_bound_to_slack when the conflict matches the mutation requestId", async () => {
    const input = projectTargetUpsertRequest();
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "runtime", token: "runtime_secret" },
      fetchImpl: async (url) => jsonResponse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        error: "target_not_bound_to_slack",
        message: "The Project Target is not referenced by an active Slack binding.",
        requestId: input.requestId,
      }, 409, String(url)),
    });
    const failure = await client.upsertRunnerProjectTargetControlV1({
      runnerId: "runner_1",
      projectTargetId: input.target.projectTargetId,
      request: input,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OpenTagControlV1HttpError);
    expect(failure).toMatchObject({
      status: 409,
      code: "target_not_bound_to_slack",
      requestId: input.requestId,
    });
  });

  it("preserves the server requestId for relay-capabilities GET errors", async () => {
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      fetchImpl: async (url) => jsonResponse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        error: "protocol_upgrade_required",
        message: "Upgrade required.",
        requestId: "request_capabilities_426",
        supported: { schemaVersions: [1], protocolVersions: ["1.0"] },
        nextAction: "upgrade_client",
      }, 426, String(url)),
    });
    const failure = await client.getRelayCapabilitiesControlV1()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OpenTagControlV1HttpError);
    expect(failure).toMatchObject({
      status: 426,
      code: "protocol_upgrade_required",
      requestId: "request_capabilities_426",
    });
  });

  it("rejects cross-runner and unknown-field control context responses", async () => {
    const base = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      contextKind: "runner_control",
      organizationId: "org_1",
      runnerId: "runner_other",
      credentialId: "credential_runtime_1",
      registrationGeneration: 1,
      credentialGeneration: 1,
      capabilities: ["relay.readiness.v1"],
      targets: [],
      observedAt: "2026-08-09T00:00:00.000Z",
    };
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "runtime", token: "runtime_secret" },
      fetchImpl: async (url) => jsonResponse({ ...base, extra: true }, 200, String(url)),
    });
    await expect(client.getRunnerControlContextV1({ runnerId: "runner_private_1" })).rejects.toMatchObject({
      status: 200,
      responseBody: "invalid_control_v1_response",
    });
  });

  it("preserves the server requestId for runner control-context errors", async () => {
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "runtime", token: "runtime_secret" },
      fetchImpl: async (url) => jsonResponse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        error: "missing_or_concealed",
        message: "Runner not found.",
        requestId: "request_context_404",
      }, 404, String(url)),
    });
    const failure = await client
      .getRunnerControlContextV1({ runnerId: "runner_private_1" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OpenTagControlV1HttpError);
    expect(failure).toMatchObject({
      status: 404,
      code: "missing_or_concealed",
      requestId: "request_context_404",
    });
  });

  it("passes the configured abort signal to strict Control V1 requests", async () => {
    const abort = new AbortController();
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "runtime", token: "runtime_secret" },
      controlSignal: abort.signal,
      fetchImpl: async (url, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init?.signal).not.toBe(abort.signal);
        expect(init?.signal?.aborted).toBe(false);
        return jsonResponse({
          schemaVersion: 1,
          protocolVersion: "1.0",
          contextKind: "runner_control",
          organizationId: "org_1",
          runnerId: "runner_1",
          credentialId: "credential_1",
          registrationGeneration: 1,
          credentialGeneration: 1,
          capabilities: [],
          targets: [],
          observedAt: "2026-08-09T00:00:00.000Z",
        }, 200, String(url));
      },
    });
    await client.getRunnerControlContextV1({ runnerId: "runner_1" });
  });

  it("bounds strict Control V1 requests with an abortable timeout", async () => {
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "runtime", token: "runtime_secret" },
      controlTimeoutMs: 1,
      fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      }),
    });
    await expect(client.getRunnerControlContextV1({ runnerId: "runner_1" })).rejects.toMatchObject({
      status: 0,
      responseBody: "transport_failed",
    });
  });

  it("does not disguise an ordinary fetch implementation error as a transport failure", async () => {
    const failure = new Error("fetch_adapter_bug");
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "runtime", token: "runtime_secret" },
      fetchImpl: async () => { throw failure; },
    });
    await expect(client.getRunnerControlContextV1({ runnerId: "runner_1" }))
      .rejects.toBe(failure);
  });

  it("requires explicit bootstrap authority before Control V1 registration", async () => {
    let requested = false;
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      fetchImpl: async () => {
        requested = true;
        return jsonResponse(freshRunnerCredentialResponse(), 201);
      }
    });

    const failure = await client
      .registerRunnerControlV1(runnerRegistrationRequest())
      .catch((caught: unknown) => caught);

    expect(requested).toBe(false);
    expect(String(failure)).toContain(
      "required=bootstrap_pairing actual=missing"
    );
  });

  it.each([
    ["empty", ""],
    ["all-whitespace", " \t "]
  ])("rejects an %s bootstrap token before Control V1 transport", async (_caseName, token) => {
    let requested = false;
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "bootstrap_pairing", token },
      fetchImpl: async () => {
        requested = true;
        return jsonResponse(freshRunnerCredentialResponse(), 201);
      }
    });

    const failure = await client
      .registerRunnerControlV1(runnerRegistrationRequest())
      .catch((caught: unknown) => caught);

    expect(requested).toBe(false);
    expect(String(failure)).toContain(
      "required=bootstrap_pairing actual=bootstrap_pairing"
    );
  });

  it("rejects a runtime credential before Control V1 re-provision transport", async () => {
    const secret = "runtime_secret_must_not_escape";
    let requested = false;
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: { kind: "runtime", token: secret },
      fetchImpl: async () => {
        requested = true;
        return jsonResponse(freshRunnerCredentialResponse(), 201);
      }
    });

    const failure = await client.reprovisionRunnerControlV1({
      schemaVersion: 1,
      protocolVersion: "1.0",
      requiredCapabilities: ["relay.credential-reprovision.v1"],
      requestId: "request_wrong_runtime_kind",
      operationId: "operation_wrong_runtime_kind",
      runnerId: "runner_private_1",
      recoveryCredentialId: "recovery_credential_1",
      expectedRegistrationGeneration: 1,
      expectedCredentialGeneration: 1
    }).catch((caught: unknown) => caught);

    expect(requested).toBe(false);
    expect(String(failure)).toContain(
      "required=recovery_pairing actual=runtime"
    );
    expect(String(failure)).not.toContain(secret);
  });

  it("registers a Control V1 runner and returns only the strict fresh credential body", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const input = runnerRegistrationRequest();
    const responseBody = freshRunnerCredentialResponse(input);
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test/",
      controlCredential: bootstrapControlCredential,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse(responseBody, 201);
      }
    });

    await expect(client.registerRunnerControlV1(input)).resolves.toEqual(responseBody);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/runners");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(new Headers(requests[0]?.init?.headers).get("authorization"))
      .toBe("Bearer bootstrap_pairing_secret");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(input);
  });

  it("accepts a metadata-only Control V1 registration replay", async () => {
    const input = runnerRegistrationRequest();
    const responseBody = replayedRunnerCredentialResponse(input);
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: bootstrapControlCredential,
      fetchImpl: async () => jsonResponse(responseBody, 200)
    });

    await expect(client.registerRunnerControlV1(input)).resolves.toEqual(responseBody);
    expect(responseBody).not.toHaveProperty("runnerToken");
  });

  it.each([
    ["fresh registration generation", 201, { registrationGeneration: 2 }],
    ["fresh credential generation", 201, { credentialGeneration: 2 }],
    ["replayed registration generation", 200, { registrationGeneration: 2 }],
    ["replayed credential generation", 200, { credentialGeneration: 2 }]
  ])("fails closed for an invalid %s", async (_caseName, status, override) => {
    const input = runnerRegistrationRequest();
    const baseResponse = status === 201
      ? freshRunnerCredentialResponse(input)
      : replayedRunnerCredentialResponse(input);
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: bootstrapControlCredential,
      fetchImpl: async () => jsonResponse({ ...baseResponse, ...override }, status)
    });

    await expect(client.registerRunnerControlV1(input)).rejects.toMatchObject({
      name: "OpenTagClientHttpError",
      status,
      responseBody: "response_generation_mismatch"
    });
  });

  it.each([
    ["status-body mismatch", replayedRunnerCredentialResponse(), 201],
    ["unknown response field", { ...freshRunnerCredentialResponse(), unexpected: true }, 201],
    ["malformed response body", { ok: true }, 201]
  ])("fails closed for %s", async (_caseName, body, status) => {
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: bootstrapControlCredential,
      fetchImpl: async () => jsonResponse(body, status)
    });

    await expect(client.registerRunnerControlV1(runnerRegistrationRequest())).rejects.toMatchObject({
      name: "OpenTagClientHttpError",
      status,
      responseBody: "invalid_control_v1_response"
    });
  });

  it.each([
    ["operation", { operationId: "operation_other" }],
    ["runner", { runnerId: "runner_other" }]
  ])("fails closed for a %s identity mismatch", async (_caseName, override) => {
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: bootstrapControlCredential,
      fetchImpl: async () => jsonResponse({ ...freshRunnerCredentialResponse(), ...override }, 201)
    });

    await expect(client.registerRunnerControlV1(runnerRegistrationRequest())).rejects.toMatchObject({
      name: "OpenTagClientHttpError",
      status: 201,
      responseBody: "response_identity_mismatch"
    });
  });

  it("rejects unknown Control V1 request fields before transport", async () => {
    let requested = false;
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: bootstrapControlCredential,
      fetchImpl: async () => {
        requested = true;
        return jsonResponse(freshRunnerCredentialResponse(), 201);
      }
    });
    const input = { ...runnerRegistrationRequest(), unexpected: true } as Parameters<
      typeof client.registerRunnerControlV1
    >[0];

    await expect(client.registerRunnerControlV1(input)).rejects.toMatchObject({ name: "ZodError" });
    expect(requested).toBe(false);
  });

  it("re-provisions through the runner-scoped endpoint using the recovery credential channel", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const input = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.credential-reprovision.v1"] as const,
      requestId: "request_reprovision_1",
      operationId: "operation_reprovision_1",
      runnerId: "runner/private 1",
      recoveryCredentialId: "recovery_credential_1",
      expectedRegistrationGeneration: 1,
      expectedCredentialGeneration: 1
    };
    const responseBody = {
      ...freshRunnerCredentialResponse(),
      operationId: input.operationId,
      runnerId: input.runnerId,
      registrationGeneration: 2,
      credentialGeneration: 2,
      credentialId: "credential_runtime_2"
    };
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: recoveryControlCredential,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse(responseBody, 201);
      }
    });

    await expect(client.reprovisionRunnerControlV1(input)).resolves.toEqual(responseBody);
    expect(requests[0]?.url).toBe(
      "http://dispatcher.test/v1/runners/runner%2Fprivate%201/credentials/reprovision"
    );
    expect(new Headers(requests[0]?.init?.headers).get("authorization"))
      .toBe("Bearer recovery_pairing_secret");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(input);
  });

  it("accepts a metadata-only re-provision replay with the exact next generations", async () => {
    const input = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.credential-reprovision.v1"] as const,
      requestId: "request_reprovision_replay",
      operationId: "operation_reprovision_replay",
      runnerId: "runner_private_1",
      recoveryCredentialId: "recovery_credential_1",
      expectedRegistrationGeneration: 4,
      expectedCredentialGeneration: 7
    };
    const responseBody = {
      ...replayedRunnerCredentialResponse(input),
      registrationGeneration: 5,
      credentialGeneration: 8,
      credentialId: "credential_runtime_8"
    };
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: recoveryControlCredential,
      fetchImpl: async () => jsonResponse(responseBody, 200)
    });

    await expect(client.reprovisionRunnerControlV1(input)).resolves.toEqual(responseBody);
    expect(responseBody).not.toHaveProperty("runnerToken");
  });

  it.each([
    ["stale registration in a 201", 201, { registrationGeneration: 4, credentialGeneration: 8 }],
    ["rolled-back registration in a 201", 201, { registrationGeneration: 3, credentialGeneration: 8 }],
    ["stale credential in a 201", 201, { registrationGeneration: 5, credentialGeneration: 7 }],
    ["stale registration in a 200 replay", 200, { registrationGeneration: 4, credentialGeneration: 8 }],
    ["advanced credential in a 200 replay", 200, { registrationGeneration: 5, credentialGeneration: 9 }]
  ])("fails closed for a %s", async (_caseName, status, generations) => {
    const input = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.credential-reprovision.v1"] as const,
      requestId: "request_reprovision_generation_mismatch",
      operationId: "operation_reprovision_generation_mismatch",
      runnerId: "runner_private_1",
      recoveryCredentialId: "recovery_credential_1",
      expectedRegistrationGeneration: 4,
      expectedCredentialGeneration: 7
    };
    const baseResponse = status === 201
      ? freshRunnerCredentialResponse(input)
      : replayedRunnerCredentialResponse(input);
    const responseBody = {
      ...baseResponse,
      ...generations,
      runnerToken: "must_not_escape_generation_failure"
    };
    if (status === 200) delete (responseBody as { runnerToken?: string }).runnerToken;
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: recoveryControlCredential,
      fetchImpl: async () => jsonResponse(responseBody, status)
    });

    await expect(client.reprovisionRunnerControlV1(input)).rejects.toMatchObject({
      name: "OpenTagClientHttpError",
      status,
      responseBody: "response_generation_mismatch"
    });
  });

  it.each([
    [400, "invalid_request_body", {}],
    [401, "invalid_credential", {}],
    [403, "insufficient_scope", {}],
    [404, "missing_or_concealed", {}],
    [409, "idempotency_conflict", {}],
    [412, "capability_required", { requiredCapabilities: ["relay.registration.v1"] }],
    [413, "request_body_too_large", {}],
    [422, "observation_policy_mismatch", {}],
    [426, "protocol_upgrade_required", {
      supported: { schemaVersions: [1], protocolVersions: ["1.0"] },
      nextAction: "upgrade_client"
    }]
  ])("maps typed Control V1 error status %i without retaining its raw body", async (status, error, extra) => {
    const input = runnerRegistrationRequest();
    const body = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      error,
      message: "Diagnostic raw_runtime_secret_value must not be retained.",
      requestId: input.requestId,
      ...extra
    };
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: bootstrapControlCredential,
      fetchImpl: async () => jsonResponse(body, status)
    });

    const failure = await client.registerRunnerControlV1(input).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(OpenTagControlV1HttpError);
    expect(failure).toMatchObject({
      name: "OpenTagControlV1HttpError",
      status,
      code: error,
      requestId: input.requestId
    });
    expect(String(failure)).not.toContain("Diagnostic");
    expect(String(failure)).not.toContain("raw_runtime_secret_value");
    expect(failure).not.toHaveProperty("responseBody");
  });

  it("maps a strict registration 429 with sanitized retry metadata", async () => {
    const input = runnerRegistrationRequest();
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: bootstrapControlCredential,
      fetchImpl: async () => jsonResponse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        error: "rate_limited",
        message: "registration_429_body_canary",
        requestId: input.requestId,
        retryAfterSeconds: 11
      }, 429, "http://dispatcher.test/v1/runners", {
        "retry-after": "11",
        "x-secret-canary": "registration_429_header_canary"
      })
    });

    const failure = await client.registerRunnerControlV1(input).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(OpenTagControlV1HttpError);
    expect(failure).toMatchObject({
      status: 429,
      code: "rate_limited",
      requestId: input.requestId,
      retryAfterSeconds: 11
    });
    expect(String(failure)).not.toContain("canary");
  });

  it.each([
    ["missing header", {}, { retryAfterSeconds: 11 }],
    ["mismatched header", { "retry-after": "12" }, { retryAfterSeconds: 11 }],
    ["malformed body", { "retry-after": "11" }, { retryAfterSeconds: "11" }]
  ])("rejects a registration 429 with %s", async (_name, headers, extra) => {
    const input = runnerRegistrationRequest();
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: bootstrapControlCredential,
      fetchImpl: async () => jsonResponse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        error: "rate_limited",
        message: "registration_429_body_canary",
        requestId: input.requestId,
        ...extra
      }, 429, "http://dispatcher.test/v1/runners", headers)
    });

    const failure = await client.registerRunnerControlV1(input).catch((caught: unknown) => caught);
    expect(failure).toMatchObject({ responseBody: "invalid_control_v1_response" });
    expect(String(failure)).not.toContain("canary");
  });

  it("fails closed when a valid Control V1 error has a mismatched request identity", async () => {
    const input = runnerRegistrationRequest();
    const body = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      error: "invalid_credential",
      message: "raw_runtime_secret_value",
      requestId: "request_from_another_operation"
    };
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: bootstrapControlCredential,
      fetchImpl: async () => jsonResponse(body, 401)
    });

    const failure = await client.registerRunnerControlV1(input).catch((caught: unknown) => caught);
    expect(failure).toMatchObject({
      name: "OpenTagClientHttpError",
      status: 401,
      responseBody: "response_identity_mismatch"
    });
    expect(String(failure)).not.toContain("raw_runtime_secret_value");
    expect(String(failure)).not.toContain("request_from_another_operation");
  });

  it("reports invalid JSON without retaining response content", async () => {
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: bootstrapControlCredential,
      fetchImpl: async () => {
        const response = new Response("not-json-runtime_secret_value", { status: 201 });
        Object.defineProperty(response, "url", { value: "http://dispatcher.test/v1/runners" });
        return response;
      }
    });

    await expect(client.registerRunnerControlV1(runnerRegistrationRequest())).rejects.toMatchObject({
      name: "OpenTagClientHttpError",
      status: 201,
      responseBody: "invalid_json_response"
    });
  });

  it("sanitizes Control V1 transport failures without synthesizing a credential response", async () => {
    const failure = new TypeError("network unavailable with runtime_secret_value");
    const client = createOpenTagClient({
      controlPlaneUrl: "http://dispatcher.test",
      controlCredential: bootstrapControlCredential,
      fetchImpl: async () => {
        throw failure;
      }
    });

    const caught = await client.registerRunnerControlV1(runnerRegistrationRequest())
      .catch((error: unknown) => error);
    expect(caught).toMatchObject({
      name: "OpenTagClientHttpError",
      status: 0,
      responseBody: "transport_failed"
    });
    expect(String(caught)).not.toContain("runtime_secret_value");
  });
});
