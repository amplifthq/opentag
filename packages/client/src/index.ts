import {
  canonicalJsonStringify,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeGitHubProjectTargetBindingDigestV1,
  computeHostedClaimFencingTokenDigestV1,
  computeHostedLifecycleRequestDigestV1,
  computeHostedLifecycleRequestIdV1,
  computeMaterialActionFencingTokenDigestV1,
  computeMaterialActionPayloadDigestV1,
  computeMaterialActionReceiptDigestV1,
  computePermissionFencingTokenDigestV1,
  computePermissionRequestDigestV1,
  ControlErrorHttpResponseV1Schema,
  HostedClaimRequestV1Schema,
  HostedClaimV1Schema,
  HostedCompleteRequestV1Schema,
  HostedHeartbeatRequestV1Schema,
  HostedLifecycleReceiptEnvelopeV1Schema,
  HostedProgressRequestV1Schema,
  HostedRejectStartRequestV1Schema,
  HostedRunningRequestV1Schema,
  HostedSourceContentRedeemRequestV1Schema,
  HostedSourceContentRedeemResponseV1Schema,
  verifyHostedSourceContentRedeemPayloadV1,
  RunnerBranchOwnershipAttestationV1Schema,
  MaterialActionReceiptEnvelopeV1Schema,
  MaterialActionReconcileHttpResponseV1Schema,
  MaterialActionStableIdV1Schema,
  PermissionResolutionCurrentHttpResponseV1Schema,
  RelayCapabilitiesResponseV1Schema,
  RunnerControlContextResponseV1Schema,
  GitHubProjectTargetDeclarationV1Schema,
  RunnerProjectTargetUpsertRequestV1Schema,
  RunnerProjectTargetUpsertResponseV1Schema,
  RunnerCredentialHttpResponseV1Schema,
  RunnerCredentialReprovisionRequestV1Schema,
  RunnerMaterialActionReconcileAttemptV1Schema,
  RunnerMaterialActionReconcileRequestV1Schema,
  RunnerMaterialActionBeginV1Schema,
  PublicationOperationCapabilityV1Schema,
  PublicationOperationReceiptV1Schema,
  RunnerPublicationBeginV1Schema,
  RunnerPublicationClaimNextV1Schema,
  RunnerPublicationCompletionV1Schema,
  RunnerPublicationCompletionPendingV1Schema,
  RunnerPublicationReconciliationPendingV1Schema,
  RunnerPublicationReceiptV1Schema,
  RunnerPublicationReconcileV1Schema,
  RunnerPermissionCurrentQueryV1Schema,
  RunnerPermissionRequestHttpResponseV1Schema,
  RunnerPermissionRequestV1Schema,
  RunnerProposalSettlementResponseV1Schema,
  RunnerProposalSettlementV1Schema,
  RunnerReadinessReceiptEnvelopeV1Schema,
  RunnerRegistrationRequestV1Schema,
  verifyHostedAdmissionEnvelopeDigestV1,
  verifyHostedClaimExpectedAuthorityV1,
  verifyHostedClaimFencingTokenDigestV1,
  verifyHostedLifecycleReceiptV1,
  type HostedClaimRequestV1,
  type HostedClaimV1,
  type HostedCompleteRequestV1,
  type HostedHeartbeatRequestV1,
  type HostedLifecycleActionV1,
  type HostedLifecycleReceiptEnvelopeV1,
  type HostedLifecycleRequestV1,
  type HostedProgressRequestV1,
  type HostedRejectStartRequestV1,
  type HostedRunningRequestV1,
  type HostedSourceContentRedeemRequestV1,
  type HostedSourceContentRedeemResponseV1,
  type RunnerBranchOwnershipAttestationV1,
  type MaterialActionReceiptEnvelopeV1,
  type PermissionResolutionReceiptEnvelopeV1,
  type RunnerControlContextResponseV1,
  type GitHubProjectTargetDeclarationV1,
  type RunnerProjectTargetUpsertRequestV1,
  type RunnerProjectTargetUpsertResponseV1,
  type RunnerCredentialReprovisionRequestV1,
  type RunnerCredentialResponseV1,
  type RunnerMaterialActionReconcileRequestV1,
  type RunnerMaterialActionBeginV1,
  type PublicationOperationCapabilityV1,
  type PublicationOperationReceiptV1,
  type RunnerPublicationBeginV1,
  type RunnerPublicationClaimNextV1,
  type RunnerPublicationCompletionV1,
  type RunnerPublicationCompletionPendingV1,
  type RunnerPublicationReconciliationPendingV1,
  type RunnerPublicationReconcileV1,
  type RunnerPermissionCurrentQueryV1,
  type RunnerPermissionRequestV1,
  type RunnerProposalSettlementResponseV1,
  type RunnerProposalSettlementV1,
  type RunnerReadinessReceiptEnvelopeV1,
  type RunnerRegistrationRequestV1,
} from "@opentag/control-protocol";

export type {
  HostedClaimRequestV1,
  HostedClaimV1,
  MaterialActionReceiptEnvelopeV1,
  PermissionResolutionReceiptEnvelopeV1,
  RunnerMaterialActionBeginV1,
  RunnerMaterialActionReconcileRequestV1,
  RunnerPermissionCurrentQueryV1,
  RunnerPermissionRequestV1,
  GitHubProjectTargetDeclarationV1,
  RunnerProjectTargetUpsertRequestV1,
  RunnerProjectTargetUpsertResponseV1,
} from "@opentag/control-protocol";

export type ControlCredential =
  | { kind: "bootstrap_pairing"; token: string }
  | { kind: "recovery_pairing"; token: string }
  | { kind: "runtime"; token: string };

export type RelayCapabilitiesResponseV1 = typeof RelayCapabilitiesResponseV1Schema._output;
export type ControlReceiptResult<T> =
  | { status: 201; replayed: false; outcome: "accepted"; receipt: T }
  | { status: 200; replayed: true; outcome: "accepted"; receipt: T };

export type MaterialActionReconcileControlV1Result =
  | {
      status: 200;
      outcome: "resolved";
      receipt: MaterialActionReceiptEnvelopeV1;
    }
  | {
      status: 202;
      outcome: "outcome_unknown";
      receipt: MaterialActionReceiptEnvelopeV1;
    };

export type RunnerPermissionRequestControlV1Result = {
  status: 202;
  outcome: "waiting";
  receipt: PermissionResolutionReceiptEnvelopeV1;
};

export type HumanPermissionDecisionControlV1Result = {
  status: 200;
  outcome: "resolved";
  receipt: PermissionResolutionReceiptEnvelopeV1;
};

export type PermissionResolutionCurrentControlV1Result =
  | RunnerPermissionRequestControlV1Result
  | HumanPermissionDecisionControlV1Result;

export type OpenTagClientOptions = {
  controlPlaneUrl: string;
  controlCredential?: ControlCredential;
  controlSignal?: AbortSignal;
  controlTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type OpenTagClient = {
  getRelayCapabilitiesControlV1(): Promise<RelayCapabilitiesResponseV1>;
  getRunnerControlContextV1(input: { runnerId: string }): Promise<RunnerControlContextResponseV1>;
  upsertRunnerProjectTargetControlV1(input: {
    runnerId: string;
    projectTargetId: string;
    request: RunnerProjectTargetUpsertRequestV1;
  }): Promise<RunnerProjectTargetUpsertResponseV1>;
  claimHostedRunControlV1(input: {
    runnerId: string;
    request: HostedClaimRequestV1;
  }): Promise<HostedClaimV1 | null>;
  redeemHostedSourceContentControlV1(input: {
    runnerId: string;
    request: HostedSourceContentRedeemRequestV1;
  }): Promise<HostedSourceContentRedeemResponseV1>;
  heartbeatHostedRunControlV1(input: {
    organizationId: string;
    credentialId: string;
    runnerId: string;
    runId: string;
    request: HostedHeartbeatRequestV1;
  }): Promise<ControlReceiptResult<HostedLifecycleReceiptEnvelopeV1>>;
  markHostedRunRunningControlV1(input: {
    organizationId: string;
    credentialId: string;
    runnerId: string;
    runId: string;
    request: HostedRunningRequestV1;
  }): Promise<ControlReceiptResult<HostedLifecycleReceiptEnvelopeV1>>;
  progressHostedRunControlV1(input: {
    organizationId: string;
    credentialId: string;
    runnerId: string;
    runId: string;
    request: HostedProgressRequestV1;
  }): Promise<ControlReceiptResult<HostedLifecycleReceiptEnvelopeV1>>;
  completeHostedRunControlV1(input: {
    organizationId: string;
    credentialId: string;
    runnerId: string;
    runId: string;
    request: HostedCompleteRequestV1;
  }): Promise<ControlReceiptResult<HostedLifecycleReceiptEnvelopeV1>>;
  settleProposalCandidateControlV1(input: RunnerProposalSettlementV1):
    Promise<RunnerProposalSettlementResponseV1>;
  rejectHostedAttemptStartControlV1(input: {
    organizationId: string;
    credentialId: string;
    runnerId: string;
    runId: string;
    request: HostedRejectStartRequestV1;
  }): Promise<ControlReceiptResult<HostedLifecycleReceiptEnvelopeV1>>;
  registerRunnerControlV1(input: RunnerRegistrationRequestV1): Promise<RunnerCredentialResponseV1>;
  reprovisionRunnerControlV1(input: RunnerCredentialReprovisionRequestV1): Promise<RunnerCredentialResponseV1>;
  reportRunnerReadinessControlV1(input: RunnerReadinessReceiptEnvelopeV1): Promise<ControlReceiptResult<RunnerReadinessReceiptEnvelopeV1>>;
  requestActionPermissionControlV1(input: RunnerPermissionRequestV1): Promise<RunnerPermissionRequestControlV1Result>;
  getActionPermissionCurrentControlV1(input: RunnerPermissionCurrentQueryV1): Promise<PermissionResolutionCurrentControlV1Result>;
  recordMaterialActionReceiptControlV1(input: { runnerId: string; fencingToken: string; receipt: MaterialActionReceiptEnvelopeV1 }): Promise<ControlReceiptResult<MaterialActionReceiptEnvelopeV1>>;
  reconcileMaterialActionControlV1(input: RunnerMaterialActionReconcileRequestV1): Promise<MaterialActionReconcileControlV1Result>;
  beginMaterialActionControlV1(input: RunnerMaterialActionBeginV1): Promise<{
    status: 200 | 201; replayed: boolean; outcome: "accepted" }>;
  claimNextPublicationOperationControlV1(input: RunnerPublicationClaimNextV1): Promise<{
    capability: PublicationOperationCapabilityV1; completionPending: false; completionReceipt?: never
  } | ({ completionPending: true } & RunnerPublicationCompletionPendingV1)
    | ({ reconciliationPending: true } & RunnerPublicationReconciliationPendingV1) | null>;
  beginPublicationOperationControlV1(input: RunnerPublicationBeginV1): Promise<{
    status: 200 | 201; replayed: boolean; outcome: "accepted" }>;
  recordPublicationOperationReceiptControlV1(input: {
    runnerId: string; fencingToken: string; receipt: PublicationOperationReceiptV1;
  }): Promise<{ status: 200 | 201; replayed: boolean; receipt: PublicationOperationReceiptV1 }>;
  reconcilePublicationOperationControlV1(input: RunnerPublicationReconcileV1): Promise<{
    status: 200 | 202; outcome: "settled" | "retry_authorized" | "outcome_unknown" }>;
  completePublicationControlV1(input: RunnerPublicationCompletionV1): Promise<{
    status: 200 | 202; outcome: "ready" | "replayed" | "nonterminal" | "outcome_unknown" }>;
  attestPublicationBranchOwnershipControlV1(input: RunnerBranchOwnershipAttestationV1): Promise<{
    ownershipId: string; ownershipDigest: string; replayed: boolean;
  }>;
};
export class OpenTagClientHttpError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(action: string, status: number, responseBody: string) {
    super(`${action} failed: ${status}${responseBody ? ` ${responseBody}` : ""}`);
    this.name = "OpenTagClientHttpError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

type RunnerCredentialControlV1HttpResponse = ReturnType<
  typeof RunnerCredentialHttpResponseV1Schema.parse
>;
type RunnerCredentialControlV1ErrorResponse = Exclude<
  RunnerCredentialControlV1HttpResponse,
  { status: 200 | 201 }
>;

export class OpenTagControlV1HttpError extends Error {
  readonly status: RunnerCredentialControlV1ErrorResponse["status"];
  readonly code: RunnerCredentialControlV1ErrorResponse["body"]["error"];
  readonly requestId: string;
  readonly retryAfterSeconds?: number;

  constructor(
    action: string,
    status: RunnerCredentialControlV1ErrorResponse["status"],
    code: RunnerCredentialControlV1ErrorResponse["body"]["error"],
    requestId: string,
    retryAfterSeconds?: number
  ) {
    super(`${action} failed: ${status} ${code} requestId=${requestId}`);
    this.name = "OpenTagControlV1HttpError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

function baseUrlFrom(controlPlaneUrl: string): string {
  if (typeof controlPlaneUrl !== "string" || controlPlaneUrl.trim().length === 0) {
    throw new Error("OpenTag Control Plane URL is invalid.");
  }
  return controlPlaneUrl.replace(/\/$/, "");
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function jsonHeaders(token: string): Record<string, string> {
  return { "content-type": "application/json", ...authHeaders(token) };
}

function requireControlCredential(
  credential: ControlCredential | undefined,
  requiredKind: ControlCredential["kind"]
): string {
  const actualKind = credential?.kind ?? "missing";
  if (
    !credential
    || credential.kind !== requiredKind
    || typeof credential.token !== "string"
    || credential.token.trim().length === 0
  ) {
    throw new Error(
      `Control credential rejected: required=${requiredKind} actual=${actualKind}`
    );
  }
  return credential.token;
}

type StrictControlSchema<T> = {
  parse(value: unknown): T;
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false };
};

function assertControlResponseBoundary(
  response: Response,
  action: string,
  trustedOrigin: string
): void {
  if (
    response.redirected
    || response.type === "opaqueredirect"
    || (response.status >= 300 && response.status < 400)
  ) {
    throw new OpenTagClientHttpError(action, response.status, "redirect_rejected");
  }
  if (!response.url) {
    throw new OpenTagClientHttpError(action, response.status, "response_origin_unverifiable");
  }
  let responseOrigin: string;
  try {
    responseOrigin = new URL(response.url).origin;
  } catch {
    throw new OpenTagClientHttpError(action, response.status, "response_origin_mismatch");
  }
  if (responseOrigin !== trustedOrigin) {
    throw new OpenTagClientHttpError(action, response.status, "response_origin_mismatch");
  }
}

async function parseControlJson(
  response: Response,
  action: string,
  trustedOrigin: string
): Promise<unknown> {
  assertControlResponseBoundary(response, action, trustedOrigin);
  try {
    return await response.json();
  } catch {
    throw new OpenTagClientHttpError(action, response.status, "invalid_json_response");
  }
}

function throwControlV1Error(
  response: Response,
  body: unknown,
  action: string,
  expectedRequestId?: string,
  preserveServerRequestId = false
): never {
  const error = ControlErrorHttpResponseV1Schema.safeParse({
    status: response.status,
    body
  });
  if (!error.success) {
    throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
  }
  if (expectedRequestId !== undefined && error.data.body.requestId !== expectedRequestId) {
    throw new OpenTagClientHttpError(action, response.status, "response_identity_mismatch");
  }
  if (error.data.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== String(error.data.body.retryAfterSeconds)) {
      throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
    }
  }
  throw new OpenTagControlV1HttpError(
    action,
    error.data.status,
    error.data.body.error,
    expectedRequestId
      ?? (preserveServerRequestId ? error.data.body.requestId : "unavailable"),
    error.data.status === 429 ? error.data.body.retryAfterSeconds : undefined
  );
}

async function parseHostedLifecycleControlV1Response(input: {
  response: Response,
  action: string,
  trustedOrigin: string,
  lifecycleAction: HostedLifecycleActionV1,
  organizationId: string,
  credentialId: string,
  runnerId: string,
  runId: string,
  request: HostedLifecycleRequestV1,
}): Promise<ControlReceiptResult<HostedLifecycleReceiptEnvelopeV1>> {
  const body = await parseControlJson(
    input.response,
    input.action,
    input.trustedOrigin,
  );
  if (input.response.status !== 200 && input.response.status !== 201) {
    throwControlV1Error(
      input.response,
      body,
      input.action,
      input.request.requestId,
    );
  }
  const parsed = HostedLifecycleReceiptEnvelopeV1Schema.safeParse(body);
  if (
    !parsed.success
    || !(await verifyHostedLifecycleReceiptV1({
      receipt: parsed.data,
      request: input.request,
      action: input.lifecycleAction,
      organizationId: input.organizationId,
      runnerId: input.runnerId,
      runId: input.runId,
      credentialId: input.credentialId,
    }))
  ) {
    throw new OpenTagClientHttpError(
      input.action,
      input.response.status,
      "invalid_control_v1_response",
    );
  }
  return input.response.status === 201
    ? { status: 201, replayed: false, outcome: "accepted", receipt: parsed.data }
    : { status: 200, replayed: true, outcome: "accepted", receipt: parsed.data };
}

async function validateHostedLifecycleRequest(input: {
  organizationId: string;
  runnerId: string;
  runId: string;
  action: HostedLifecycleActionV1;
  request: HostedLifecycleRequestV1;
}): Promise<void> {
  const expectedDigest = await computeHostedLifecycleRequestDigestV1(input);
  const expectedRequestId = await computeHostedLifecycleRequestIdV1({
    operationId: input.request.operationId,
    requestDigest: expectedDigest,
  });
  const expectedFenceDigest = await computeHostedClaimFencingTokenDigestV1(
    input.request.attempt.fencingToken,
  );
  if (
    input.request.requestDigest !== expectedDigest
    || input.request.requestId !== expectedRequestId
    || input.request.attempt.fencingTokenDigest !== expectedFenceDigest
  ) {
    throw new Error("Hosted lifecycle request identity is invalid.");
  }
}

async function parseControlReceiptResponse<T extends {
  receiptId: string;
  organizationId: string;
  operationId: string;
  receiptDigest: string;
}>(
  response: Response,
  action: string,
  trustedOrigin: string,
  request: T,
  schema: StrictControlSchema<T>,
  isUnknownResponse?: (receipt: T) => boolean
): Promise<ControlReceiptResult<T> | {
  status: 202;
  replayed: false;
  outcome: "outcome_unknown";
  receipt: T;
}> {
  const body = await parseControlJson(response, action, trustedOrigin);
  if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
    throwControlV1Error(response, body, action);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
  }
  if (canonicalJsonStringify(parsed.data) !== canonicalJsonStringify(request)) {
    throw new OpenTagClientHttpError(action, response.status, "response_identity_mismatch");
  }
  if (response.status === 202 && !isUnknownResponse?.(parsed.data)) {
    throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
  }
  if (response.status === 200) {
    return { status: 200, replayed: true, outcome: "accepted", receipt: parsed.data };
  }
  if (response.status === 201) {
    return { status: 201, replayed: false, outcome: "accepted", receipt: parsed.data };
  }
  return {
    status: 202,
    replayed: false,
    outcome: "outcome_unknown",
    receipt: parsed.data
  };
}

async function assertMaterialActionReceiptControlV1(
  receipt: MaterialActionReceiptEnvelopeV1,
  expected: {
    organizationId: string;
    runnerId: string;
    runId: string;
    actionId: string;
    attemptId: string;
    attemptNumber: number;
    epoch: number;
    fencingTokenDigest: string;
    expectedCurrentReceiptId?: string;
    expectedCurrentReceiptDigest?: string;
  },
  action: string,
  status: number
): Promise<void> {
  const expectedPayloadDigest = await computeMaterialActionPayloadDigestV1(
    receipt.payload
  );
  const { receiptDigest: _receiptDigest, ...receiptDigestInput } = receipt;
  const expectedReceiptDigest = await computeMaterialActionReceiptDigestV1(
    receiptDigestInput
  );
  if (
    receipt.payloadDigest !== expectedPayloadDigest
    || receipt.receiptDigest !== expectedReceiptDigest
  ) {
    throw new OpenTagClientHttpError(
      action,
      status,
      "invalid_material_receipt_digest"
    );
  }
  if (
    receipt.organizationId !== expected.organizationId
    || receipt.producer.id !== expected.runnerId
    || receipt.runId !== expected.runId
    || receipt.payload.actionId !== expected.actionId
    || receipt.attempt.attemptId !== expected.attemptId
    || receipt.attempt.attemptNumber !== expected.attemptNumber
    || receipt.attempt.epoch !== expected.epoch
    || receipt.attempt.fencingTokenDigest !== expected.fencingTokenDigest
    || (
      expected.expectedCurrentReceiptId !== undefined
      && receipt.receiptId !== expected.expectedCurrentReceiptId
    )
    || (
      expected.expectedCurrentReceiptDigest !== undefined
      && receipt.receiptDigest !== expected.expectedCurrentReceiptDigest
    )
  ) {
    throw new OpenTagClientHttpError(
      action,
      status,
      "response_identity_mismatch"
    );
  }
}

async function parseMaterialActionReconcileControlV1Response(
  response: Response,
  action: string,
  trustedOrigin: string,
  request: RunnerMaterialActionReconcileRequestV1
): Promise<MaterialActionReconcileControlV1Result> {
  const body = await parseControlJson(response, action, trustedOrigin);
  const parsed = MaterialActionReconcileHttpResponseV1Schema.safeParse({
    status: response.status,
    body,
  });
  if (!parsed.success) {
    throw new OpenTagClientHttpError(
      action,
      response.status,
      "invalid_control_v1_response"
    );
  }
  if (parsed.data.status !== 200 && parsed.data.status !== 202) {
    throwControlV1Error(response, body, action, request.requestId);
  }
  const receipt = parsed.data.body;
  await assertMaterialActionReceiptControlV1(
    receipt,
    {
      organizationId: request.organizationId,
      runnerId: request.runnerId,
      runId: request.runId,
      actionId: request.actionId,
      attemptId: request.attempt.attemptId,
      attemptNumber: request.attempt.attemptNumber,
      epoch: request.attempt.epoch,
      fencingTokenDigest: request.attempt.fencingTokenDigest,
      ...(request.expectedCurrentReceiptId === undefined ? {} : {
        expectedCurrentReceiptId: request.expectedCurrentReceiptId,
        expectedCurrentReceiptDigest: request.expectedCurrentReceiptDigest!,
      }),
    },
    action,
    response.status
  );
  return parsed.data.status === 200
    ? { status: 200, outcome: "resolved", receipt }
    : { status: 202, outcome: "outcome_unknown", receipt };
}

type PermissionResolutionExpectedIdentity = {
  operationId?: string;
  organizationId: string;
  runId: string;
  attemptId: string;
  attemptNumber?: number;
  epoch?: number;
  fencingTokenDigest?: string;
  actionId: string;
  permissionRequestId: string;
  permissionRequestDigest: string;
  policySnapshotDigest?: string;
  decisionId?: string;
  decision?: "allow_once" | "deny";
  decidedAt?: string;
};

async function canonicalSha256Digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJsonStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function assertPermissionResolutionDigests(
  receipt: PermissionResolutionReceiptEnvelopeV1,
  action: string,
  status: number
): Promise<void> {
  const expectedPayloadDigest = await canonicalSha256Digest(receipt.payload);
  const { receiptDigest: _receiptDigest, ...receiptDigestInput } = receipt;
  const expectedReceiptDigest = await canonicalSha256Digest(receiptDigestInput);
  if (
    receipt.payloadDigest !== expectedPayloadDigest
    || receipt.receiptDigest !== expectedReceiptDigest
  ) {
    throw new OpenTagClientHttpError(action, status, "invalid_control_v1_response");
  }
}

function assertPermissionResolutionIdentity(
  receipt: PermissionResolutionReceiptEnvelopeV1,
  expected: PermissionResolutionExpectedIdentity,
  action: string,
  status: number
): void {
  if (
    (expected.operationId !== undefined && receipt.operationId !== expected.operationId)
    || receipt.organizationId !== expected.organizationId
    || receipt.runId !== expected.runId
    || receipt.attempt.attemptId !== expected.attemptId
    || (expected.attemptNumber !== undefined
      && receipt.attempt.attemptNumber !== expected.attemptNumber)
    || (expected.epoch !== undefined && receipt.attempt.epoch !== expected.epoch)
    || (expected.fencingTokenDigest !== undefined
      && receipt.attempt.fencingTokenDigest !== expected.fencingTokenDigest)
    || receipt.payload.actionId !== expected.actionId
    || receipt.payload.permissionRequestId !== expected.permissionRequestId
    || receipt.payload.permissionRequestDigest !== expected.permissionRequestDigest
    || (expected.policySnapshotDigest !== undefined
      && receipt.payload.policySnapshotDigest !== expected.policySnapshotDigest)
    || (expected.decisionId !== undefined && receipt.payload.decisionRef !== expected.decisionId)
    || (expected.decision !== undefined && receipt.payload.decision !== expected.decision)
    || (expected.decidedAt !== undefined && receipt.payload.decidedAt !== expected.decidedAt)
  ) {
    throw new OpenTagClientHttpError(action, status, "response_identity_mismatch");
  }
}

async function parseRunnerPermissionRequestControlV1Response(
  response: Response,
  action: string,
  trustedOrigin: string,
  request: RunnerPermissionRequestV1
): Promise<RunnerPermissionRequestControlV1Result> {
  const body = await parseControlJson(response, action, trustedOrigin);
  if (response.status !== 202) {
    throwControlV1Error(response, body, action, request.requestId);
  }
  const parsed = RunnerPermissionRequestHttpResponseV1Schema.safeParse({ status: response.status, body });
  if (!parsed.success) {
    throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
  }
  const receipt = parsed.data.body;
  await assertPermissionResolutionDigests(receipt, action, response.status);
  assertPermissionResolutionIdentity(receipt, {
    operationId: request.operationId,
    organizationId: request.organizationId,
    runId: request.runId,
    attemptId: request.attempt.attemptId,
    attemptNumber: request.attempt.attemptNumber,
    epoch: request.attempt.epoch,
    fencingTokenDigest: request.attempt.fencingTokenDigest,
    actionId: request.actionId,
    permissionRequestId: request.permissionRequestId,
    permissionRequestDigest: request.permissionRequestDigest,
    policySnapshotDigest: request.policySnapshotDigest,
  }, action, response.status);
  if (
    receipt.payload.actionDescriptor !== request.actionDescriptor
    || receipt.payload.actionDescriptorDigest !== request.actionDescriptorDigest
    || receipt.payload.riskTier !== request.riskTier
    || receipt.payload.targetFingerprint !== request.targetFingerprint
    || receipt.payload.policySnapshotRef !== request.policySnapshotRef
    || receipt.payload.requestedAt !== request.requestedAt
  ) {
    throw new OpenTagClientHttpError(action, response.status, "response_identity_mismatch");
  }
  return { status: 202, outcome: "waiting", receipt };
}

async function parsePermissionResolutionCurrentControlV1Response(
  response: Response,
  action: string,
  trustedOrigin: string,
  query: RunnerPermissionCurrentQueryV1
): Promise<PermissionResolutionCurrentControlV1Result> {
  const body = await parseControlJson(response, action, trustedOrigin);
  if (response.status !== 200 && response.status !== 202) {
    throwControlV1Error(response, body, action);
  }
  const parsed = PermissionResolutionCurrentHttpResponseV1Schema.safeParse({
    status: response.status,
    body,
  });
  if (!parsed.success) {
    throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
  }
  const receipt = parsed.data.body;
  await assertPermissionResolutionDigests(receipt, action, response.status);
  assertPermissionResolutionIdentity(receipt, {
    ...query,
    attemptId: query.attempt.attemptId,
    attemptNumber: query.attempt.attemptNumber,
    epoch: query.attempt.epoch,
    fencingTokenDigest: query.attempt.fencingTokenDigest,
  }, action, response.status);
  return response.status === 202
    ? { status: 202, outcome: "waiting", receipt }
    : { status: 200, outcome: "resolved", receipt };
}

async function parseRunnerCredentialControlV1Response(
  response: Response,
  action: string,
  trustedOrigin: string,
  expected: {
    requestId: string;
    operationId: string;
    runnerId: string;
    registrationGeneration: number;
    credentialGeneration: number;
  }
): Promise<RunnerCredentialResponseV1> {
  const body = await parseControlJson(response, action, trustedOrigin);

  const envelope = RunnerCredentialHttpResponseV1Schema.safeParse({
    status: response.status,
    body
  });
  if (!envelope.success) {
    throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
  }

  if (envelope.data.status !== 200 && envelope.data.status !== 201) {
    throwControlV1Error(response, body, action, expected.requestId);
  }

  if (
    envelope.data.body.operationId !== expected.operationId
    || envelope.data.body.runnerId !== expected.runnerId
  ) {
    throw new OpenTagClientHttpError(action, response.status, "response_identity_mismatch");
  }
  if (
    envelope.data.body.registrationGeneration !== expected.registrationGeneration
    || envelope.data.body.credentialGeneration !== expected.credentialGeneration
  ) {
    throw new OpenTagClientHttpError(action, response.status, "response_generation_mismatch");
  }
  return envelope.data.body;
}

async function parseRunnerControlContextControlV1Response(
  response: Response,
  action: string,
  trustedOrigin: string,
  expected: { runnerId: string; requestId?: string },
): Promise<RunnerControlContextResponseV1> {
  const body = await parseControlJson(response, action, trustedOrigin);
  if (response.status !== 200) {
    const parsedError = ControlErrorHttpResponseV1Schema.safeParse({
      status: response.status,
      body,
    });
    if (!parsedError.success) {
      throw new OpenTagClientHttpError(
        action,
        response.status,
        "invalid_control_v1_response",
      );
    }
    throwControlV1Error(
      response,
      body,
      action,
      expected.requestId,
      expected.requestId === undefined,
    );
  }
  const parsed = RunnerProjectTargetUpsertResponseV1Schema.safeParse(body);
  if (!parsed.success || parsed.data.runnerId !== expected.runnerId) {
    throw new OpenTagClientHttpError(
      action,
      response.status,
      "invalid_control_v1_response",
    );
  }
  return parsed.data;
}

export function createOpenTagClient(options: OpenTagClientOptions): OpenTagClient {
  const baseUrl = baseUrlFrom(options.controlPlaneUrl);
  let trustedControlOrigin: string;
  try {
    trustedControlOrigin = new URL(baseUrl).origin;
  } catch {
    throw new Error("OpenTag Control Plane URL is invalid.");
  }
  const baseFetch = options.fetchImpl ?? fetch;
  const controlFetch = async (
    url: string,
    init: RequestInit,
    action: string
  ): Promise<Response> => {
    const requestAbort = new AbortController();
    const onExternalAbort = () => requestAbort.abort(options.controlSignal?.reason);
    if (options.controlSignal?.aborted) onExternalAbort();
    else options.controlSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const timeout = setTimeout(
      () => requestAbort.abort(new Error("control_request_timeout")),
      options.controlTimeoutMs ?? 30_000,
    );
    try {
      return await baseFetch(url, {
        ...init,
        redirect: "manual",
        signal: requestAbort.signal,
      });
    } catch (error) {
      if (!(error instanceof TypeError) && !requestAbort.signal.aborted) {
        throw error;
      }
      throw new OpenTagClientHttpError(action, 0, "transport_failed");
    } finally {
      clearTimeout(timeout);
      options.controlSignal?.removeEventListener("abort", onExternalAbort);
    }
  };

  return {
    async getRelayCapabilitiesControlV1() {
      const action = "getRelayCapabilitiesControlV1";
      const response = await controlFetch(
        `${baseUrl}/v1/relay/capabilities`,
        { method: "GET" },
        action
      );
      const body = await parseControlJson(response, action, trustedControlOrigin);
      if (response.status !== 200) {
        const parsedError = ControlErrorHttpResponseV1Schema.safeParse({ status: response.status, body });
        if (!parsedError.success) {
          throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
        }
        throwControlV1Error(response, body, action, undefined, true);
      }
      const parsed = RelayCapabilitiesResponseV1Schema.safeParse(body);
      if (!parsed.success) {
        throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
      }
      return parsed.data;
    },

    async getRunnerControlContextV1(input) {
      const runnerId = RunnerControlContextResponseV1Schema.shape.runnerId.parse(input.runnerId);
      const action = "getRunnerControlContextV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(runnerId)}/control-context`,
        { method: "GET", headers: authHeaders(token) },
        action,
      );
      return parseRunnerControlContextControlV1Response(
        response,
        action,
        trustedControlOrigin,
        { runnerId },
      );
    },

    async upsertRunnerProjectTargetControlV1(input) {
      const runnerId = RunnerControlContextResponseV1Schema.shape.runnerId.parse(
        input.runnerId,
      );
      const projectTargetId = GitHubProjectTargetDeclarationV1Schema.shape
        .projectTargetId.parse(input.projectTargetId);
      const request = RunnerProjectTargetUpsertRequestV1Schema.parse(
        input.request,
      );
      if (request.target.projectTargetId !== projectTargetId) {
        throw new Error(
          "Project Target route identity does not match the request target.",
        );
      }
      const action = "upsertRunnerProjectTargetControlV1";
      const token = requireControlCredential(
        options.controlCredential,
        "runtime",
      );
      const expectedBindingDigest =
        await computeGitHubProjectTargetBindingDigestV1(request.target);
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(runnerId)}/project-targets/${encodeURIComponent(projectTargetId)}`,
        {
          method: "PUT",
          headers: jsonHeaders(token),
          body: JSON.stringify(request),
        },
        action,
      );
      const context = await parseRunnerControlContextControlV1Response(
        response,
        action,
        trustedControlOrigin,
        { runnerId, requestId: request.requestId },
      );
      if (
        context.credentialId !== request.expectedAuthority.credentialId
      ) {
        throw new OpenTagClientHttpError(
          action,
          response.status,
          "response_identity_mismatch",
        );
      }
      if (
        context.registrationGeneration
          !== request.expectedAuthority.registrationGeneration
        || context.credentialGeneration
          !== request.expectedAuthority.credentialGeneration
      ) {
        throw new OpenTagClientHttpError(
          action,
          response.status,
          "response_generation_mismatch",
        );
      }
      const target = context.targets.find(
        (candidate) => candidate.projectTargetId === projectTargetId,
      );
      if (
        !target
        || target.bindingDigest !== expectedBindingDigest
        || target.provider !== request.target.provider
        || target.owner !== request.target.owner
        || target.repo !== request.target.repo
        || target.defaultExecutor !== request.target.defaultExecutor
        || target.defaultBranch !== request.target.defaultBranch
      ) {
        throw new OpenTagClientHttpError(
          action,
          response.status,
          "response_identity_mismatch",
        );
      }
      return context;
    },

    async claimHostedRunControlV1(input) {
      const runnerId = HostedClaimV1Schema.shape.runnerId.parse(input.runnerId);
      const request = HostedClaimRequestV1Schema.parse(input.request);
      const action = "claimHostedRunControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(runnerId)}/hosted-claims`,
        {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify(request),
        },
        action,
      );
      assertControlResponseBoundary(response, action, trustedControlOrigin);
      if (response.status === 204) return null;

      const body = await parseControlJson(response, action, trustedControlOrigin);
      if (response.status !== 200) {
        const parsedError = ControlErrorHttpResponseV1Schema.safeParse({
          status: response.status,
          body,
        });
        if (!parsedError.success) {
          throw new OpenTagClientHttpError(
            action,
            response.status,
            "invalid_control_v1_response",
          );
        }
        throwControlV1Error(response, body, action, request.requestId);
      }

      const parsed = HostedClaimV1Schema.safeParse(body);
      if (!parsed.success) {
        throw new OpenTagClientHttpError(
          action,
          response.status,
          "invalid_control_v1_response",
        );
      }
      const claim = parsed.data;
      if (new Date(claim.hostedAdmission.queueClaimDeadline).getTime()
          <= new Date(claim.hostedAdmission.receivedAt).getTime()
        || (claim.hostedAdmission.publicationPolicy.mode === "proposal_only"
          ? claim.hostedAdmission.completionContract.mode !== "proposal_ready"
          : claim.hostedAdmission.completionContract.mode !== "pull_request_ready")) {
        throw new OpenTagClientHttpError(
          action,
          response.status,
          "invalid_frozen_hosted_admission",
        );
      }
      if (
        claim.runnerId !== runnerId
        || !verifyHostedClaimExpectedAuthorityV1(request, claim)
      ) {
        throw new OpenTagClientHttpError(
          action,
          response.status,
          "response_identity_mismatch",
        );
      }
      if (!(await verifyHostedClaimFencingTokenDigestV1(claim))) {
        throw new OpenTagClientHttpError(
          action,
          response.status,
          "invalid_control_v1_response",
        );
      }
      const policy = claim.admissionPolicySnapshot;
      const expectedPolicyPayloadDigest = await computeControlPayloadDigestV1(
        policy.payload,
      );
      const { receiptDigest: _receiptDigest, ...policyReceiptDigestInput } =
        policy;
      const expectedPolicyReceiptDigest = await computeControlReceiptDigestV1(
        policyReceiptDigestInput,
      );
      if (
        !(await verifyHostedAdmissionEnvelopeDigestV1(claim.hostedAdmission))
        || policy.payloadDigest !== expectedPolicyPayloadDigest
        || policy.receiptDigest !== expectedPolicyReceiptDigest
      ) {
        throw new OpenTagClientHttpError(
          action,
          response.status,
          "invalid_control_v1_response",
        );
      }
      return claim;
    },

    async redeemHostedSourceContentControlV1(input) {
      const request = HostedSourceContentRedeemRequestV1Schema.parse(input.request);
      const runnerId = HostedClaimV1Schema.shape.runnerId.parse(input.runnerId);
      const action = "redeemHostedSourceContentControlV1";
      if (request.runnerId !== runnerId) {
        throw new OpenTagClientHttpError(action, 0, "response_identity_mismatch");
      }
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(runnerId)}/runs/${encodeURIComponent(request.runId)}/source-content/redeem`,
        { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(request) },
        action,
      );
      assertControlResponseBoundary(response, action, trustedControlOrigin);
      const body = await parseControlJson(response, action, trustedControlOrigin);
      if (response.status !== 200) {
        const parsedError = ControlErrorHttpResponseV1Schema.safeParse({
          status: response.status, body,
        });
        if (!parsedError.success) {
          throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
        }
        throwControlV1Error(response, body, action, request.requestId);
      }
      const parsed = HostedSourceContentRedeemResponseV1Schema.safeParse(body);
      if (!parsed.success) {
        throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
      }
      const redeemed = parsed.data;
      if (redeemed.requestId !== request.requestId
        || redeemed.operationId !== request.operationId
        || redeemed.organizationId !== request.organizationId
        || redeemed.runnerId !== runnerId
        || redeemed.runId !== request.runId
        || redeemed.attempt.attemptId !== request.attempt.attemptId
        || redeemed.attempt.attemptNumber !== request.attempt.attemptNumber
        || redeemed.attempt.epoch !== request.attempt.epoch
        || redeemed.attempt.fencingTokenDigest !== request.attempt.fencingTokenDigest
        || redeemed.attempt.leaseExpiresAt !== request.attempt.leaseExpiresAt
        || redeemed.admissionEnvelopeDigest !== request.admissionEnvelopeDigest
        || canonicalJsonStringify(redeemed.contentEnvelope)
          !== canonicalJsonStringify(request.contentEnvelope)) {
        throw new OpenTagClientHttpError(action, response.status, "response_identity_mismatch");
      }
      if (!(await verifyHostedSourceContentRedeemPayloadV1(redeemed))) {
        throw new OpenTagClientHttpError(action, response.status, "response_payload_digest_mismatch");
      }
      return redeemed;
    },

    async heartbeatHostedRunControlV1(input) {
      const action = "heartbeatHostedRunControlV1";
      const request = HostedHeartbeatRequestV1Schema.parse(input.request);
      await validateHostedLifecycleRequest({
        organizationId: input.organizationId,
        runnerId: input.runnerId,
        runId: input.runId,
        action: "heartbeat",
        request,
      });
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(input.runnerId)}/runs/${encodeURIComponent(input.runId)}/heartbeat`,
        {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify(request),
        },
        action,
      );
      return parseHostedLifecycleControlV1Response({
        response,
        action,
        trustedOrigin: trustedControlOrigin,
        lifecycleAction: "heartbeat",
        organizationId: input.organizationId,
        credentialId: input.credentialId,
        runnerId: input.runnerId,
        runId: input.runId,
        request,
      });
    },

    async markHostedRunRunningControlV1(input) {
      const action = "markHostedRunRunningControlV1";
      const request = HostedRunningRequestV1Schema.parse(input.request);
      await validateHostedLifecycleRequest({
        organizationId: input.organizationId,
        runnerId: input.runnerId,
        runId: input.runId,
        action: "running",
        request,
      });
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(input.runnerId)}/runs/${encodeURIComponent(input.runId)}/running`,
        {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify(request),
        },
        action,
      );
      return parseHostedLifecycleControlV1Response({
        response,
        action,
        trustedOrigin: trustedControlOrigin,
        lifecycleAction: "running",
        organizationId: input.organizationId,
        credentialId: input.credentialId,
        runnerId: input.runnerId,
        runId: input.runId,
        request,
      });
    },

    async progressHostedRunControlV1(input) {
      const action = "progressHostedRunControlV1";
      const request = HostedProgressRequestV1Schema.parse(input.request);
      await validateHostedLifecycleRequest({
        organizationId: input.organizationId,
        runnerId: input.runnerId,
        runId: input.runId,
        action: "progress",
        request,
      });
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(input.runnerId)}/runs/${encodeURIComponent(input.runId)}/progress`,
        {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify(request),
        },
        action,
      );
      return parseHostedLifecycleControlV1Response({
        response,
        action,
        trustedOrigin: trustedControlOrigin,
        lifecycleAction: "progress",
        organizationId: input.organizationId,
        credentialId: input.credentialId,
        runnerId: input.runnerId,
        runId: input.runId,
        request,
      });
    },

    async completeHostedRunControlV1(input) {
      const action = "completeHostedRunControlV1";
      const request = HostedCompleteRequestV1Schema.parse(input.request);
      await validateHostedLifecycleRequest({
        organizationId: input.organizationId,
        runnerId: input.runnerId,
        runId: input.runId,
        action: "complete",
        request,
      });
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(input.runnerId)}/runs/${encodeURIComponent(input.runId)}/complete`,
        {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify(request),
        },
        action,
      );
      return parseHostedLifecycleControlV1Response({
        response,
        action,
        trustedOrigin: trustedControlOrigin,
        lifecycleAction: "complete",
        organizationId: input.organizationId,
        credentialId: input.credentialId,
        runnerId: input.runnerId,
        runId: input.runId,
        request,
      });
    },

    async settleProposalCandidateControlV1(input) {
      const action = "settleProposalCandidateControlV1";
      const request = RunnerProposalSettlementV1Schema.parse(input);
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(request.runnerId)}/runs/${encodeURIComponent(request.runId)}/proposal/settle`,
        { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(request) },
        action,
      );
      const body = await parseControlJson(response, action, trustedControlOrigin);
      if (response.status !== 200 && response.status !== 201) {
        throwControlV1Error(response, body, action, request.requestId);
      }
      return RunnerProposalSettlementResponseV1Schema.parse(body);
    },

    async rejectHostedAttemptStartControlV1(input) {
      const action = "rejectHostedAttemptStartControlV1";
      const request = HostedRejectStartRequestV1Schema.parse(input.request);
      await validateHostedLifecycleRequest({
        organizationId: input.organizationId,
        runnerId: input.runnerId,
        runId: input.runId,
        action: "reject-start",
        request,
      });
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(input.runnerId)}/runs/${encodeURIComponent(input.runId)}/reject-start`,
        {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify(request),
        },
        action,
      );
      return parseHostedLifecycleControlV1Response({
        response,
        action,
        trustedOrigin: trustedControlOrigin,
        lifecycleAction: "reject-start",
        organizationId: input.organizationId,
        credentialId: input.credentialId,
        runnerId: input.runnerId,
        runId: input.runId,
        request,
      });
    },

    async registerRunnerControlV1(input) {
      const request = RunnerRegistrationRequestV1Schema.parse(input);
      const controlToken = requireControlCredential(
        options.controlCredential,
        "bootstrap_pairing"
      );
      const action = "registerRunnerControlV1";
      const response = await controlFetch(`${baseUrl}/v1/runners`, {
        method: "POST",
        headers: jsonHeaders(controlToken),
        body: JSON.stringify(request)
      }, action);
      return parseRunnerCredentialControlV1Response(
        response,
        action,
        trustedControlOrigin,
        {
          ...request,
          registrationGeneration: 1,
          credentialGeneration: 1
        }
      );
    },

    async reprovisionRunnerControlV1(input) {
      const request = RunnerCredentialReprovisionRequestV1Schema.parse(input);
      const controlToken = requireControlCredential(
        options.controlCredential,
        "recovery_pairing"
      );
      const action = "reprovisionRunnerControlV1";
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(request.runnerId)}/credentials/reprovision`,
        {
          method: "POST",
          headers: jsonHeaders(controlToken),
          body: JSON.stringify(request)
        },
        action
      );
      return parseRunnerCredentialControlV1Response(
        response,
        action,
        trustedControlOrigin,
        {
          ...request,
          registrationGeneration: request.expectedRegistrationGeneration + 1,
          credentialGeneration: request.expectedCredentialGeneration + 1
        }
      );
    },

    async reportRunnerReadinessControlV1(input) {
      const request = RunnerReadinessReceiptEnvelopeV1Schema.parse(input);
      const action = "reportRunnerReadinessControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(request.payload.runnerId)}/readiness`,
        {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify(request)
        },
        action
      );
      return parseControlReceiptResponse(
        response,
        action,
        trustedControlOrigin,
        request,
        RunnerReadinessReceiptEnvelopeV1Schema,
        undefined
      ) as Promise<ControlReceiptResult<RunnerReadinessReceiptEnvelopeV1>>;
    },

    async requestActionPermissionControlV1(input) {
      const action = "requestActionPermissionControlV1";
      const request = RunnerPermissionRequestV1Schema.parse(input);
      const expectedFencingTokenDigest = await computePermissionFencingTokenDigestV1(
        request.attempt.fencingToken
      );
      if (request.attempt.fencingTokenDigest !== expectedFencingTokenDigest) {
        throw new OpenTagClientHttpError(
          action,
          0,
          "invalid_permission_fencing_token_digest"
        );
      }
      const expectedPermissionRequestDigest = await computePermissionRequestDigestV1({
        schemaVersion: request.schemaVersion,
        protocolVersion: request.protocolVersion,
        requiredCapabilities: request.requiredCapabilities,
        organizationId: request.organizationId,
        runnerId: request.runnerId,
        runId: request.runId,
        attempt: {
          attemptId: request.attempt.attemptId,
          attemptNumber: request.attempt.attemptNumber,
          epoch: request.attempt.epoch,
          fencingTokenDigest: request.attempt.fencingTokenDigest,
        },
        permissionRequestId: request.permissionRequestId,
        actionId: request.actionId,
        actionDescriptor: request.actionDescriptor,
        actionDescriptorDigest: request.actionDescriptorDigest,
        riskTier: request.riskTier,
        targetFingerprint: request.targetFingerprint,
        policySnapshotRef: request.policySnapshotRef,
        policySnapshotDigest: request.policySnapshotDigest,
        ...(request.workspaceAttestationDigest
          ? { workspaceAttestationDigest: request.workspaceAttestationDigest } : {}),
        requestedAt: request.requestedAt,
      });
      if (request.permissionRequestDigest !== expectedPermissionRequestDigest) {
        throw new OpenTagClientHttpError(
          action,
          0,
          "invalid_permission_request_digest"
        );
      }
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(request.runnerId)}/runs/${encodeURIComponent(request.runId)}/action-permissions`,
        {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify(request),
        },
        action
      );
      return parseRunnerPermissionRequestControlV1Response(
        response,
        action,
        trustedControlOrigin,
        request
      );
    },

    async getActionPermissionCurrentControlV1(input) {
      const query = RunnerPermissionCurrentQueryV1Schema.parse(input);
      const action = "getActionPermissionCurrentControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const search = new URLSearchParams({
        organizationId: query.organizationId,
        attemptId: query.attempt.attemptId,
        attemptNumber: String(query.attempt.attemptNumber),
        epoch: String(query.attempt.epoch),
        fencingTokenDigest: query.attempt.fencingTokenDigest,
        permissionRequestId: query.permissionRequestId,
        permissionRequestDigest: query.permissionRequestDigest,
      });
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(query.runnerId)}/runs/${encodeURIComponent(query.runId)}/action-permissions/${encodeURIComponent(query.actionId)}/current?${search.toString()}`,
        { method: "GET", headers: authHeaders(token) },
        action
      );
      return parsePermissionResolutionCurrentControlV1Response(
        response,
        action,
        trustedControlOrigin,
        query
      );
    },

    async beginMaterialActionControlV1(input) {
      const request = RunnerMaterialActionBeginV1Schema.parse(input);
      const action = "beginMaterialActionControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(request.runnerId)}/runs/${encodeURIComponent(request.runId)}/material-actions/begin`,
        { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(request) }, action,
      );
      assertControlResponseBoundary(response, action, trustedControlOrigin);
      const body = await parseControlJson(response, action, trustedControlOrigin) as {
        outcome?: unknown; idempotencyKey?: unknown };
      if ((response.status !== 200 && response.status !== 201)
        || body.idempotencyKey !== request.idempotencyKey
        || body.outcome !== (response.status === 201 ? "begun" : "replayed")) {
        if (response.status !== 200 && response.status !== 201) {
          throwControlV1Error(response, body, action, request.requestId);
        }
        throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
      }
      return { status: response.status, replayed: response.status === 200,
        outcome: "accepted" as const };
    },

    async recordMaterialActionReceiptControlV1(input) {
      const action = "recordMaterialActionReceiptControlV1";
      const runnerId = MaterialActionStableIdV1Schema.parse(input.runnerId);
      const fencingToken =
        RunnerMaterialActionReconcileAttemptV1Schema.shape.fencingToken.parse(
          input.fencingToken
        );
      const receipt = MaterialActionReceiptEnvelopeV1Schema.parse(input.receipt);
      const expectedFenceDigest = await computeMaterialActionFencingTokenDigestV1(
        fencingToken
      );
      const expectedPayloadDigest = await computeMaterialActionPayloadDigestV1(
        receipt.payload
      );
      const { receiptDigest: _receiptDigest, ...receiptDigestInput } = receipt;
      const expectedReceiptDigest = await computeMaterialActionReceiptDigestV1(
        receiptDigestInput
      );
      if (receipt.attempt.fencingTokenDigest !== expectedFenceDigest) {
        throw new OpenTagClientHttpError(
          action,
          0,
          "invalid_material_fencing_token_digest"
        );
      }
      if (receipt.producer.id !== runnerId) {
        throw new OpenTagClientHttpError(
          action,
          0,
          "invalid_material_receipt_identity"
        );
      }
      if (
        receipt.payloadDigest !== expectedPayloadDigest
        || receipt.receiptDigest !== expectedReceiptDigest
      ) {
        throw new OpenTagClientHttpError(
          action,
          0,
          "invalid_material_receipt_digest"
        );
      }
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(runnerId)}/runs/${encodeURIComponent(receipt.runId)}/material-actions/${encodeURIComponent(receipt.payload.actionId)}/receipt`,
        {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify({ fencingToken, receipt })
        },
        action
      );
      return parseControlReceiptResponse(
        response,
        action,
        trustedControlOrigin,
        receipt,
        MaterialActionReceiptEnvelopeV1Schema,
        undefined
      ) as Promise<ControlReceiptResult<MaterialActionReceiptEnvelopeV1>>;
    },

    async claimNextPublicationOperationControlV1(input) {
      const request = RunnerPublicationClaimNextV1Schema.parse(input);
      const action = "claimNextPublicationOperationControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(request.runnerId)}/publication/claim-next`,
        { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(request) }, action,
      );
      assertControlResponseBoundary(response, action, trustedControlOrigin);
      if (response.status === 204) return null;
      const body = await parseControlJson(response, action, trustedControlOrigin);
      if (response.status !== 200 && response.status !== 201) throwControlV1Error(response, body, action, request.requestId);
      if (response.status === 200) {
        if (typeof body === "object" && body !== null && "completionReceipt" in body) {
          return { ...RunnerPublicationCompletionPendingV1Schema.parse(body), completionPending: true as const };
        }
        return { ...RunnerPublicationReconciliationPendingV1Schema.parse(body), reconciliationPending: true as const };
      }
      return { capability: PublicationOperationCapabilityV1Schema.parse(body), completionPending: false as const };
    },

    async beginPublicationOperationControlV1(input) {
      const request = RunnerPublicationBeginV1Schema.parse(input);
      const action = "beginPublicationOperationControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(request.capability.runnerId)}/runs/${encodeURIComponent(request.capability.runId)}/publication/begin`,
        { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(request) }, action,
      );
      assertControlResponseBoundary(response, action, trustedControlOrigin);
      const body = await parseControlJson(response, action, trustedControlOrigin) as { outcome?: unknown };
      if ((response.status !== 200 && response.status !== 201)
        || body.outcome !== (response.status === 201 ? "begun" : "replayed")) {
        if (response.status !== 200 && response.status !== 201) {
          throwControlV1Error(response, body, action, request.requestId);
        }
        throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
      }
      return { status: response.status, replayed: response.status === 200, outcome: "accepted" as const };
    },

    async recordPublicationOperationReceiptControlV1(input) {
      const action = "recordPublicationOperationReceiptControlV1";
      const runnerId = MaterialActionStableIdV1Schema.parse(input.runnerId);
      const body = RunnerPublicationReceiptV1Schema.parse({ fencingToken: input.fencingToken,
        receipt: PublicationOperationReceiptV1Schema.parse(input.receipt) });
      if (body.receipt.runnerId !== runnerId) {
        throw new OpenTagClientHttpError(action, 0, "invalid_publication_receipt_identity");
      }
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(runnerId)}/runs/${encodeURIComponent(body.receipt.runId)}/publication/receipt`,
        { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(body) }, action,
      );
      assertControlResponseBoundary(response, action, trustedControlOrigin);
      const received = await parseControlJson(response, action, trustedControlOrigin);
      if (response.status !== 200 && response.status !== 201) {
        throwControlV1Error(response, received, action, body.receipt.operationId);
      }
      return { status: response.status, replayed: response.status === 200,
        receipt: PublicationOperationReceiptV1Schema.parse(received) };
    },

    async reconcilePublicationOperationControlV1(input) {
      const request = RunnerPublicationReconcileV1Schema.parse(input);
      const action = "reconcilePublicationOperationControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(request.runnerId)}/runs/${encodeURIComponent(request.runId)}/publication/reconcile`,
        { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(request) }, action,
      );
      assertControlResponseBoundary(response, action, trustedControlOrigin);
      const body = await parseControlJson(response, action, trustedControlOrigin) as { kind?: unknown };
      if ((response.status !== 200 && response.status !== 202)
        || (body.kind !== "settled" && body.kind !== "retry_authorized" && body.kind !== "outcome_unknown")) {
        if (response.status !== 200 && response.status !== 202) {
          throwControlV1Error(response, body, action, request.requestId);
        }
        throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
      }
      return { status: response.status, outcome: body.kind };
    },

    async completePublicationControlV1(input) {
      const request = RunnerPublicationCompletionV1Schema.parse(input);
      const action = "completePublicationControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(request.runnerId)}/runs/${encodeURIComponent(request.runId)}/publication/complete`,
        { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(request) }, action,
      );
      assertControlResponseBoundary(response, action, trustedControlOrigin);
      const body = await parseControlJson(response, action, trustedControlOrigin) as { kind?: unknown };
      if ((response.status !== 200 && response.status !== 202)
        || !["ready", "replayed", "nonterminal", "outcome_unknown"].includes(String(body.kind))) {
        if (response.status !== 200 && response.status !== 202) {
          throwControlV1Error(response, body, action, request.requestId);
        }
        throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
      }
      return { status: response.status, outcome: body.kind as "ready" | "replayed" | "nonterminal" | "outcome_unknown" };
    },

    async attestPublicationBranchOwnershipControlV1(input) {
      const request = RunnerBranchOwnershipAttestationV1Schema.parse(input);
      const action = "attestPublicationBranchOwnershipControlV1";
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/runners/${encodeURIComponent(request.runnerId)}/runs/${encodeURIComponent(request.runId)}/publication/ownership`,
        { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(request) }, action,
      );
      assertControlResponseBoundary(response, action, trustedControlOrigin);
      const body = await parseControlJson(response, action, trustedControlOrigin) as {
        kind?: unknown; ownershipId?: unknown; ownershipDigest?: unknown;
      };
      if (response.status !== 200 || (body.kind !== "recorded" && body.kind !== "replayed")
        || typeof body.ownershipId !== "string" || typeof body.ownershipDigest !== "string") {
        if (response.status !== 200) throwControlV1Error(response, body, action, request.requestId);
        throw new OpenTagClientHttpError(action, response.status, "invalid_control_v1_response");
      }
      return { ownershipId: body.ownershipId, ownershipDigest: body.ownershipDigest,
        replayed: body.kind === "replayed" };
    },

    async reconcileMaterialActionControlV1(input) {
      const request = RunnerMaterialActionReconcileRequestV1Schema.parse(input);
      const action = "reconcileMaterialActionControlV1";
      const expectedFenceDigest = await computeMaterialActionFencingTokenDigestV1(
        request.attempt.fencingToken
      );
      if (request.attempt.fencingTokenDigest !== expectedFenceDigest) {
        throw new OpenTagClientHttpError(
          action,
          0,
          "invalid_material_fencing_token_digest"
        );
      }
      const token = requireControlCredential(options.controlCredential, "runtime");
      const response = await controlFetch(
        `${baseUrl}/v1/material-actions/${encodeURIComponent(request.actionId)}/reconcile`,
        {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify(request),
        },
        action
      );
      return parseMaterialActionReconcileControlV1Response(
        response,
        action,
        trustedControlOrigin,
        request
      );
    },

  };
}
