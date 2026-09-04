import type { RunnerReadinessReceiptEnvelopeV1 } from "@opentag/control-protocol";
import { describe, expect, it } from "vitest";
import {
  createOpenTagClient,
  OpenTagControlV1HttpError,
} from "../src/index.js";

const digest = `sha256:${"1".repeat(64)}`;
const otherDigest = `sha256:${"2".repeat(64)}`;
const observedAt = "2026-08-08T00:00:00.000Z";

function jsonResponse(
  body: unknown,
  status = 200,
  url = "https://control.example/response",
  headers: HeadersInit = {},
): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function readiness(): RunnerReadinessReceiptEnvelopeV1 {
  return {
    schemaVersion: 1,
    protocolVersion: "1.0",
    receiptKind: "runner_readiness",
    receiptId: "receipt_readiness_1",
    organizationId: "org_1",
    operationId: "op_readiness_1",
    requiredCapabilities: ["relay.readiness.v1"],
    producer: {
      kind: "runner",
      id: "runner_1",
      credentialId: "runtime_credential_1",
      registrationGeneration: 1,
    },
    identity: {
      namespace: "opentag.control.receipt/runner-readiness/v1",
      parts: ["org_1", "runner_1", "1", "readiness_1"],
    },
    observedAt,
    payload: {
      readinessId: "readiness_1",
      runnerId: "runner_1",
      registrationGeneration: 1,
      capabilities: ["relay.readiness.v1"],
      executors: [],
      targets: [],
      observedAt,
      expiresAt: "2026-08-08T00:01:00.000Z",
    },
    payloadDigest: digest,
    receiptDigest: otherDigest,
  };
}

function client(fetchImpl: typeof fetch) {
  return createOpenTagClient({
    controlPlaneUrl: "https://control.example/base",
    controlCredential: { kind: "runtime", token: "runtime_header_canary" },
    fetchImpl,
  });
}

describe("Control V1 readiness receipt transport", () => {
  it("parses the strict capability handshake and uses manual redirects", async () => {
    let init: RequestInit | undefined;
    const body = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      registryVersion: "opentag.control.capabilities/v1",
      capabilities: ["relay.readiness.v1"],
      minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
      deployment: { environment: "test", releaseSha: "a".repeat(40) },
    };
    const result = await client(async (_url, requestInit) => {
      init = requestInit;
      return jsonResponse(
        body,
        200,
        "https://control.example/v1/relay/capabilities",
      );
    }).getRelayCapabilitiesControlV1();

    expect(result).toEqual(body);
    expect(init?.redirect).toBe("manual");
  });

  it("posts and strictly parses a fresh readiness receipt", async () => {
    const receipt = readiness();
    let requestUrl = "";
    let init: RequestInit | undefined;
    const result = await client(async (url, requestInit) => {
      requestUrl = String(url);
      init = requestInit;
      return jsonResponse(
        receipt,
        201,
        "https://control.example/v1/runners/runner_1/readiness",
      );
    }).reportRunnerReadinessControlV1(receipt);

    expect(result).toEqual({
      status: 201,
      replayed: false,
      outcome: "accepted",
      receipt,
    });
    expect(requestUrl).toBe(
      "https://control.example/base/v1/runners/runner_1/readiness",
    );
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer runtime_header_canary",
    );
    expect(JSON.parse(String(init?.body))).toEqual(receipt);
  });

  it("returns stable replay metadata without presenting replay as fresh", async () => {
    const receipt = readiness();
    const result = await client(async () => jsonResponse(receipt, 200))
      .reportRunnerReadinessControlV1(receipt);

    expect(result).toEqual({
      status: 200,
      replayed: true,
      outcome: "accepted",
      receipt,
    });
  });

  it.each([
    ["receiptKind", "invalid_control_v1_response", () => ({
      ...readiness(),
      receiptKind: "completion_assessment",
    })],
    ["identity namespace", "invalid_control_v1_response", () => ({
      ...readiness(),
      identity: {
        ...readiness().identity,
        namespace: "opentag.control.receipt/other/v1",
      },
    })],
    ["identity parts", "invalid_control_v1_response", () => ({
      ...readiness(),
      identity: {
        ...readiness().identity,
        parts: ["org_1", "runner_other", "1", "readiness_1"],
      },
    })],
    ["payload digest", "response_identity_mismatch", () => ({
      ...readiness(),
      payloadDigest: otherDigest,
    })],
    ["full payload", "response_identity_mismatch", () => ({
      ...readiness(),
      payload: {
        ...readiness().payload,
        capabilities: ["relay.lifecycle.v1", "relay.readiness.v1"],
      },
    })],
  ])("rejects a response whose %s differs", async (_name, reason, mutate) => {
    const request = readiness();
    await expect(
      client(async () => jsonResponse(mutate(), 201))
        .reportRunnerReadinessControlV1(request),
    ).rejects.toMatchObject({ responseBody: reason });
  });

  it.each([
    [404, "missing_or_concealed", {}],
    [409, "stale_attempt", {}],
    [412, "capability_required", { requiredCapabilities: ["relay.readiness.v1"] }],
    [422, "observation_policy_mismatch", {}],
    [426, "protocol_upgrade_required", {
      supported: { schemaVersions: [1], protocolVersions: ["1.0"] },
      nextAction: "upgrade_client",
    }],
  ])("maps fail-closed status %i to its allowlisted reason", async (
    status,
    error,
    extra,
  ) => {
    const receipt = readiness();
    const sdk = client(async () => jsonResponse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      error,
      message: "body_secret_canary",
      requestId: "request_body_token_canary",
      ...extra,
    }, status));

    const failure = await sdk.reportRunnerReadinessControlV1(receipt)
      .catch((caught) => caught);
    expect(failure).toBeInstanceOf(OpenTagControlV1HttpError);
    expect(failure).toMatchObject({ status, code: error });
    expect(String(failure)).not.toContain("body_secret_canary");
    expect(String(failure)).not.toContain("request_body_token_canary");
  });

  it("maps a strict receipt 429 with sanitized retry metadata", async () => {
    const receipt = readiness();
    const sdk = client(async () => jsonResponse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      error: "rate_limited",
      message: "receipt_429_body_canary",
      requestId: "receipt_429_request_canary",
      retryAfterSeconds: 7,
    }, 429, "https://control.example/v1/runners/runner_1/readiness", {
      "retry-after": "7",
      "x-secret-canary": "receipt_429_header_canary",
    }));

    const failure = await sdk.reportRunnerReadinessControlV1(receipt)
      .catch((caught) => caught);
    expect(failure).toBeInstanceOf(OpenTagControlV1HttpError);
    expect(failure).toMatchObject({
      status: 429,
      code: "rate_limited",
      requestId: "unavailable",
      retryAfterSeconds: 7,
    });
    expect(String(failure)).not.toContain("canary");
  });

  it.each([
    ["missing header", {}, { retryAfterSeconds: 7 }],
    ["mismatched header", { "retry-after": "8" }, { retryAfterSeconds: 7 }],
    ["malformed body", { "retry-after": "7" }, { retryAfterSeconds: "7" }],
  ])("rejects a receipt 429 with %s", async (_name, headers, extra) => {
    const receipt = readiness();
    const sdk = client(async () => jsonResponse({
      schemaVersion: 1,
      protocolVersion: "1.0",
      error: "rate_limited",
      message: "receipt_429_body_canary",
      requestId: "receipt_429_request_canary",
      ...extra,
    }, 429, "https://control.example/v1/runners/runner_1/readiness", headers));

    const failure = await sdk.reportRunnerReadinessControlV1(receipt)
      .catch((caught) => caught);
    expect(failure).toMatchObject({ responseBody: "invalid_control_v1_response" });
    expect(String(failure)).not.toContain("canary");
  });

  it("rejects unknown request fields before fetch", async () => {
    let fetched = false;
    const input = { ...readiness(), plaintextCredential: "body_token_canary" };
    const sdk = client(async () => {
      fetched = true;
      return jsonResponse(input, 201);
    });

    await expect(
      sdk.reportRunnerReadinessControlV1(
        input as RunnerReadinessReceiptEnvelopeV1,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(fetched).toBe(false);
  });

  it("rejects unknown response fields without leaking response data", async () => {
    const receipt = readiness();
    const sdk = client(async () => jsonResponse({
      ...receipt,
      receiptId: "body_secret_canary",
      unexpected: "response_token_canary",
    }, 201));

    const failure = await sdk.reportRunnerReadinessControlV1(receipt)
      .catch((caught) => caught);
    expect(failure).toMatchObject({ responseBody: "invalid_control_v1_response" });
    expect(String(failure)).not.toContain("canary");
  });

  it.each([
    ["same-origin", "https://control.example/redirected"],
    ["cross-origin", "https://attacker.example/redirected"],
  ])("rejects a %s redirect without following it", async (_name, url) => {
    let calls = 0;
    const sdk = client(async (_requestUrl, init) => {
      calls += 1;
      expect(init?.redirect).toBe("manual");
      return jsonResponse({}, 302, url);
    });

    await expect(
      sdk.reportRunnerReadinessControlV1(readiness()),
    ).rejects.toMatchObject({ responseBody: "redirect_rejected" });
    expect(calls).toBe(1);
  });

  it("rejects a successful response from a different origin", async () => {
    const receipt = readiness();
    const sdk = client(async () => jsonResponse(
      receipt,
      201,
      "https://attacker.example/v1/runners/runner_1/readiness",
    ));

    await expect(
      sdk.reportRunnerReadinessControlV1(receipt),
    ).rejects.toMatchObject({ responseBody: "response_origin_mismatch" });
  });

  it("rejects a response whose final origin cannot be proven", async () => {
    const receipt = readiness();
    const sdk = client(async () => {
      const response = new Response(JSON.stringify(receipt), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
      expect(response.url).toBe("");
      return response;
    });

    await expect(
      sdk.reportRunnerReadinessControlV1(receipt),
    ).rejects.toMatchObject({ responseBody: "response_origin_unverifiable" });
  });

  it("sanitizes transport failures containing URL, header, and body canaries", async () => {
    const sdk = client(async () => {
      throw new TypeError(
        "https://attacker.example/?token=url_token_canary Authorization=runtime_header_canary body_token_canary",
      );
    });

    const failure = await sdk.reportRunnerReadinessControlV1(readiness())
      .catch((caught) => caught);
    expect(failure).toMatchObject({ status: 0, responseBody: "transport_failed" });
    expect(String(failure)).not.toContain("canary");
  });
});
