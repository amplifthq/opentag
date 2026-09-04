import { buildHostedLifecycleRequestV1, computeControlPayloadDigestV1, computeControlReceiptDigestV1, computeSlackAppMentionSourceIdentityDigestV1, computeHostedAdmissionEnvelopeDigestV1, computeHostedClaimFencingTokenDigestV1, computeHostedLifecycleReceiptIdV1, computeHostedLifecycleRequestIdV1, type HostedClaimRequestV1, type HostedClaimV1, type HostedHeartbeatRequestV1, type HostedProgressRequestV1, type HostedRejectStartRequestV1, type HostedRunningRequestV1, type HostedLifecycleReceiptEnvelopeV1, type OpenTagEvent } from "@opentag/core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSha256Json } from "../src/canonical-json.js";
import { HostedImportConflictError, createPairedRunnerRepository } from "../src/repository.js";
import { migratePairedRunnerSchema } from "../src/schema.js";
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const capabilities = [
    "relay.claim-fence.v1",
    "relay.hosted-admission.v1",
    "relay.hosted-claim.v1",
    "relay.lifecycle.v1",
    "relay.readiness.v1",
    "relay.source-content-redeem.v1",
] as const;
const observedAt = "2026-08-10T00:00:00.000Z";
const leaseExpiresAt = "2099-08-10T00:02:00.000Z";
const tempDirs: string[] = [];
afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function request(operationId = "claim-op-1", requestId = "claim-request-1"): HostedClaimRequestV1 {
    return {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: capabilities,
        requestId,
        operationId,
        expectedAuthority: {
            credentialId: "credential-1",
            registrationGeneration: 3,
            credentialGeneration: 2,
            runnerReadinessReceiptId: "readiness-1",
            runnerReadinessReceiptDigest: digestA
        }
    };
}
async function fixture(input: {
    runId?: string;
    admissionId?: string;
    admissionOperationId?: string;
    claimOperationId?: string;
    requestId?: string;
    attemptId?: string;
    attemptNumber?: number;
    deliveryId?: string;
    providerEventId?: string;
    body?: string;
    fencingToken?: string;
    leaseExpiresAt?: string;
} = {}): Promise<{
    event: OpenTagEvent;
    claim: HostedClaimV1;
    request: HostedClaimRequestV1;
    sourceReceipt: {
        provider: "slack";
        providerRepositoryId: string;
        owner: string;
        repo: string;
        sourceThread: HostedClaimV1["hostedAdmission"]["sourceThread"];
        sourceEvent: HostedClaimV1["hostedAdmission"]["sourceEvent"];
        actor: {
            providerUserId: string;
            login: string;
        };
        sourceIdentityDigest: string;
        eventDigest: string;
        redeemedAt: string;
    };
}> {
    const runId = input.runId ?? "hosted-run-1";
    const admissionId = input.admissionId ?? "admission-1";
    const admissionOperationId = input.admissionOperationId ?? "admission-op-1";
    const claimOperationId = input.claimOperationId ?? "claim-op-1";
    const requestId = input.requestId ?? "claim-request-1";
    const attemptId = input.attemptId ?? "attempt-cloud-1";
    const attemptNumber = input.attemptNumber ?? 1;
    const deliveryId = input.deliveryId ?? "delivery-1";
    const providerEventId = input.providerEventId ?? "Ev789";
    const body = input.body ?? "<@U_APP> fix the failing test";
    const fencingToken = input.fencingToken ?? "cloud-fence-1";
    const claimLeaseExpiresAt = input.leaseExpiresAt ?? leaseExpiresAt;
    const event: OpenTagEvent = {
        id: `event-${providerEventId}`,
        source: "slack",
        sourceEventId: providerEventId,
        receivedAt: observedAt,
        actor: { provider: "slack", providerUserId: "U1001", handle: "alice", organizationId: "T123" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: body, intent: "fix", args: {} },
        context: [],
        workItem: {
            provider: "slack",
            kind: "thread",
            externalId: "C123:1700000000.000100",
            uri: "slack://team/T123/channel/C123/thread/1700000000.000100",
            ownerContainer: {
                provider: "github",
                id: "acme/widget",
                uri: "https://github.com/acme/widget"
            }
        },
        permissions: [{ scope: "workspace:write", reason: "fix the repository" }],
        callback: { provider: "slack", uri: "https://slack.com/api/chat.postMessage",
            threadKey: "C123:1700000000.000100" },
        metadata: { teamId: "T123", channelId: "C123", repoProvider: "github",
            owner: "acme", repo: "widget", deliveryId, messageTs: "1700000001.000200" }
    };
    const sourceIdentityDigest = await computeSlackAppMentionSourceIdentityDigestV1({
        provider: "slack",
        repository: { provider: "github", providerRepositoryId: "123", owner: "acme", repo: "widget" },
        sourceThread: { kind: "channel_thread", providerThreadId: "C123:1700000000.000100",
            channelId: "C123", threadTs: "1700000000.000100" },
        sourceEvent: { providerEventId, kind: "app_mention", messageId: "1700000001.000200" },
        actor: { providerUserId: "U1001", login: "alice" },
        executionBearingMessageBody: body
    });
    const admissionBase = {
        kind: "hosted_admission" as const,
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        requiredCapabilities: ["relay.hosted-admission.v1"] as const,
        admissionId,
        operationId: admissionOperationId,
        organizationId: "org-1",
        bindingId: "binding-1",
        bindingSecretVersion: "secret-v3",
        provider: "slack" as const,
        deliveryId,
        deliveryPayloadDigest: digestA,
        sourceIdentityDigest,
        eventName: "app_mention" as const,
        action: "created" as const,
        repository: { provider: "github" as const, providerRepositoryId: "123", owner: "acme", repo: "widget" },
        sourceThread: { kind: "channel_thread" as const,
            providerThreadId: "C123:1700000000.000100", channelId: "C123",
            threadTs: "1700000000.000100" },
        sourceEvent: { providerEventId, kind: "app_mention" as const,
            messageId: "1700000001.000200" },
        verifiedActor: {
            providerUserId: "U1001",
            login: "alice",
            authorization: { decision: "allowed" as const, grantRef: "grant-1", grantVersion: 1, grantDigest: digestA }
        },
        projectTarget: { projectTargetId: "target-1", digest: digestA },
        runnerId: "runner-1",
        sourceContextEnvelope: { contentId: "content-1", sourceVersionRef: "source-1",
            aadDigest: "1".repeat(64), keyVersion: "v1", envelopeDigest: digestA,
            payloadDigest: digestA },
        queueClaimDeadline: "2026-08-11T00:00:00.000Z",
        permissionCeiling: { allowedActionDescriptors: ["workspace.write"], digest: digestA },
        publicationPolicy: { mode: "proposal_only" as const, digest: digestA },
        completionContract: { mode: "proposal_ready" as const, digest: digestA },
        admissionPolicySnapshot: { snapshotId: "policy-1", digest: digestB },
        receivedAt: observedAt,
        envelopeDigest: digestA
    };
    const hostedAdmission = {
        ...admissionBase,
        envelopeDigest: await computeHostedAdmissionEnvelopeDigestV1(admissionBase)
    };
    const fencingTokenDigest = await computeHostedClaimFencingTokenDigestV1(fencingToken);
    const claim: HostedClaimV1 = {
        kind: "hosted_claim",
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: capabilities,
        requestId,
        operationId: claimOperationId,
        organizationId: "org-1",
        runnerId: "runner-1",
        runId,
        executorId: "executor-acp",
        hostedAdmission,
        admissionPolicySnapshot: {
            schemaVersion: 1,
            protocolVersion: "1.0",
            receiptId: "policy-receipt-1",
            organizationId: "org-1",
            operationId: admissionOperationId,
            requiredCapabilities: capabilities,
            producer: { kind: "cloud", id: "cloud-control" },
            identity: { namespace: "opentag.control.receipt/admission-policy-snapshot/v1", parts: ["org-1", runId, "policy-1"] },
            observedAt,
            payloadDigest: digestA,
            receiptDigest: digestB,
            receiptKind: "admission_policy_snapshot",
            runId,
            payload: {
                snapshotId: "policy-1",
                capturedAt: observedAt,
                tenant: { organizationId: "org-1" },
                actor: { provider: "slack", providerUserId: "U1001", login: "alice", authorizationRef: "grant-1" },
                target: { projectTargetId: "target-1", bindingId: "binding-1", repositoryProvider: "github", providerRepositoryId: "123", defaultBranch: "main",
                    authorizedPublicationModes: ["proposal_only", "pull_request"] },
                runner: { runnerId: "runner-1", readinessReceiptDigest: digestA },
                executor: { executorId: "executor-acp", capabilityDigest: digestB },
                requiredRelayCapabilities: capabilities,
                admissionRules: { profile: "slack-app-mention/v1", requiredCheckNames: ["test"], mergeRequired: false, humanApprovalRequiredFor: ["merge"] }
            }
        },
        attempt: {
            id: attemptId,
            number: attemptNumber,
            epoch: attemptNumber,
            fencingToken,
            fencingTokenDigest,
            leaseExpiresAt: claimLeaseExpiresAt
        },
        sourceContentGrant: {
            grantId: `grant-${attemptId}`, token: `grant-token-${attemptId}`,
            keyVersion: "test-v1", fenceDigest: fencingTokenDigest,
            contentIds: ["content-1"], purpose: "source_context",
            expiresAt: claimLeaseExpiresAt,
        },
        authority: {
            organizationId: "org-1",
            runnerId: "runner-1",
            runId,
            credentialId: "credential-1",
            registrationGeneration: 3,
            credentialGeneration: 2,
            projectTargetId: "target-1",
            bindingId: "binding-1",
            targetBindingDigest: digestA,
            admissionPolicyReceiptId: "policy-receipt-1",
            admissionPolicySnapshotId: "policy-1",
            admissionPolicySnapshotDigest: digestB,
            runnerReadinessReceiptId: "readiness-1",
            runnerReadinessReceiptDigest: digestA,
            targetReadinessReceiptId: "readiness-1",
            targetReadinessReceiptDigest: digestA,
            executorId: "executor-acp",
            executorCapabilityDigest: digestB,
            attemptId,
            attemptNumber,
            epoch: attemptNumber,
            fencingTokenDigest
        }
    };
    return {
        event,
        claim,
        request: request(claimOperationId, requestId),
        sourceReceipt: {
            provider: "slack",
            providerRepositoryId: "123",
            owner: "acme",
            repo: "widget",
            sourceThread: hostedAdmission.sourceThread,
            sourceEvent: hostedAdmission.sourceEvent,
            actor: { providerUserId: "U1001", login: "alice" },
            sourceIdentityDigest,
            eventDigest: canonicalSha256Json(event),
            redeemedAt: observedAt
        }
    };
}
async function begin(repo: ReturnType<typeof createPairedRunnerRepository>, value: Awaited<ReturnType<typeof fixture>>) {
    return repo.beginHostedClaimOperation({
        destinationId: "cloud-1",
        organizationId: "org-1",
        runnerId: "runner-1",
        request: value.request
    });
}
const heartbeatAuthority = {
    destinationId: "cloud-1",
    organizationId: "org-1",
    runnerId: "runner-1",
    credentialId: "credential-1"
};
async function heartbeatRequest(input: {
    claim: HostedClaimV1;
    expectedLeaseExpiresAt: string;
    occurredAt?: string;
}): Promise<HostedHeartbeatRequestV1> {
    return buildHostedLifecycleRequestV1({
        action: "heartbeat",
        organizationId: "org-1",
        runnerId: "runner-1",
        runId: input.claim.runId,
        attempt: {
            attemptId: input.claim.attempt.id,
            attemptNumber: input.claim.attempt.number,
            epoch: input.claim.attempt.epoch,
            fencingToken: input.claim.attempt.fencingToken,
            fencingTokenDigest: input.claim.attempt.fencingTokenDigest
        },
        occurredAt: input.occurredAt ?? "2026-08-10T00:01:00.000Z",
        expectedLeaseExpiresAt: input.expectedLeaseExpiresAt
    }) as Promise<HostedHeartbeatRequestV1>;
}
async function heartbeatReceipt(input: {
    claim: HostedClaimV1;
    request: HostedHeartbeatRequestV1;
    leaseExpiresAt: string;
}): Promise<HostedLifecycleReceiptEnvelopeV1> {
    const payload = {
        operation: "heartbeat" as const,
        occurredAt: input.request.occurredAt,
        leaseExpiresAt: input.leaseExpiresAt
    };
    const base = {
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        receiptKind: "attempt_lifecycle" as const,
        receiptId: await computeHostedLifecycleReceiptIdV1({
            organizationId: "org-1",
            operationId: input.request.operationId
        }),
        organizationId: "org-1",
        requestId: input.request.requestId,
        operationId: input.request.operationId,
        requestDigest: input.request.requestDigest,
        requiredCapabilities: ["relay.lifecycle.v1"] as const,
        producer: { kind: "runner" as const, id: "runner-1", credentialId: "credential-1" },
        identity: {
            namespace: "opentag.control.receipt/attempt-lifecycle/v1" as const,
            parts: [
                "org-1",
                input.claim.runId,
                input.claim.attempt.id,
                "heartbeat" as const,
                input.request.operationId
            ] as const
        },
        observedAt: input.request.occurredAt,
        payloadDigest: await computeControlPayloadDigestV1(payload),
        runId: input.claim.runId,
        attempt: {
            attemptId: input.claim.attempt.id,
            attemptNumber: input.claim.attempt.number,
            epoch: input.claim.attempt.epoch,
            fencingTokenDigest: input.claim.attempt.fencingTokenDigest
        },
        payload
    };
    return { ...base, receiptDigest: await computeControlReceiptDigestV1(base) };
}
async function rejectStartReceipt(input: {
    claim: HostedClaimV1;
    request: HostedRejectStartRequestV1;
}): Promise<HostedLifecycleReceiptEnvelopeV1> {
    const payload = {
        operation: "reject_start" as const,
        occurredAt: input.request.occurredAt,
        executorId: input.request.executorId,
        reasonCode: input.request.reasonCode
    };
    const base = {
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        receiptKind: "attempt_lifecycle" as const,
        receiptId: await computeHostedLifecycleReceiptIdV1({
            organizationId: input.claim.organizationId,
            operationId: input.request.operationId
        }),
        organizationId: input.claim.organizationId,
        requestId: input.request.requestId,
        operationId: input.request.operationId,
        requestDigest: input.request.requestDigest,
        requiredCapabilities: ["relay.lifecycle.v1"] as const,
        producer: {
            kind: "runner" as const,
            id: input.claim.runnerId,
            credentialId: input.claim.authority.credentialId
        },
        identity: {
            namespace: "opentag.control.receipt/attempt-lifecycle/v1" as const,
            parts: [
                input.claim.organizationId,
                input.claim.runId,
                input.claim.attempt.id,
                "reject_start" as const,
                input.request.operationId
            ] as const
        },
        observedAt: input.request.occurredAt,
        payloadDigest: await computeControlPayloadDigestV1(payload),
        runId: input.claim.runId,
        attempt: {
            attemptId: input.claim.attempt.id,
            attemptNumber: input.claim.attempt.number,
            epoch: input.claim.attempt.epoch,
            fencingTokenDigest: input.claim.attempt.fencingTokenDigest
        },
        payload
    };
    return { ...base, receiptDigest: await computeControlReceiptDigestV1(base) };
}
async function startHostedExecution(repo: ReturnType<typeof createPairedRunnerRepository>, claim: HostedClaimV1): Promise<boolean> {
    const request = await runningRequest(claim);
    const local = await repo.markHostedRunRunningLocally({
        destinationId: "cloud-1",
        organizationId: claim.organizationId,
        runnerId: claim.runnerId,
        credentialId: claim.authority.credentialId,
        runId: claim.runId,
        attemptId: claim.attempt.id,
        fencingToken: claim.attempt.fencingToken,
        executor: claim.executorId,
        request
    });
    if (local.operation.state !== "acknowledged") {
        const claimed = await repo.claimDueHostedLifecycleOperations({
            destinationId: "cloud-1",
            organizationId: claim.organizationId,
            leaseOwner: "test-running-pump",
            leaseSeconds: 30,
            now: new Date()
        });
        const operation = claimed.find((candidate) => candidate.operationId === local.operation.operationId);
        if (!operation?.leaseToken)
            throw new Error("running lifecycle operation was not claimable");
        const payload = {
            operation: "running" as const,
            occurredAt: request.occurredAt,
            executorId: request.executorId,
            executorCapabilityDigest: request.executorCapabilityDigest
        };
        const base = {
            schemaVersion: 1 as const,
            protocolVersion: "1.0" as const,
            receiptKind: "attempt_lifecycle" as const,
            receiptId: await computeHostedLifecycleReceiptIdV1({
                organizationId: claim.organizationId,
                operationId: request.operationId
            }),
            organizationId: claim.organizationId,
            requestId: request.requestId,
            operationId: request.operationId,
            requestDigest: request.requestDigest,
            requiredCapabilities: ["relay.lifecycle.v1"] as const,
            producer: { kind: "runner" as const, id: claim.runnerId, credentialId: claim.authority.credentialId },
            identity: {
                namespace: "opentag.control.receipt/attempt-lifecycle/v1" as const,
                parts: [claim.organizationId, claim.runId, claim.attempt.id, "running" as const, request.operationId] as const
            },
            observedAt,
            payloadDigest: await computeControlPayloadDigestV1(payload),
            runId: claim.runId,
            attempt: {
                attemptId: claim.attempt.id,
                attemptNumber: claim.attempt.number,
                epoch: claim.attempt.epoch,
                fencingTokenDigest: claim.attempt.fencingTokenDigest
            },
            payload
        };
        const receipt = { ...base, receiptDigest: await computeControlReceiptDigestV1(base) };
        await repo.acknowledgeHostedLifecycleOperation({
            destinationId: "cloud-1",
            organizationId: claim.organizationId,
            operationId: operation.operationId,
            leaseToken: operation.leaseToken,
            receipt
        });
    }
    return repo.acquireHostedExecutionStart({
        runId: claim.runId,
        attemptId: claim.attempt.id,
        fencingToken: claim.attempt.fencingToken
    });
}
async function runningRequest(claim: HostedClaimV1): Promise<HostedRunningRequestV1> {
    return await buildHostedLifecycleRequestV1({
        action: "running",
        organizationId: claim.organizationId,
        runnerId: claim.runnerId,
        runId: claim.runId,
        attempt: {
            attemptId: claim.attempt.id,
            attemptNumber: claim.attempt.number,
            epoch: claim.attempt.epoch,
            fencingToken: claim.attempt.fencingToken,
            fencingTokenDigest: claim.attempt.fencingTokenDigest
        },
        occurredAt: observedAt,
        executorId: claim.executorId,
        executorCapabilityDigest: claim.authority.executorCapabilityDigest
    }) as HostedRunningRequestV1;
}
async function progressRequest(claim: HostedClaimV1): Promise<HostedProgressRequestV1> {
    const progressDigest = await computeControlPayloadDigestV1({ type: "status", occurredAt: observedAt });
    return await buildHostedLifecycleRequestV1({
        action: "progress",
        organizationId: claim.organizationId,
        runnerId: claim.runnerId,
        runId: claim.runId,
        attempt: {
            attemptId: claim.attempt.id,
            attemptNumber: claim.attempt.number,
            epoch: claim.attempt.epoch,
            fencingToken: claim.attempt.fencingToken,
            fencingTokenDigest: claim.attempt.fencingTokenDigest
        },
        occurredAt: observedAt,
        progressId: `progress_${progressDigest.slice("sha256:".length)}`,
        progressDigest
    }) as HostedProgressRequestV1;
}
async function completeHostedExecution(
    repo: ReturnType<typeof createPairedRunnerRepository>,
    claim: HostedClaimV1,
    result: Parameters<ReturnType<typeof createPairedRunnerRepository>["completeHostedRunLocally"]>[0]["result"],
) {
    const reasonCodes = {
        success: "executor_success",
        failure: "executor_failure",
        cancelled: "executor_cancelled",
        interrupted: "executor_interrupted",
        timed_out: "executor_timed_out",
        needs_human: "executor_needs_human",
    } as const;
    const request = await buildHostedLifecycleRequestV1({
        action: "complete",
        organizationId: claim.organizationId,
        runnerId: claim.runnerId,
        runId: claim.runId,
        attempt: {
            attemptId: claim.attempt.id,
            attemptNumber: claim.attempt.number,
            epoch: claim.attempt.epoch,
            fencingToken: claim.attempt.fencingToken,
            fencingTokenDigest: claim.attempt.fencingTokenDigest,
        },
        occurredAt: observedAt,
        conclusion: result.conclusion,
        reasonCode: reasonCodes[result.conclusion],
        resultDigest: await computeControlPayloadDigestV1(result),
        artifactDigests: [],
        evidenceDigests: [],
    });
    return repo.completeHostedRunLocally({
        runId: claim.runId,
        result,
        runnerId: claim.runnerId,
        attemptId: claim.attempt.id,
        fencingToken: claim.attempt.fencingToken,
        destinationId: "cloud-1",
        organizationId: claim.organizationId,
        credentialId: claim.authority.credentialId,
        request,
    });
}
function restoreRecoverableHostedAssignment(sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>): void {
    sqlite.prepare(`UPDATE runs SET status='assigned', assigned_runner_id=?, current_attempt_id=?,
    lease_expires_at=? WHERE id=?`).run(value.claim.runnerId, value.claim.attempt.id, value.claim.attempt.leaseExpiresAt, value.claim.runId);
    sqlite.prepare(`UPDATE attempts SET status='assigned', runner_id=?, fencing_token=?,
    lease_expires_at=? WHERE id=?`).run(value.claim.runnerId, value.claim.attempt.fencingToken, value.claim.attempt.leaseExpiresAt, value.claim.attempt.id);
    sqlite.prepare(`UPDATE hosted_claim_operations SET state='claimed', terminal_reason_code=NULL,
    execution_started_at=NULL WHERE operation_id=?`).run(value.request.operationId);
}
describe("hosted assigned Run import", () => {
    it("imports Cloud authority directly and exactly replays without a second claim path", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture();
        await begin(repo, value);
        const created = await repo.importHostedAssignedRun(value);
        expect(created).toMatchObject({
            outcome: "created",
            claimed: {
                run: { id: "hosted-run-1", status: "assigned", assignedRunnerId: "runner-1", executor: "executor-acp" },
                attemptId: "attempt-cloud-1",
                attemptNumber: 1,
                fencingToken: "cloud-fence-1",
                executorId: "executor-acp"
            },
            hostedAuthority: { runnerId: "runner-1", workThreadId: expect.any(String) }
        });
        await expect(repo.importHostedAssignedRun(value)).resolves.toMatchObject({ outcome: "replayed", claimed: created.claimed });
        await expect(repo.getHostedAssignedRunForRecovery({
            destinationId: "cloud-1",
            organizationId: "org-1",
            runnerId: "runner-1"
        })).resolves.toMatchObject({ claimed: created.claimed });
        await expect(startHostedExecution(repo, value.claim)).resolves.toBe(true);
        await expect(repo.acquireHostedExecutionStart({
            runId: "hosted-run-1",
            attemptId: "attempt-cloud-1",
            fencingToken: "cloud-fence-1"
        })).resolves.toBe(false);
        await expect(repo.getHostedAssignedRunForRecovery({
            destinationId: "cloud-1",
            organizationId: "org-1",
            runnerId: "runner-1"
        })).resolves.toBeNull();
        expect(sqlite.prepare("SELECT COUNT(*) count FROM work_threads").get()).toEqual({ count: 1 });
        expect(sqlite.prepare("SELECT * FROM attempts WHERE id = ?").get("attempt-cloud-1")).toMatchObject({
            run_id: "hosted-run-1",
            number: 1,
            runner_id: "runner-1",
            selected_executor_id: "executor-acp",
            fencing_token: "cloud-fence-1",
            lease_expires_at: leaseExpiresAt
        });
    });
    it("recovers only the exact succeeded publication fence across Store restart", async () => {
        const directory = await mkdtemp(join(tmpdir(), "opentag-publication-authority-"));
        tempDirs.push(directory);
        const path = join(directory, "store.sqlite");
        const sqlite = new Database(path);
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture();
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        await startHostedExecution(repo, value.claim);
        await expect(completeHostedExecution(repo, value.claim, {
            conclusion: "success",
            summary: "content-free",
        })).resolves.toBe("completed");
        sqlite.close();
        const restartedSqlite = new Database(path);
        migratePairedRunnerSchema(restartedSqlite);
        const restarted = createPairedRunnerRepository(drizzle(restartedSqlite));
        const exact = { destinationId: "cloud-1", organizationId: value.claim.organizationId,
            runnerId: value.claim.runnerId, runId: value.claim.runId,
            attemptId: value.claim.attempt.id,
            fencingTokenDigest: value.claim.attempt.fencingTokenDigest };
        await expect(restarted.getHostedSucceededPublicationAuthority(exact)).resolves.toEqual({
            fencingToken: value.claim.attempt.fencingToken, attemptNumber: value.claim.attempt.number,
        });
        await expect(restarted.getHostedSucceededPublicationAuthority({ ...exact,
            fencingTokenDigest: digestA })).resolves.toBeNull();
        restartedSqlite.prepare("UPDATE hosted_claim_operations SET state='empty' WHERE operation_id=?")
            .run(value.request.operationId);
        await expect(restarted.getHostedSucceededPublicationAuthority(exact)).resolves.toBeNull();
        restartedSqlite.close();
    });
    it("persists only a metadata shell and never stores redeemed execution plaintext", async () => {
        const directory = await mkdtemp(join(tmpdir(), "opentag-hosted-privacy-"));
        tempDirs.push(directory);
        const path = join(directory, "store.sqlite");
        const sqlite = new Database(path);
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const secret = "PRIVATE_REDEEMED_SOURCE_BODY_7f4c9d";
        const value = await fixture({ body: secret });
        await begin(repo, value);
        const imported = await repo.importHostedAssignedRun(value);
        expect(imported.claimed?.event.command.rawText).toBe(secret);
        expect(imported.claimed?.run.contextPacket).toBeDefined();
        expect(sqlite.serialize().includes(Buffer.from(secret))).toBe(false);
        sqlite.close();
        const restartedSqlite = new Database(path);
        migratePairedRunnerSchema(restartedSqlite);
        const restarted = createPairedRunnerRepository(drizzle(restartedSqlite));
        await expect(restarted.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
            organizationId: "org-1", runnerId: "runner-1" })).resolves.toBeNull();
        restartedSqlite.close();
    });
    it("keeps hosted completion echoes out of result, artifact, and audit persistence and evicts memory", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture({ body: "ECHOED_HOSTED_PLAINTEXT_c191" });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        await startHostedExecution(repo, value.claim);
        await expect(completeHostedExecution(repo, value.claim, {
            conclusion: "success",
            summary: "ECHOED_HOSTED_PLAINTEXT_c191",
            artifacts: [{ kind: "patch", title: "ECHOED_HOSTED_PLAINTEXT_c191",
                uri: "opentag://echo", summary: "ECHOED_HOSTED_PLAINTEXT_c191" }],
        }))
            .resolves.toBe("completed");
        expect(sqlite.serialize().includes(Buffer.from("ECHOED_HOSTED_PLAINTEXT_c191"))).toBe(false);
        sqlite.prepare("UPDATE runs SET status = 'assigned', assigned_runner_id = ?, current_attempt_id = ? WHERE id = ?")
            .run(value.claim.runnerId, value.claim.attempt.id, value.claim.runId);
        sqlite.prepare("UPDATE attempts SET status = 'assigned', finished_at = NULL WHERE id = ?")
            .run(value.claim.attempt.id);
        await expect(repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
            organizationId: value.claim.organizationId, runnerId: value.claim.runnerId }))
            .resolves.toBeNull();
        sqlite.close();
    });
    it("evicts an expired hosted payload when recovery discovers the closed Attempt", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-10T00:03:00.000Z"));
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        await expect(repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
            organizationId: value.claim.organizationId, runnerId: value.claim.runnerId })).resolves.toBeNull();
        sqlite.prepare("UPDATE attempts SET lease_expires_at=? WHERE id=?")
            .run("2099-08-10T00:02:00.000Z", value.claim.attempt.id);
        await expect(repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
            organizationId: value.claim.organizationId, runnerId: value.claim.runnerId })).resolves.toBeNull();
        sqlite.close();
    });
    it("evicts hosted payloads on every durable authority-loss branch", async () => {
        const cases = [
            { name: "terminal run", mutate: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => sqlite.prepare("UPDATE runs SET status='failed' WHERE id=?").run(value.claim.runId), probe: "recovery" },
            { name: "non-current attempt", mutate: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => sqlite.prepare("UPDATE runs SET current_attempt_id='different-attempt' WHERE id=?").run(value.claim.runId), probe: "recovery_error" },
            { name: "terminal attempt", mutate: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => sqlite.prepare("UPDATE attempts SET status='failed' WHERE id=?").run(value.claim.attempt.id), probe: "recovery_error" },
            { name: "inactive claim operation", mutate: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => sqlite.prepare("UPDATE hosted_claim_operations SET state='empty' WHERE operation_id=?").run(value.request.operationId), probe: "current" },
            { name: "missing attempt import", mutate: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => {
                    sqlite.exec("BEGIN; DROP TRIGGER hosted_attempt_imports_delete_guard");
                    sqlite.prepare("DELETE FROM hosted_attempt_imports WHERE attempt_id=?").run(value.claim.attempt.id);
                }, restore: (sqlite: Database.Database) => sqlite.exec("ROLLBACK"), probe: "current" },
            { name: "invalid attempt number", mutate: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => sqlite.prepare("UPDATE attempts SET number=number+1 WHERE id=?").run(value.claim.attempt.id),
                restore: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => sqlite.prepare("UPDATE attempts SET number=? WHERE id=?").run(value.claim.attempt.number, value.claim.attempt.id),
                probe: "current" },
            { name: "expired lease", mutate: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => sqlite.prepare("UPDATE attempts SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(value.claim.attempt.id), probe: "current" },
            { name: "stale completion", mutate: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => sqlite.prepare("UPDATE attempts SET fencing_token='different-fence' WHERE id=?").run(value.claim.attempt.id), probe: "complete" },
        ] as const;
        for (const testCase of cases) {
            const sqlite = new Database(":memory:");
            migratePairedRunnerSchema(sqlite);
            const repo = createPairedRunnerRepository(drizzle(sqlite));
            const secret = `HOSTED_EVICTION_${testCase.name.replaceAll(" ", "_")}_7b3a`;
            const value = await fixture({ body: secret });
            await begin(repo, value);
            await repo.importHostedAssignedRun(value);
            if (testCase.probe !== "recovery" && testCase.probe !== "recovery_error") {
                await startHostedExecution(repo, value.claim);
            }
            testCase.mutate(sqlite, value);
            if (testCase.probe === "recovery" || testCase.probe === "recovery_error") {
                const recovery = expect(repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
                    organizationId: value.claim.organizationId, runnerId: value.claim.runnerId }));
                if (testCase.probe === "recovery_error") {
                    await recovery.rejects.toThrow("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                }
                else {
                    await recovery.resolves.toBeNull();
                }
            }
            else if (testCase.probe === "current") {
                await expect(repo.isHostedExecutionCurrent({ runId: value.claim.runId,
                    attemptId: value.claim.attempt.id, fencingToken: value.claim.attempt.fencingToken }))
                    .resolves.toBe(false);
            }
            else {
                await expect(completeHostedExecution(repo, value.claim, {
                    conclusion: "failure",
                    summary: "content-free",
                }))
                    .resolves.toBe("stale_attempt");
            }
            if ("restore" in testCase)
                testCase.restore(sqlite, value);
            sqlite.prepare("UPDATE runs SET status='assigned', assigned_runner_id=?, current_attempt_id=? WHERE id=?")
                .run(value.claim.runnerId, value.claim.attempt.id, value.claim.runId);
            sqlite.prepare("UPDATE attempts SET status='assigned', runner_id=?, fencing_token=?, lease_expires_at=? WHERE id=?")
                .run(value.claim.runnerId, value.claim.attempt.fencingToken, leaseExpiresAt, value.claim.attempt.id);
            sqlite.prepare("UPDATE hosted_claim_operations SET state='claimed' WHERE operation_id=?")
                .run(value.request.operationId);
            await expect(repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
                organizationId: value.claim.organizationId, runnerId: value.claim.runnerId }))
                .resolves.toBeNull();
            expect(sqlite.serialize().includes(Buffer.from(secret))).toBe(false);
            sqlite.close();
        }
    });
    it("retains the exact active hosted payload when terminal reason is null", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const secret = "HOSTED_ACTIVE_TERMINAL_NULL_CONTROL_4de7";
        const value = await fixture({ body: secret });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        await startHostedExecution(repo, value.claim);
        await expect(repo.isHostedExecutionCurrent({ runId: value.claim.runId,
            attemptId: value.claim.attempt.id, fencingToken: value.claim.attempt.fencingToken }))
            .resolves.toBe(true);
        sqlite.prepare("UPDATE hosted_claim_operations SET execution_started_at=NULL WHERE operation_id=?")
            .run(value.request.operationId);
        await expect(repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
            organizationId: value.claim.organizationId, runnerId: value.claim.runnerId }))
            .resolves.toMatchObject({ claimed: { attemptId: value.claim.attempt.id,
                event: { command: { rawText: secret } } } });
        expect(sqlite.serialize().includes(Buffer.from(secret))).toBe(false);
        sqlite.close();
    });
    it("retains canonical active authority after a caller presents a wrong fence", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const secret = "HOSTED_WRONG_CALLER_FENCE_CONTROL_63b8";
        const value = await fixture({ body: secret });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        await startHostedExecution(repo, value.claim);
        await expect(repo.isHostedExecutionCurrent({ runId: value.claim.runId,
            attemptId: value.claim.attempt.id, fencingToken: "caller-wrong-fence" }))
            .resolves.toBe(false);
        await expect(repo.isHostedExecutionCurrent({ runId: value.claim.runId,
            attemptId: value.claim.attempt.id, fencingToken: value.claim.attempt.fencingToken }))
            .resolves.toBe(true);
        sqlite.prepare("UPDATE hosted_claim_operations SET execution_started_at=NULL WHERE operation_id=?")
            .run(value.request.operationId);
        await expect(repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
            organizationId: value.claim.organizationId, runnerId: value.claim.runnerId }))
            .resolves.toMatchObject({ claimed: { attemptId: value.claim.attempt.id,
                event: { command: { rawText: secret } } } });
        expect(sqlite.serialize().includes(Buffer.from(secret))).toBe(false);
        sqlite.close();
    });
    it("rejects and evicts recovery payloads for terminal claimed operations", async () => {
        // Catches removing the terminalReasonCode rejection from getHostedAssignedRunForRecovery().
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const secret = "HOSTED_TERMINAL_RECOVERY_EVICTION_829f";
        const value = await fixture({ body: secret });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        sqlite.prepare(`UPDATE hosted_claim_operations SET state='claimed',
      terminal_reason_code='stale_control_authority' WHERE operation_id=?`)
            .run(value.request.operationId);
        await expect(repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
            organizationId: value.claim.organizationId, runnerId: value.claim.runnerId }))
            .resolves.toBeNull();
        restoreRecoverableHostedAssignment(sqlite, value);
        await expect(repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
            organizationId: value.claim.organizationId, runnerId: value.claim.runnerId }))
            .resolves.toBeNull();
        expect(sqlite.serialize().includes(Buffer.from(secret))).toBe(false);
        sqlite.close();
    });
    it("evicts terminal recovery payloads when the claimed operation run id is null", async () => {
        // Catches checking nullable runId before terminalReasonCode in getHostedAssignedRunForRecovery().
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const secret = "HOSTED_TERMINAL_NULL_RUN_EVICTION_c5a1";
        const value = await fixture({ body: secret });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        sqlite.prepare(`UPDATE hosted_claim_operations SET state='claimed', run_id=NULL, attempt_id=?,
      terminal_reason_code='stale_control_authority' WHERE operation_id=?`)
            .run(value.claim.attempt.id, value.request.operationId);
        expect(sqlite.prepare(`SELECT run_id, attempt_id, terminal_reason_code
      FROM hosted_claim_operations WHERE operation_id=?`).get(value.request.operationId))
            .toEqual({ run_id: null, attempt_id: value.claim.attempt.id,
            terminal_reason_code: "stale_control_authority" });
        await expect(repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
            organizationId: value.claim.organizationId, runnerId: value.claim.runnerId }))
            .resolves.toBeNull();
        restoreRecoverableHostedAssignment(sqlite, value);
        sqlite.prepare("UPDATE hosted_claim_operations SET run_id=? WHERE operation_id=?")
            .run(value.claim.runId, value.request.operationId);
        await expect(repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
            organizationId: value.claim.organizationId, runnerId: value.claim.runnerId }))
            .resolves.toBeNull();
        expect(sqlite.serialize().includes(Buffer.from(secret))).toBe(false);
        sqlite.close();
    });
    it("rejects and evicts current execution payloads for terminal claimed operations", async () => {
        // Catches removing terminal claim rejection and eviction from isHostedExecutionCurrent().
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const secret = "HOSTED_TERMINAL_CURRENT_EVICTION_16ac";
        const value = await fixture({ body: secret });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        await startHostedExecution(repo, value.claim);
        sqlite.prepare(`UPDATE hosted_claim_operations SET state='claimed',
      terminal_reason_code='stale_control_authority' WHERE operation_id=?`)
            .run(value.request.operationId);
        await expect(repo.isHostedExecutionCurrent({ runId: value.claim.runId,
            attemptId: value.claim.attempt.id, fencingToken: value.claim.attempt.fencingToken }))
            .resolves.toBe(false);
        restoreRecoverableHostedAssignment(sqlite, value);
        await expect(repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
            organizationId: value.claim.organizationId, runnerId: value.claim.runnerId }))
            .resolves.toBeNull();
        expect(sqlite.serialize().includes(Buffer.from(secret))).toBe(false);
        sqlite.close();
    });
    it("evicts hosted payloads when active execution APIs prove durable authority loss", async () => {
        const recoveredPayloads: string[] = [];
        const cases = [
            {
                name: "execution lease terminal run",
                prepare: startHostedExecution,
                mutate: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => sqlite.prepare("UPDATE runs SET status='failed' WHERE id=?").run(value.claim.runId),
                probe: async (repo: ReturnType<typeof createPairedRunnerRepository>, value: Awaited<ReturnType<typeof fixture>>) => expect(repo.getHostedExecutionLease({ ...heartbeatAuthority, runId: value.claim.runId,
                    attemptId: value.claim.attempt.id, fencingToken: value.claim.attempt.fencingToken }))
                    .resolves.toBeNull(),
            },
            {
                name: "execution start failed attempt",
                prepare: startHostedExecution,
                mutate: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => sqlite.prepare("UPDATE attempts SET status='failed' WHERE id=?").run(value.claim.attempt.id),
                probe: async (repo: ReturnType<typeof createPairedRunnerRepository>, value: Awaited<ReturnType<typeof fixture>>) => expect(repo.acquireHostedExecutionStart({ runId: value.claim.runId,
                    attemptId: value.claim.attempt.id, fencingToken: value.claim.attempt.fencingToken }))
                    .rejects.toThrow("HOSTED_IMPORT_AUTHORITY_CONFLICT"),
            },
            {
                name: "mark running superseded attempt",
                prepare: async () => true,
                mutate: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => sqlite.prepare("UPDATE runs SET current_attempt_id='superseding-attempt' WHERE id=?")
                    .run(value.claim.runId),
                probe: async (repo: ReturnType<typeof createPairedRunnerRepository>, value: Awaited<ReturnType<typeof fixture>>) => expect(repo.markHostedRunRunningLocally({ ...heartbeatAuthority, runId: value.claim.runId,
                    attemptId: value.claim.attempt.id, fencingToken: value.claim.attempt.fencingToken,
                    executor: value.claim.executorId, request: await runningRequest(value.claim) }))
                    .rejects.toThrow("HOSTED_IMPORT_AUTHORITY_CONFLICT"),
            },
            {
                name: "progress non-current attempt",
                prepare: startHostedExecution,
                mutate: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => sqlite.prepare("UPDATE runs SET current_attempt_id='superseding-attempt' WHERE id=?")
                    .run(value.claim.runId),
                probe: async (repo: ReturnType<typeof createPairedRunnerRepository>, value: Awaited<ReturnType<typeof fixture>>) => expect(repo.recordHostedProgressLocally({ ...heartbeatAuthority, runId: value.claim.runId,
                    attemptId: value.claim.attempt.id, fencingToken: value.claim.attempt.fencingToken,
                    message: "content-free", idempotencyKey: "progress-authority-loss",
                    request: await progressRequest(value.claim) }))
                    .rejects.toThrow("HOSTED_IMPORT_AUTHORITY_CONFLICT"),
            },
            {
                name: "heartbeat abandoned claim",
                prepare: startHostedExecution,
                mutate: (sqlite: Database.Database, value: Awaited<ReturnType<typeof fixture>>) => sqlite.prepare("UPDATE hosted_claim_operations SET terminal_reason_code='stale_control_authority' WHERE operation_id=?")
                    .run(value.request.operationId),
                probe: async (repo: ReturnType<typeof createPairedRunnerRepository>, value: Awaited<ReturnType<typeof fixture>>) => expect(repo.beginHostedHeartbeatOperation({ ...heartbeatAuthority, runId: value.claim.runId,
                    attemptId: value.claim.attempt.id, fencingToken: value.claim.attempt.fencingToken,
                    request: await heartbeatRequest({ claim: value.claim,
                        expectedLeaseExpiresAt: value.claim.attempt.leaseExpiresAt }) }))
                    .rejects.toThrow("HOSTED_HEARTBEAT_OPERATION_CONFLICT"),
            },
        ] as const;
        for (const testCase of cases) {
            const sqlite = new Database(":memory:");
            migratePairedRunnerSchema(sqlite);
            const repo = createPairedRunnerRepository(drizzle(sqlite));
            const secret = `HOSTED_ACTIVE_API_EVICTION_${testCase.name.replaceAll(" ", "_")}_f91d`;
            const value = await fixture({ body: secret });
            await begin(repo, value);
            await repo.importHostedAssignedRun(value);
            await testCase.prepare(repo, value.claim);
            testCase.mutate(sqlite, value);
            await testCase.probe(repo, value);
            restoreRecoverableHostedAssignment(sqlite, value);
            if (await repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
                organizationId: value.claim.organizationId, runnerId: value.claim.runnerId })) {
                recoveredPayloads.push(testCase.name);
            }
            expect(sqlite.serialize().includes(Buffer.from(secret))).toBe(false);
            sqlite.close();
        }
        expect(recoveredPayloads).toEqual([]);
    });
    it("retains an exact active payload across wrong-caller fences on execution APIs", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const secret = "HOSTED_WRONG_CALLER_FENCE_CONTROL_86e2";
        const value = await fixture({ body: secret });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        await startHostedExecution(repo, value.claim);
        await expect(repo.acquireHostedExecutionStart({ runId: value.claim.runId,
            attemptId: value.claim.attempt.id, fencingToken: "wrong-caller-fence" }))
            .rejects.toThrow("HOSTED_IMPORT_AUTHORITY_CONFLICT");
        await expect(repo.getHostedExecutionLease({ ...heartbeatAuthority, runId: value.claim.runId,
            attemptId: value.claim.attempt.id, fencingToken: "wrong-caller-fence" })).resolves.toBeNull();
        await expect(repo.beginHostedHeartbeatOperation({ ...heartbeatAuthority, runId: value.claim.runId,
            attemptId: value.claim.attempt.id, fencingToken: "wrong-caller-fence",
            request: await heartbeatRequest({ claim: value.claim,
                expectedLeaseExpiresAt: value.claim.attempt.leaseExpiresAt }) }))
            .rejects.toThrow("HOSTED_HEARTBEAT_OPERATION_CONFLICT");
        restoreRecoverableHostedAssignment(sqlite, value);
        await expect(repo.getHostedAssignedRunForRecovery({ destinationId: "cloud-1",
            organizationId: value.claim.organizationId, runnerId: value.claim.runnerId }))
            .resolves.toMatchObject({ claimed: { event: { command: { rawText: secret } } } });
        expect(sqlite.serialize().includes(Buffer.from(secret))).toBe(false);
        sqlite.close();
    });
    it("rejects proposal evidence tampering at persistence and read boundaries", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture();
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        await startHostedExecution(repo, value.claim);
        const proposalEvidence = { schemaVersion: 1, kind: "attempt_proposal_evidence",
            attemptId: value.claim.attempt.id, attemptNumber: value.claim.attempt.number,
            workspaceId: "workspace_attempt", workspacePathDigest: `sha256:${"1".repeat(64)}`,
            branch: `opentag/${value.claim.runId}`,
            baseRevision: "a".repeat(40), finalRevision: "b".repeat(40), finalTree: "c".repeat(40),
            diffDigest: "sha256:1bf4fcc26d8874b8c276b08749bf22799ae398f9f1681bb02d3dd828cef8df3e",
            changedFilesDigest: "sha256:7054d00b268c67236e86fd5fafb9dbdae2efdbf5901516aecbcd3d9a4b5ee850",
            changedFiles: ["src/index.ts"], verificationEvidenceDigests: [],
            limitations: ["Task 8 completion gates have not run."],
            evidenceDigest: "sha256:badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb" };
        const result = { conclusion: "success" as const, summary: "done", artifacts: [{
                    id: `${value.claim.runId}:proposal-evidence`, type: "patch_summary", kind: "patch",
                    title: "Immutable proposal evidence", uri: `opentag://run/${value.claim.runId}/proposal-evidence`,
                    summary: "Attempt-bound proposal evidence captured; completion readiness is not assessed here.",
                    sourceRunId: value.claim.runId, createdAt: observedAt,
                    metadata: { proposalEvidence, evidenceDigest: proposalEvidence.evidenceDigest,
                        readiness: "not_assessed" }
                }] };
        await expect(completeHostedExecution(repo, value.claim, result))
            .rejects.toThrow(/proposal_evidence_(?:invalid|digest_mismatch)/u);
        sqlite.close();
    });
    it("replays after restart and preserves the durable journal request after response loss", async () => {
        const directory = await mkdtemp(join(tmpdir(), "opentag-hosted-import-"));
        tempDirs.push(directory);
        const path = join(directory, "store.sqlite");
        const value = await fixture();
        const firstSqlite = new Database(path);
        migratePairedRunnerSchema(firstSqlite);
        const first = createPairedRunnerRepository(drizzle(firstSqlite));
        await begin(first, value);
        firstSqlite.close();
        const secondSqlite = new Database(path);
        migratePairedRunnerSchema(secondSqlite);
        const second = createPairedRunnerRepository(drizzle(secondSqlite));
        await expect(second.getHostedClaimOperationForRetry({ destinationId: "cloud-1", organizationId: "org-1", runnerId: "runner-1" }))
            .resolves.toMatchObject({ request: value.request, state: "pending" });
        await second.importHostedAssignedRun(value);
        secondSqlite.close();
        const thirdSqlite = new Database(path);
        migratePairedRunnerSchema(thirdSqlite);
        await expect(createPairedRunnerRepository(drizzle(thirdSqlite)).importHostedAssignedRun(value))
            .resolves.toMatchObject({ outcome: "replayed" });
        thirdSqlite.close();
    });
    it("expires recovery fail-closed, then recovers and starts only the later Cloud attempt", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
        const directory = await mkdtemp(join(tmpdir(), "opentag-hosted-attempt-"));
        tempDirs.push(directory);
        const path = join(directory, "store.sqlite");
        const firstValue = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
        const secondValue = await fixture({
            claimOperationId: "claim-op-2",
            requestId: "claim-request-2",
            attemptId: "attempt-cloud-2",
            attemptNumber: 2,
            fencingToken: "cloud-fence-2",
            leaseExpiresAt: "2026-08-10T00:05:00.000Z"
        });
        const firstSqlite = new Database(path);
        migratePairedRunnerSchema(firstSqlite);
        const first = createPairedRunnerRepository(drizzle(firstSqlite));
        await begin(first, firstValue);
        await first.importHostedAssignedRun(firstValue);
        firstSqlite.close();
        vi.setSystemTime(new Date("2026-08-10T00:03:00.000Z"));
        const secondSqlite = new Database(path);
        migratePairedRunnerSchema(secondSqlite);
        const second = createPairedRunnerRepository(drizzle(secondSqlite));
        await expect(second.getHostedAssignedRunForRecovery({
            destinationId: "cloud-1",
            organizationId: "org-1",
            runnerId: "runner-1"
        })).resolves.toBeNull();
        await expect(second.acquireHostedExecutionStart({
            runId: "hosted-run-1",
            attemptId: "attempt-cloud-1",
            fencingToken: "cloud-fence-1"
        })).rejects.toMatchObject({ code: "HOSTED_IMPORT_AUTHORITY_CONFLICT" });
        expect(secondSqlite.prepare("SELECT execution_started_at FROM hosted_claim_operations WHERE operation_id = ?").get("claim-op-1")).toEqual({ execution_started_at: null });
        await begin(second, secondValue);
        await expect(second.importHostedAssignedRun(secondValue)).resolves.toMatchObject({
            outcome: "created",
            executionState: "ready_to_start",
            claimed: {
                run: { id: "hosted-run-1" },
                attemptId: "attempt-cloud-2",
                attemptNumber: 2,
                fencingToken: "cloud-fence-2"
            },
            hostedAuthority: { claimOperationId: "claim-op-2", attemptId: "attempt-cloud-2" }
        });
        await expect(second.getHostedAssignedRunForRecovery({
            destinationId: "cloud-1",
            organizationId: "org-1",
            runnerId: "runner-1"
        })).resolves.toMatchObject({
            claimed: { attemptId: "attempt-cloud-2", attemptNumber: 2 },
            hostedAuthority: { claimOperationId: "claim-op-2", attemptId: "attempt-cloud-2" },
            leaseExpiresAt: "2026-08-10T00:05:00.000Z"
        });
        await expect(second.isHostedExecutionCurrent({
            runId: "hosted-run-1",
            attemptId: "attempt-cloud-2",
            fencingToken: "cloud-fence-2"
        })).resolves.toBe(false);
        await expect(second.importHostedAssignedRun(firstValue)).resolves.toMatchObject({
            outcome: "replayed",
            executionState: "superseded",
            executionMayStart: false,
            claimed: null,
            hostedAuthority: { claimOperationId: "claim-op-1", attemptId: "attempt-cloud-1" }
        });
        await expect(second.acquireHostedExecutionStart({
            runId: "hosted-run-1",
            attemptId: "attempt-cloud-1",
            fencingToken: "cloud-fence-1"
        })).rejects.toMatchObject({ code: "HOSTED_IMPORT_AUTHORITY_CONFLICT" });
        await expect(startHostedExecution(second, secondValue.claim)).resolves.toBe(true);
        await expect(second.isHostedExecutionCurrent({
            runId: "hosted-run-1",
            attemptId: "attempt-cloud-2",
            fencingToken: "cloud-fence-2"
        })).resolves.toBe(true);
        await expect(second.isHostedExecutionCurrent({
            runId: "hosted-run-1",
            attemptId: "attempt-cloud-1",
            fencingToken: "cloud-fence-1"
        })).resolves.toBe(false);
        await expect(second.acquireHostedExecutionStart({
            runId: "hosted-run-1",
            attemptId: "attempt-cloud-2",
            fencingToken: "cloud-fence-2"
        })).resolves.toBe(false);
        expect(secondSqlite.prepare("SELECT COUNT(*) count FROM hosted_run_imports").get()).toEqual({ count: 1 });
        expect(secondSqlite.prepare("SELECT COUNT(*) count FROM hosted_attempt_imports").get()).toEqual({ count: 2 });
        expect(secondSqlite.prepare("SELECT COUNT(*) count FROM work_threads").get()).toEqual({ count: 1 });
        secondSqlite.close();
    });
    it("replays immutable hosted lineage after execution starts and after the run becomes terminal", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture();
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        await startHostedExecution(repo, value.claim);
        sqlite.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run("hosted-run-1");
        sqlite.prepare("UPDATE attempts SET status = 'running' WHERE id = ?").run("attempt-cloud-1");
        await expect(repo.importHostedAssignedRun(value)).resolves.toMatchObject({
            outcome: "replayed",
            executionState: "already_started",
            executionMayStart: false,
            claimed: null
        });
        sqlite.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run("hosted-run-1");
        sqlite.prepare("UPDATE attempts SET status = 'succeeded' WHERE id = ?").run("attempt-cloud-1");
        await expect(repo.importHostedAssignedRun(value)).resolves.toMatchObject({
            outcome: "replayed",
            executionState: "terminal",
            executionMayStart: false,
            claimed: null
        });
    });
    it("fails closed after restart when a locally-running Attempt has no in-memory payload", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
        const directory = await mkdtemp(join(tmpdir(), "opentag-running-recovery-"));
        tempDirs.push(directory);
        const path = join(directory, "store.sqlite");
        const value = await fixture({ leaseExpiresAt: "2026-08-10T00:05:00.000Z" });
        const firstSqlite = new Database(path);
        migratePairedRunnerSchema(firstSqlite);
        const first = createPairedRunnerRepository(drizzle(firstSqlite));
        await begin(first, value);
        await first.importHostedAssignedRun(value);
        const runningRequest = await buildHostedLifecycleRequestV1({
            action: "running",
            organizationId: value.claim.organizationId,
            runnerId: value.claim.runnerId,
            runId: value.claim.runId,
            attempt: {
                attemptId: value.claim.attempt.id,
                attemptNumber: value.claim.attempt.number,
                epoch: value.claim.attempt.epoch,
                fencingToken: value.claim.attempt.fencingToken,
                fencingTokenDigest: value.claim.attempt.fencingTokenDigest
            },
            occurredAt: observedAt,
            executorId: value.claim.executorId,
            executorCapabilityDigest: value.claim.authority.executorCapabilityDigest
        }) as HostedRunningRequestV1;
        await expect(first.markHostedRunRunningLocally({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            runnerId: value.claim.runnerId,
            credentialId: value.claim.authority.credentialId,
            runId: value.claim.runId,
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken,
            executor: value.claim.executorId,
            request: runningRequest
        })).resolves.toMatchObject({ outcome: "running", operation: { state: "pending", sequence: 1 } });
        firstSqlite.close();
        const secondSqlite = new Database(path);
        migratePairedRunnerSchema(secondSqlite);
        const second = createPairedRunnerRepository(drizzle(secondSqlite));
        await expect(second.getHostedAssignedRunForRecovery({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            runnerId: value.claim.runnerId
        })).resolves.toBeNull();
        await expect(second.acquireHostedExecutionStart({
            runId: value.claim.runId,
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken
        })).rejects.toMatchObject({ code: "HOSTED_IMPORT_AUTHORITY_CONFLICT" });
        secondSqlite.close();
    });
    it("persists and consumes an exact pre-import claim authority shell", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture();
        await begin(repo, value);
        await expect(repo.persistHostedClaimAuthorityShell({
            destinationId: "cloud-1",
            credentialId: value.claim.authority.credentialId,
            request: value.request,
            claim: value.claim
        })).resolves.toMatchObject({ outcome: "created", operation: { state: "claimed", runId: value.claim.runId } });
        await expect(repo.persistHostedClaimAuthorityShell({
            destinationId: "cloud-1",
            credentialId: value.claim.authority.credentialId,
            request: value.request,
            claim: value.claim
        })).resolves.toMatchObject({ outcome: "replayed" });
        const conflicting = await fixture({
            attemptId: "attempt-cloud-conflict",
            attemptNumber: 2,
            fencingToken: "cloud-fence-conflict"
        });
        await expect(repo.persistHostedClaimAuthorityShell({
            destinationId: "cloud-1",
            credentialId: conflicting.claim.authority.credentialId,
            request: conflicting.request,
            claim: conflicting.claim
        })).rejects.toMatchObject({ code: "HOSTED_CLAIM_OPERATION_CONFLICT" });
        await expect(repo.getHostedClaimOperationForRetry({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            runnerId: value.claim.runnerId
        })).resolves.toMatchObject({ operationId: value.claim.operationId, state: "claimed" });
        await expect(repo.importHostedAssignedRun(value)).resolves.toMatchObject({ outcome: "created" });
        await expect(repo.getHostedClaimOperationForRetry({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            runnerId: value.claim.runnerId
        })).resolves.toBeNull();
    });
    it("journals and exactly replays reject-start from a pre-import authority shell", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture();
        await begin(repo, value);
        await repo.persistHostedClaimAuthorityShell({
            destinationId: "cloud-1",
            credentialId: value.claim.authority.credentialId,
            request: value.request,
            claim: value.claim
        });
        const rejectRequest = await buildHostedLifecycleRequestV1({
            action: "reject-start",
            organizationId: value.claim.organizationId,
            runnerId: value.claim.runnerId,
            runId: value.claim.runId,
            attempt: {
                attemptId: value.claim.attempt.id,
                attemptNumber: value.claim.attempt.number,
                epoch: value.claim.attempt.epoch,
                fencingToken: value.claim.attempt.fencingToken,
                fencingTokenDigest: value.claim.attempt.fencingTokenDigest
            },
            occurredAt: observedAt,
            executorId: value.claim.executorId,
            reasonCode: "unknown_safe_failure"
        }) as HostedRejectStartRequestV1;
        const input = {
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            credentialId: value.claim.authority.credentialId,
            runnerId: value.claim.runnerId,
            runId: value.claim.runId,
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken,
            executorId: value.claim.executorId,
            reason: "source redemption failed",
            request: rejectRequest
        };
        sqlite.exec(`CREATE TRIGGER reject_preimport_lifecycle_insert
      BEFORE INSERT ON hosted_lifecycle_operations
      BEGIN SELECT RAISE(ABORT, 'injected preimport lifecycle failure'); END;`);
        await expect(repo.rejectHostedAttemptStartLocally(input))
            .rejects.toThrow("injected preimport lifecycle failure");
        expect(sqlite.prepare("SELECT active_key AS activeKey FROM hosted_claim_operations WHERE operation_id = ?").get(value.claim.operationId)).toMatchObject({ activeKey: expect.any(String) });
        expect(sqlite.prepare("SELECT count(*) AS count FROM hosted_lifecycle_operations").get())
            .toEqual({ count: 0 });
        sqlite.exec("DROP TRIGGER reject_preimport_lifecycle_insert");
        const first = await repo.rejectHostedAttemptStartLocally(input);
        expect(first).toMatchObject({ outcome: "journaled", operation: { action: "reject-start", sequence: 1 } });
        await expect(repo.rejectHostedAttemptStartLocally(input)).resolves.toMatchObject({
            outcome: "journaled",
            operation: { operationId: first.operation.operationId }
        });
        expect(sqlite.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 0 });
        await expect(repo.getHostedClaimOperationForRetry({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            runnerId: value.claim.runnerId
        })).resolves.toMatchObject({ operationId: value.claim.operationId, state: "claimed" });
        await expect(repo.getHostedPreImportAuthorityRecovery({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            runnerId: value.claim.runnerId
        })).resolves.toMatchObject({
            state: "reject_pending",
            lifecycleOperation: { operationId: first.operation.operationId }
        });
        await expect(repo.importHostedAssignedRun(value))
            .rejects.toMatchObject({ code: "HOSTED_IMPORT_AUTHORITY_CONFLICT" });
        const [retryLease] = await repo.claimDueHostedLifecycleOperations({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            leaseOwner: "reject-pump",
            leaseSeconds: 30
        });
        const retryAt = new Date(Date.now() + 1000);
        await expect(repo.retryHostedLifecycleOperation({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            operationId: rejectRequest.operationId,
            leaseToken: retryLease!.leaseToken!,
            reasonCode: "provider_unavailable",
            nextAttemptAt: retryAt.toISOString()
        })).resolves.toBe("retried");
        await expect(repo.getHostedPreImportAuthorityRecovery({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            runnerId: value.claim.runnerId
        })).resolves.toMatchObject({ state: "reject_pending" });
        const [leasedReject] = await repo.claimDueHostedLifecycleOperations({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            leaseOwner: "reject-pump",
            leaseSeconds: 30,
            now: retryAt
        });
        sqlite.exec(`CREATE TRIGGER ignore_preimport_reject_claim_release
      BEFORE UPDATE OF active_key ON hosted_claim_operations
      WHEN OLD.operation_id = '${value.claim.operationId}'
      BEGIN SELECT RAISE(IGNORE); END;`);
        await expect(repo.acknowledgeHostedLifecycleOperation({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            operationId: rejectRequest.operationId,
            leaseToken: leasedReject!.leaseToken!,
            receipt: await rejectStartReceipt({ claim: value.claim, request: rejectRequest })
        })).rejects.toThrow("hosted_reject_start_claim_update_lost");
        expect(sqlite.prepare("SELECT state, lease_token AS leaseToken FROM hosted_lifecycle_operations WHERE operation_id = ?").get(rejectRequest.operationId)).toEqual({
            state: "leased",
            leaseToken: leasedReject!.leaseToken
        });
        expect(sqlite.prepare("SELECT active_key AS activeKey FROM hosted_claim_operations WHERE operation_id = ?").get(value.claim.operationId)).toMatchObject({ activeKey: expect.any(String) });
        sqlite.exec("DROP TRIGGER ignore_preimport_reject_claim_release");
        await expect(repo.acknowledgeHostedLifecycleOperation({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            operationId: rejectRequest.operationId,
            leaseToken: leasedReject!.leaseToken!,
            receipt: await rejectStartReceipt({ claim: value.claim, request: rejectRequest })
        })).resolves.toBe("acknowledged");
        await expect(repo.getHostedPreImportAuthorityRecovery({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            runnerId: value.claim.runnerId
        })).resolves.toBeNull();
        await expect(repo.getHostedClaimOperationForRetry({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            runnerId: value.claim.runnerId
        })).resolves.toBeNull();
    });
    it("acknowledges a post-import reject-start after the claim shell was consumed", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        expect(sqlite.prepare("SELECT active_key AS activeKey FROM hosted_claim_operations WHERE operation_id = ?").get(value.claim.operationId)).toEqual({ activeKey: null });
        const rejectRequest = await buildHostedLifecycleRequestV1({
            action: "reject-start",
            organizationId: value.claim.organizationId,
            runnerId: value.claim.runnerId,
            runId: value.claim.runId,
            attempt: {
                attemptId: value.claim.attempt.id,
                attemptNumber: value.claim.attempt.number,
                epoch: value.claim.attempt.epoch,
                fencingToken: value.claim.attempt.fencingToken,
                fencingTokenDigest: value.claim.attempt.fencingTokenDigest
            },
            occurredAt: observedAt,
            executorId: value.claim.executorId,
            reasonCode: "unknown_safe_failure"
        }) as HostedRejectStartRequestV1;
        const rejected = await repo.rejectHostedAttemptStartLocally({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            credentialId: value.claim.authority.credentialId,
            runnerId: value.claim.runnerId,
            runId: value.claim.runId,
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken,
            executorId: value.claim.executorId,
            reason: "executor start failed",
            request: rejectRequest
        });
        const [leasedReject] = await repo.claimDueHostedLifecycleOperations({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            leaseOwner: "reject-pump",
            leaseSeconds: 30
        });
        expect(leasedReject).toMatchObject({ operationId: rejected.operation.operationId });
        await expect(repo.acknowledgeHostedLifecycleOperation({
            destinationId: "cloud-1",
            organizationId: value.claim.organizationId,
            operationId: rejectRequest.operationId,
            leaseToken: leasedReject!.leaseToken!,
            receipt: await rejectStartReceipt({ claim: value.claim, request: rejectRequest })
        })).resolves.toBe("acknowledged");
    });
    it("keeps expired hosted assignments outside alternate local claim paths", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture({ leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        expect(sqlite.prepare("SELECT status, current_attempt_id FROM runs WHERE id = ?").get("hosted-run-1"))
            .toEqual({ status: "assigned", current_attempt_id: "attempt-cloud-1" });
        expect(sqlite.prepare("SELECT status FROM attempts WHERE id = ?").get("attempt-cloud-1"))
            .toEqual({ status: "assigned" });
    });
    it("fails closed for Run, admission, operation, attempt, fence, source, and authority collisions", async () => {
        const cases: Array<[
            string,
            Awaited<ReturnType<typeof fixture>>,
            string
        ]> = [
            ["run", await fixture({ admissionId: "admission-2", admissionOperationId: "admission-op-2", claimOperationId: "claim-op-2", requestId: "request-2", attemptId: "attempt-2", deliveryId: "delivery-2", providerEventId: "790", fencingToken: "fence-2" }), "HOSTED_IMPORT_RUN_CONFLICT"],
            ["admission", await fixture({ runId: "run-2", claimOperationId: "claim-op-2", requestId: "request-2", attemptId: "attempt-2", deliveryId: "delivery-2", providerEventId: "790", fencingToken: "fence-2" }), "HOSTED_IMPORT_ADMISSION_CONFLICT"],
            ["operation", await fixture({ runId: "run-2", admissionId: "admission-2", claimOperationId: "claim-op-2", requestId: "request-2", attemptId: "attempt-2", deliveryId: "delivery-2", providerEventId: "790", fencingToken: "fence-2" }), "HOSTED_IMPORT_OPERATION_CONFLICT"],
            ["attempt", await fixture({ runId: "run-2", admissionId: "admission-2", admissionOperationId: "admission-op-2", claimOperationId: "claim-op-2", requestId: "request-2", deliveryId: "delivery-2", providerEventId: "790", fencingToken: "fence-2" }), "HOSTED_IMPORT_ATTEMPT_CONFLICT"],
            ["fence", await fixture({ runId: "run-2", admissionId: "admission-2", admissionOperationId: "admission-op-2", claimOperationId: "claim-op-2", requestId: "request-2", attemptId: "attempt-2", deliveryId: "delivery-2", providerEventId: "790" }), "HOSTED_IMPORT_FENCE_CONFLICT"]
        ];
        for (const [, collision, code] of cases) {
            const sqlite = new Database(":memory:");
            migratePairedRunnerSchema(sqlite);
            const repo = createPairedRunnerRepository(drizzle(sqlite));
            const original = await fixture();
            await begin(repo, original);
            await repo.importHostedAssignedRun(original);
            await begin(repo, collision);
            await expect(repo.importHostedAssignedRun(collision)).rejects.toMatchObject({ code });
            expect(sqlite.prepare("SELECT COUNT(*) count FROM runs").get()).toEqual({ count: 1 });
            sqlite.close();
        }
    });
    it("rejects a redeemed event whose execution-bearing source digest differs", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture();
        await begin(repo, value);
        await expect(repo.importHostedAssignedRun({
            claim: value.claim,
            sourceReceipt: value.sourceReceipt,
            event: { ...value.event, command: { ...value.event.command, rawText: "different command" } }
        })).rejects.toMatchObject({ code: "HOSTED_IMPORT_SOURCE_DIGEST_CONFLICT" });
        expect(sqlite.prepare("SELECT COUNT(*) count FROM runs").get()).toEqual({ count: 0 });
    });
    it("acks an empty poll before allowing a new operation and rejects operation digest drift", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const first = await fixture();
        await begin(repo, first);
        const proposed = await fixture({ claimOperationId: "claim-op-2", requestId: "request-2" });
        await expect(begin(repo, proposed)).resolves.toMatchObject({ outcome: "replayed", operation: { request: first.request } });
        await repo.acknowledgeHostedClaimEmpty({ operationId: first.request.operationId, requestId: first.request.requestId });
        await expect(begin(repo, proposed)).resolves.toMatchObject({ outcome: "created", operation: { request: proposed.request } });
        await expect(repo.beginHostedClaimOperation({
            destinationId: "other-cloud",
            organizationId: "org-1",
            runnerId: "runner-1",
            request: { ...proposed.request, requestId: "drifted" }
        })).rejects.toMatchObject({ code: "HOSTED_CLAIM_OPERATION_CONFLICT" });
    });
    it("terminally abandons only an authoritative pending-operation rejection", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture();
        await begin(repo, value);
        await expect(repo.abandonHostedClaimOperation({
            operationId: value.request.operationId,
            requestId: value.request.requestId,
            reasonCode: "stale_control_authority"
        })).resolves.toMatchObject({ state: "empty", terminalReasonCode: "stale_control_authority" });
        await expect(repo.getHostedClaimOperationForRetry({
            destinationId: "cloud-1",
            organizationId: "org-1",
            runnerId: "runner-1"
        })).resolves.toBeNull();
    });
    it("rolls back all imported rows when the canonical WorkThread is corrupt", async () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture();
        await begin(repo, value);
        sqlite.prepare(`INSERT INTO work_threads (
      id, scope_id, canonical_key, provider, owner_container_id, work_item_kind,
      external_id, thread_json, created_at, updated_at
    ) VALUES (?, 'local', ?, 'slack', 'acme/widget', 'thread', 'C123:1700000000.000100', '{}', ?, ?)`)
            .run("corrupt-thread", JSON.stringify(["slack", "github", "acme/widget", "thread",
            "C123:1700000000.000100"]), observedAt, observedAt);
        await expect(repo.importHostedAssignedRun(value)).rejects.toMatchObject({ code: "HOSTED_IMPORT_WORK_THREAD_CONFLICT" });
        expect(sqlite.prepare("SELECT COUNT(*) count FROM runs").get()).toEqual({ count: 0 });
        expect(sqlite.prepare("SELECT state FROM hosted_claim_operations").get()).toEqual({ state: "pending" });
    });
});
describe("hosted heartbeat lease authority", () => {
    it("commits local completion and executor-result lifecycle journal atomically", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const redeemedSecret = "PAIRED_COMPLETION_REDEEMED_SOURCE_6f40c1";
        const value = await fixture({
            body: redeemedSecret,
            leaseExpiresAt: "2026-08-10T00:02:00.000Z",
        });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        await startHostedExecution(repo, value.claim);
        const result = { conclusion: "success" as const, summary: "completed locally" };
        const request = await buildHostedLifecycleRequestV1({
            action: "complete",
            organizationId: "org-1",
            runnerId: "runner-1",
            runId: value.claim.runId,
            attempt: {
                attemptId: value.claim.attempt.id,
                attemptNumber: value.claim.attempt.number,
                epoch: value.claim.attempt.epoch,
                fencingToken: value.claim.attempt.fencingToken,
                fencingTokenDigest: value.claim.attempt.fencingTokenDigest
            },
            occurredAt: "2026-08-10T00:01:00.000Z",
            conclusion: "success",
            reasonCode: "executor_success",
            resultDigest: await computeControlPayloadDigestV1(result),
            artifactDigests: [],
            evidenceDigests: []
        });
        sqlite.exec(`CREATE TRIGGER reject_hosted_complete_journal
      BEFORE INSERT ON hosted_lifecycle_operations
      BEGIN SELECT RAISE(ABORT, 'injected hosted lifecycle failure'); END;`);
        const completion = {
            runId: value.claim.runId,
            result,
            runnerId: "runner-1",
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken,
            destinationId: "cloud-1",
            organizationId: "org-1",
            credentialId: "credential-1",
            request
        };
        const forgedOperationId = `op_${"0".repeat(64)}`;
        await expect(repo.completeHostedRunLocally({
            ...completion,
            request: {
                ...request,
                operationId: forgedOperationId,
                requestId: await computeHostedLifecycleRequestIdV1({
                    operationId: forgedOperationId,
                    requestDigest: request.requestDigest,
                }),
            },
        })).rejects.toMatchObject({ code: "HOSTED_LIFECYCLE_OPERATION_INVALID" });
        await expect(repo.completeHostedRunLocally(completion)).rejects.toThrow("injected hosted lifecycle failure");
        expect(sqlite.prepare("SELECT status, result_json AS resultJson FROM runs WHERE id = ?")
            .get(value.claim.runId)).toEqual({ status: "running", resultJson: null });
        expect(sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'reassessment_obligations'
    `).get()).toBeUndefined();
        sqlite.exec("DROP TRIGGER reject_hosted_complete_journal");
        await expect(repo.completeHostedRunLocally(completion)).resolves.toBe("completed");
        await expect(repo.completeHostedRunLocally(completion)).resolves.toBe("duplicate");
        const alternateRequest = await buildHostedLifecycleRequestV1({
            action: "complete",
            organizationId: "org-1",
            runnerId: "runner-1",
            runId: value.claim.runId,
            attempt: {
                attemptId: value.claim.attempt.id,
                attemptNumber: value.claim.attempt.number,
                epoch: value.claim.attempt.epoch,
                fencingToken: value.claim.attempt.fencingToken,
                fencingTokenDigest: value.claim.attempt.fencingTokenDigest,
            },
            occurredAt: "2026-08-10T00:01:01.000Z",
            conclusion: "success",
            reasonCode: "executor_success",
            resultDigest: await computeControlPayloadDigestV1(result),
            artifactDigests: [],
            evidenceDigests: [],
        });
        await expect(repo.completeHostedRunLocally({
            ...completion,
            request: alternateRequest,
        })).rejects.toMatchObject({ code: "HOSTED_LIFECYCLE_OPERATION_CONFLICT" });
        expect(sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(value.claim.runId))
            .toEqual({ status: "succeeded" });
        expect(sqlite.prepare("SELECT action, state FROM hosted_lifecycle_operations WHERE action = 'complete'").get())
            .toEqual({ action: "complete", state: "pending" });
        expect(sqlite.prepare("SELECT count(*) AS count FROM hosted_lifecycle_operations").get())
            .toEqual({ count: 2 });
        expect(sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'material_actions', 'suggested_changes', 'human_escalations',
        'governance_events', 'reassessment_obligations'
      )
    `).all()).toEqual([]);
        expect(sqlite.serialize().includes(Buffer.from(redeemedSecret))).toBe(false);
    });
    it("validates hosted completion against the one sanitized persisted result", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        await startHostedExecution(repo, value.claim);
        const rawResult = {
            conclusion: "success" as const,
            summary: `completed with ${value.claim.attempt.fencingToken}`,
        };
        const persistedResult = {
            conclusion: "success" as const,
            summary: "completed with [redacted]",
        };
        const mismatchedAttemptRequest = await buildHostedLifecycleRequestV1({
            action: "complete",
            organizationId: "org-1",
            runnerId: "runner-1",
            runId: value.claim.runId,
            attempt: {
                attemptId: value.claim.attempt.id,
                attemptNumber: 2,
                epoch: 2,
                fencingToken: value.claim.attempt.fencingToken,
                fencingTokenDigest: value.claim.attempt.fencingTokenDigest,
            },
            occurredAt: "2026-08-10T00:01:00.000Z",
            conclusion: "success",
            reasonCode: "executor_success",
            resultDigest: await computeControlPayloadDigestV1(persistedResult),
            artifactDigests: [],
            evidenceDigests: [],
        });
        await expect(repo.completeHostedRunLocally({
            runId: value.claim.runId,
            result: rawResult,
            runnerId: "runner-1",
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken,
            destinationId: "cloud-1",
            organizationId: "org-1",
            credentialId: "credential-1",
            request: mismatchedAttemptRequest,
        })).rejects.toMatchObject({ code: "HOSTED_LIFECYCLE_OPERATION_INVALID" });
        expect(sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(value.claim.runId))
            .toEqual({ status: "running" });
        const request = await buildHostedLifecycleRequestV1({
            action: "complete",
            organizationId: "org-1",
            runnerId: "runner-1",
            runId: value.claim.runId,
            attempt: {
                attemptId: value.claim.attempt.id,
                attemptNumber: value.claim.attempt.number,
                epoch: value.claim.attempt.epoch,
                fencingToken: value.claim.attempt.fencingToken,
                fencingTokenDigest: value.claim.attempt.fencingTokenDigest,
            },
            occurredAt: "2026-08-10T00:01:00.000Z",
            conclusion: "success",
            reasonCode: "executor_success",
            resultDigest: await computeControlPayloadDigestV1(persistedResult),
            artifactDigests: [],
            evidenceDigests: [],
        });
        await expect(repo.completeHostedRunLocally({
            runId: value.claim.runId,
            result: rawResult,
            runnerId: "runner-1",
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken,
            destinationId: "cloud-1",
            organizationId: "org-1",
            credentialId: "credential-1",
            request,
        })).resolves.toBe("completed");
        const stored = sqlite.prepare("SELECT result_json AS resultJson FROM runs WHERE id = ?")
            .get(value.claim.runId) as {
            resultJson: string;
        };
        expect(JSON.parse(stored.resultJson)).toEqual({ conclusion: "success",
            summary: "Hosted executor result accepted; execution details were not retained locally.",
            nextAction: "Use authoritative hosted receipts and proposal evidence for follow-up." });
        expect(stored.resultJson).not.toContain(value.claim.attempt.fencingToken);
    });
    it("durably replays the exact pending request after response loss and restart", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
        const directory = await mkdtemp(join(tmpdir(), "opentag-hosted-heartbeat-"));
        tempDirs.push(directory);
        const path = join(directory, "store.sqlite");
        const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
        const firstSqlite = new Database(path);
        migratePairedRunnerSchema(firstSqlite);
        const first = createPairedRunnerRepository(drizzle(firstSqlite));
        await begin(first, value);
        await first.importHostedAssignedRun(value);
        await startHostedExecution(first, value.claim);
        const request = await heartbeatRequest({
            claim: value.claim,
            expectedLeaseExpiresAt: "2026-08-10T00:02:00.000Z"
        });
        await expect(first.beginHostedHeartbeatOperation({
            ...heartbeatAuthority,
            runId: value.claim.runId,
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken,
            request
        })).resolves.toMatchObject({ outcome: "created", operation: { request } });
        firstSqlite.close();
        vi.setSystemTime(new Date("2026-08-10T00:01:15.000Z"));
        const secondSqlite = new Database(path);
        migratePairedRunnerSchema(secondSqlite);
        const second = createPairedRunnerRepository(drizzle(secondSqlite));
        await expect(second.getHostedHeartbeatOperationForRetry({
            ...heartbeatAuthority,
            runId: value.claim.runId,
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken
        })).resolves.toMatchObject({ request, expectedLeaseExpiresAt: request.expectedLeaseExpiresAt });
        await expect(second.beginHostedHeartbeatOperation({
            ...heartbeatAuthority,
            runId: value.claim.runId,
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken,
            request
        })).resolves.toMatchObject({ outcome: "replayed", operation: { request } });
        secondSqlite.close();
    });
    it("rolls back an injected lease mutation when heartbeat journaling loses its insert", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        await startHostedExecution(repo, value.claim);
        const request = await heartbeatRequest({
            claim: value.claim,
            expectedLeaseExpiresAt: "2026-08-10T00:02:00.000Z"
        });
        sqlite.exec(`CREATE TRIGGER mutate_lease_and_ignore_heartbeat_insert
      BEFORE INSERT ON hosted_lifecycle_operations
      WHEN NEW.action = 'heartbeat'
      BEGIN
        UPDATE attempts
          SET lease_expires_at = '2026-08-10T00:01:30.000Z'
          WHERE id = NEW.attempt_id;
        SELECT RAISE(IGNORE);
      END;`);
        await expect(repo.beginHostedHeartbeatOperation({
            ...heartbeatAuthority,
            runId: value.claim.runId,
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken,
            request
        })).rejects.toThrow("hosted_lifecycle_operation_insert_lost");
        expect(sqlite.prepare("SELECT lease_expires_at AS leaseExpiresAt FROM attempts WHERE id = ?").get(value.claim.attempt.id)).toEqual({ leaseExpiresAt: request.expectedLeaseExpiresAt });
        expect(sqlite.prepare("SELECT count(*) AS count FROM hosted_lifecycle_operations WHERE action = 'heartbeat'").get()).toEqual({ count: 0 });
        sqlite.exec("DROP TRIGGER mutate_lease_and_ignore_heartbeat_insert");
        await expect(repo.beginHostedHeartbeatOperation({
            ...heartbeatAuthority,
            runId: value.claim.runId,
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken,
            request
        })).resolves.toMatchObject({ outcome: "created", operation: { request } });
    });
    it("rolls back heartbeat run, attempt, and journal writes when any CAS write is ignored", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-10T00:01:00.000Z"));
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        const repo = createPairedRunnerRepository(drizzle(sqlite));
        const value = await fixture({ leaseExpiresAt: "2026-08-10T00:02:00.000Z" });
        await begin(repo, value);
        await repo.importHostedAssignedRun(value);
        await startHostedExecution(repo, value.claim);
        const request = await heartbeatRequest({
            claim: value.claim,
            expectedLeaseExpiresAt: "2026-08-10T00:02:00.000Z",
        });
        await repo.beginHostedHeartbeatOperation({
            ...heartbeatAuthority,
            runId: value.claim.runId,
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken,
            request,
        });
        const [claimed] = await repo.claimDueHostedLifecycleOperations({
            destinationId: "cloud-1",
            organizationId: "org-1",
            leaseOwner: "heartbeat-pump",
            leaseSeconds: 30,
            now: new Date("2026-08-10T00:01:00.000Z"),
        });
        const receipt = await heartbeatReceipt({
            claim: value.claim,
            request,
            leaseExpiresAt: "2026-08-10T00:04:00.000Z",
        });
        const mismatchedRequest = await buildHostedLifecycleRequestV1({
            action: "heartbeat",
            organizationId: "org-1",
            runnerId: "runner-1",
            runId: value.claim.runId,
            attempt: {
                attemptId: value.claim.attempt.id,
                attemptNumber: 2,
                epoch: 2,
                fencingToken: value.claim.attempt.fencingToken,
                fencingTokenDigest: value.claim.attempt.fencingTokenDigest,
            },
            occurredAt: "2026-08-10T00:01:00.000Z",
            expectedLeaseExpiresAt: "2026-08-10T00:02:00.000Z",
        });
        expect(mismatchedRequest.attempt.attemptNumber).toBe(2);
        const mismatchedReceipt = await heartbeatReceipt({
            claim: {
                ...value.claim,
                attempt: { ...value.claim.attempt, number: 2, epoch: 2 },
            },
            request: mismatchedRequest,
            leaseExpiresAt: "2026-08-10T00:04:00.000Z",
        });
        await expect(repo.acknowledgeHostedLifecycleOperation({
            destinationId: "cloud-1",
            organizationId: "org-1",
            operationId: request.operationId,
            leaseToken: claimed!.leaseToken!,
            receipt: mismatchedReceipt,
            now: new Date("2026-08-10T00:01:01.000Z"),
        })).resolves.toBe("stale_lease");
        sqlite.exec(`CREATE TRIGGER ignore_hosted_run_heartbeat
      BEFORE UPDATE OF lease_expires_at ON runs
      WHEN OLD.id = '${value.claim.runId}'
      BEGIN SELECT RAISE(IGNORE); END;`);
        await expect(repo.acknowledgeHostedLifecycleOperation({
            destinationId: "cloud-1",
            organizationId: "org-1",
            operationId: request.operationId,
            leaseToken: claimed!.leaseToken!,
            receipt,
            now: new Date("2026-08-10T00:01:01.000Z"),
        })).rejects.toThrow("hosted_heartbeat_lease_update_lost");
        expect(sqlite.prepare("SELECT lease_expires_at FROM runs WHERE id = ?")
            .get(value.claim.runId)).toEqual({ lease_expires_at: "2026-08-10T00:02:00.000Z" });
        expect(sqlite.prepare("SELECT lease_expires_at FROM attempts WHERE id = ?")
            .get(value.claim.attempt.id)).toEqual({ lease_expires_at: "2026-08-10T00:02:00.000Z" });
        expect(sqlite.prepare("SELECT state FROM hosted_lifecycle_operations WHERE operation_id = ?")
            .get(request.operationId)).toEqual({ state: "leased" });
        sqlite.exec("DROP TRIGGER ignore_hosted_run_heartbeat");
        await repo.acknowledgeHostedLifecycleOperation({
            destinationId: "cloud-1",
            organizationId: "org-1",
            operationId: request.operationId,
            leaseToken: claimed!.leaseToken!,
            receipt,
            now: new Date("2026-08-10T00:01:01.000Z"),
        });
        const nextRequest = await heartbeatRequest({
            claim: value.claim,
            expectedLeaseExpiresAt: "2026-08-10T00:04:00.000Z",
            occurredAt: "2026-08-10T00:02:00.000Z",
        });
        await repo.beginHostedHeartbeatOperation({
            ...heartbeatAuthority,
            runId: value.claim.runId,
            attemptId: value.claim.attempt.id,
            fencingToken: value.claim.attempt.fencingToken,
            request: nextRequest,
        });
        const [nextClaim] = await repo.claimDueHostedLifecycleOperations({
            destinationId: "cloud-1",
            organizationId: "org-1",
            leaseOwner: "heartbeat-pump",
            leaseSeconds: 30,
            now: new Date("2026-08-10T00:02:00.000Z"),
        });
        const nextReceipt = await heartbeatReceipt({
            claim: value.claim,
            request: nextRequest,
            leaseExpiresAt: "2026-08-10T00:06:00.000Z",
        });
        sqlite.exec(`CREATE TRIGGER ignore_hosted_heartbeat_journal
      BEFORE UPDATE OF state ON hosted_lifecycle_operations
      WHEN OLD.operation_id = '${nextRequest.operationId}' AND NEW.state = 'acknowledged'
      BEGIN SELECT RAISE(IGNORE); END;`);
        await expect(repo.acknowledgeHostedLifecycleOperation({
            destinationId: "cloud-1",
            organizationId: "org-1",
            operationId: nextRequest.operationId,
            leaseToken: nextClaim!.leaseToken!,
            receipt: nextReceipt,
            now: new Date("2026-08-10T00:02:01.000Z"),
        })).rejects.toThrow("hosted_heartbeat_journal_update_lost");
        expect(sqlite.prepare("SELECT lease_expires_at FROM runs WHERE id = ?")
            .get(value.claim.runId)).toEqual({ lease_expires_at: "2026-08-10T00:04:00.000Z" });
        expect(sqlite.prepare("SELECT lease_expires_at FROM attempts WHERE id = ?")
            .get(value.claim.attempt.id)).toEqual({ lease_expires_at: "2026-08-10T00:04:00.000Z" });
        expect(sqlite.prepare("SELECT state FROM hosted_lifecycle_operations WHERE operation_id = ?")
            .get(nextRequest.operationId)).toEqual({ state: "leased" });
    });
});
