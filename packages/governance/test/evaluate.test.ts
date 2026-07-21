import type {
  CompletionContract,
  CompletionWaiver,
  HumanEscalation,
  OpenTagRunResult
} from "@opentag/core";
import { describe, expect, it } from "vitest";
import {
  completionInputDigest,
  createOpenTagGovernance,
  evaluateCompletion,
  type CompletionArtifact,
  type CompletionEvaluationSnapshot,
  type CompletionEvidenceFact,
  type GovernanceRepository
} from "../src/index.js";

const t0 = "2026-07-21T10:00:00.000Z";
const t1 = "2026-07-21T10:01:00.000Z";
const t2 = "2026-07-21T10:02:00.000Z";
const t3 = "2026-07-21T10:03:00.000Z";

function strictContract(): CompletionContract {
  return {
    id: "contract-github-1",
    version: 1,
    workThreadId: "thread-1",
    cycle: 1,
    mode: "governed",
    targetSelectors: [{ key: "primary_change", kind: "change_request", lineage: "current_cycle", cardinality: "exactly_one" }],
    resolvedFrom: [{ scope: "work_context_owner_container", ref: "github:acme/demo", version: "1" }],
    gates: [
      { id: "pr", kind: "artifact", targetKey: "primary_change", artifactKind: "pull_request", minimum: 1 },
      {
        id: "checks",
        kind: "verification",
        targetKey: "primary_change",
        evidenceKind: "source_control.required_checks",
        requiredObservations: ["build", "test"],
        requiredOutcome: "passed",
        minimumAssurance: "verified"
      },
      { id: "merge", kind: "external_state", targetKey: "primary_change", provider: "github", requiredState: "merged", minimumAssurance: "verified" }
    ],
    maxAutomaticRetries: 1,
    onSatisfied: "report_only",
    createdAt: t0
  };
}

function compatibilityContract(): CompletionContract {
  return {
    id: "compat-1",
    version: 1,
    workThreadId: "thread-1",
    cycle: 1,
    mode: "execution_compat",
    targetSelectors: [],
    resolvedFrom: [{ scope: "organization_default", ref: "compatibility" }],
    gates: [{ id: "execution", kind: "material_action", actionFamily: "executor_run", requiredOutcome: "succeeded" }],
    maxAutomaticRetries: 0,
    onSatisfied: "report_only",
    createdAt: t0
  };
}

const successResult: OpenTagRunResult = { conclusion: "success", summary: "Created pull request." };

function prArtifact(input: { ref?: string; version?: string; id?: string } = {}): CompletionArtifact {
  return {
    id: input.id ?? "artifact-pr-7",
    kind: "pull_request",
    uri: "https://github.com/acme/demo/pull/7",
    target: {
      key: "primary_change",
      provider: "github",
      resourceRef: input.ref ?? "github:acme/demo:pull_request:7",
      resourceVersion: input.version ?? "head-2"
    },
    recordedAt: t1
  };
}

function evidence(input: {
  id: string;
  kind: string;
  predicate: string;
  outcome: string;
  assurance?: CompletionEvidenceFact["assurance"];
  ref?: string;
  version?: string;
  observations?: Record<string, string>;
  observedAt?: string;
}): CompletionEvidenceFact {
  return {
    id: input.id,
    workThreadId: "thread-1",
    cycle: 1,
    kind: input.kind,
    assurance: input.assurance ?? "verified",
    subject: {
      provider: "github",
      resourceRef: input.ref ?? "github:acme/demo:pull_request:7",
      resourceVersion: input.version ?? "head-2"
    },
    claim: {
      predicate: input.predicate,
      outcome: input.outcome,
      ...(input.observations ? { observations: input.observations } : {})
    },
    provenance: {
      adapter: "github",
      adapterVersion: "phase1",
      payloadDigest: `sha256:${input.id.padEnd(64, "0").slice(0, 64)}`,
      providerDeliveryId: `delivery-${input.id}`
    },
    observedAt: input.observedAt ?? t2,
    receivedAt: input.observedAt ?? t2
  };
}

function baseInput() {
  return {
    contract: strictContract(),
    runResults: [{ runId: "run-1", result: successResult, recordedAt: t1 }],
    artifacts: [prArtifact()],
    evidence: [] as CompletionEvidenceFact[],
    materialActionReceipts: [],
    waivers: [] as CompletionWaiver[]
  };
}

describe("evaluateCompletion", () => {
  it("keeps compatibility execution success out of evidence-backed completion metrics", () => {
    const assessment = evaluateCompletion({
      ...baseInput(),
      contract: compatibilityContract(),
      artifacts: []
    });

    expect(assessment).toMatchObject({ state: "satisfied", evidenceBacked: false });
    expect(assessment.gateResults[0]).toMatchObject({ reasonCode: "execution_succeeded", state: "passed" });

    const failed = evaluateCompletion({
      ...baseInput(),
      contract: compatibilityContract(),
      artifacts: [],
      runResults: [{ runId: "run-1", result: { conclusion: "cancelled", summary: "Stopped." }, recordedAt: t1 }]
    });
    expect(failed).toMatchObject({ state: "unsatisfied", evidenceBacked: false });
  });

  it("requires verified current-head checks and merge after executor success", () => {
    const pending = evaluateCompletion(baseInput());
    expect(pending.state).toBe("pending");
    expect(pending.gateResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ gateId: "pr", state: "passed" }),
      expect.objectContaining({ gateId: "checks", state: "missing" }),
      expect.objectContaining({ gateId: "merge", state: "missing" })
    ]));

    const reportedChecks = evidence({
      id: "checks-reported",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      assurance: "reported",
      observations: { build: "passed", test: "passed" }
    });
    const insufficient = evaluateCompletion({ ...baseInput(), evidence: [reportedChecks] });
    expect(insufficient).toMatchObject({ state: "blocked" });
    expect(insufficient.gateResults.find((gate) => gate.gateId === "checks")).toMatchObject({ reasonCode: "verification_assurance_insufficient" });

    const verifiedChecks = evidence({
      id: "checks-verified",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      observations: { build: "passed", test: "passed" }
    });
    const merged = evidence({ id: "merge-verified", kind: "source_control.pull_request", predicate: "state", outcome: "merged", observedAt: t3 });
    const satisfied = evaluateCompletion({ ...baseInput(), evidence: [merged, verifiedChecks] });

    expect(satisfied).toMatchObject({ state: "satisfied", evidenceBacked: true, acceptedAt: t3 });
    expect(satisfied.targetBindings).toEqual([expect.objectContaining({ resourceRef: "github:acme/demo:pull_request:7", resourceVersion: "head-2" })]);
  });

  it("never combines a PR, checks, and merge from different targets or stale heads", () => {
    const checksWrongPr = evidence({
      id: "checks-pr-8",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      ref: "github:acme/demo:pull_request:8",
      observations: { build: "passed", test: "passed" }
    });
    const mergeOldHead = evidence({
      id: "merge-old-head",
      kind: "source_control.pull_request",
      predicate: "state",
      outcome: "merged",
      version: "head-1"
    });
    const assessment = evaluateCompletion({ ...baseInput(), evidence: [checksWrongPr, mergeOldHead] });

    expect(assessment.state).toBe("pending");
    expect(assessment.gateResults.find((gate) => gate.gateId === "checks")).toMatchObject({ state: "missing", reasonCode: "verification_missing" });
    expect(assessment.gateResults.find((gate) => gate.gateId === "merge")).toMatchObject({ state: "missing", reasonCode: "external_state_stale" });
  });

  it("is independent of evidence arrival order and fails closed on unknown action receipts", () => {
    const checks = evidence({
      id: "checks-verified",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      observations: { build: "passed", test: "passed" }
    });
    const merge = evidence({ id: "merge-verified", kind: "source_control.pull_request", predicate: "state", outcome: "merged" });
    const left = evaluateCompletion({ ...baseInput(), evidence: [checks, merge] });
    const right = evaluateCompletion({ ...baseInput(), evidence: [merge, checks] });

    expect(right).toEqual(left);
    expect(completionInputDigest({ ...baseInput(), evidence: [merge, checks] })).toBe(
      completionInputDigest({ ...baseInput(), evidence: [checks, merge] })
    );

    const contract: CompletionContract = {
      ...strictContract(),
      gates: [{ id: "publish", kind: "material_action", actionFamily: "release", requiredOutcome: "succeeded" }],
      targetSelectors: []
    };
    const unknown = evaluateCompletion({
      ...baseInput(),
      contract,
      artifacts: [],
      materialActionReceipts: [{
        id: "receipt-1",
        actionId: "action-1",
        provider: "github",
        receiptRef: "receipt:1",
        outcome: "unknown",
        observedAt: t2,
        metadata: { actionFamily: "release" }
      }]
    });
    expect(unknown).toMatchObject({ state: "blocked" });
    expect(unknown.gateResults[0]).toMatchObject({ state: "unknown", reasonCode: "material_action_unknown" });
  });

  it("applies only bounded, current-contract waivers", () => {
    const waiver: CompletionWaiver = {
      id: "waiver-1",
      contractId: "contract-github-1",
      contractVersion: 1,
      cycle: 1,
      actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
      reason: "Merge is intentionally deferred for this bounded cycle.",
      scope: "selected_gates",
      policyScope: "work_context_owner_container",
      gateIds: ["checks", "merge"],
      waivedAt: t2,
      expiresAt: "2026-07-21T11:00:00.000Z"
    };
    const waived = evaluateCompletion({ ...baseInput(), waivers: [waiver], evaluatedAt: t3 });
    expect(waived).toMatchObject({ state: "waived", assessedBy: "human", waiver: { id: waiver.id } });

    const expired = evaluateCompletion({ ...baseInput(), waivers: [waiver], evaluatedAt: "2026-07-21T12:00:00.000Z" });
    expect(expired.state).toBe("pending");
    expect(expired.waiver).toBeUndefined();
  });
});

describe("OpenTagGovernance command/query interface", () => {
  it("records evidence, reassesses once, and suppresses duplicate command effects", async () => {
    let snapshot: CompletionEvaluationSnapshot = { ...baseInput(), currentAssessment: null };
    const assessments = new Map<string, ReturnType<typeof evaluateCompletion>>();
    const escalations: HumanEscalation[] = [];
    const repository: GovernanceRepository = {
      async loadEvaluationSnapshot() {
        return snapshot;
      },
      async recordEvidence(item) {
        if (snapshot.evidence.some((existing) => existing.id === item.id)) return { created: false };
        snapshot = { ...snapshot, evidence: [...snapshot.evidence, item] };
        return { created: true };
      },
      async recordWaiver(item) {
        if (snapshot.waivers.some((existing) => existing.id === item.id)) return { created: false };
        snapshot = { ...snapshot, waivers: [...snapshot.waivers, item] };
        return { created: true };
      },
      async resolveHumanEscalation(item) {
        escalations.push(item);
        return { resolved: true };
      },
      async appendAssessment({ assessment, expectedCurrentAssessmentId }) {
        const duplicate = assessments.get(assessment.inputDigest);
        if (duplicate) return { outcome: "duplicate" as const, assessment: duplicate };
        if ((snapshot.currentAssessment?.id ?? null) !== expectedCurrentAssessmentId) {
          return { outcome: "conflict" as const, currentAssessment: snapshot.currentAssessment };
        }
        assessments.set(assessment.inputDigest, assessment);
        snapshot = { ...snapshot, currentAssessment: assessment };
        return { outcome: "recorded" as const, assessment };
      },
      async listHumanEscalations() {
        return escalations;
      }
    };
    const governance = createOpenTagGovernance({
      repository,
      clock: { now: () => t3 },
      ids: { assessmentId: (digest, sequence) => `custom-${digest.slice(-8)}-${sequence}` }
    });
    const checks = evidence({
      id: "checks-verified",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      observations: { build: "passed", test: "passed" }
    });

    const first = await governance.execute({ type: "ingest_evidence", commandId: "command-1", evidence: checks });
    const replay = await governance.execute({ type: "ingest_evidence", commandId: "command-1", evidence: checks });

    expect(first).toMatchObject({ outcome: "recorded", assessment: { state: "pending" } });
    expect(first.assessment.id).toMatch(/^custom-/u);
    expect(replay).toMatchObject({ outcome: "duplicate", assessment: { id: first.assessment.id } });
    expect(assessments).toHaveLength(1);
    await expect(governance.read({ type: "get_work_loop", workThreadId: "thread-1" })).resolves.toMatchObject({
      execution: "succeeded",
      completion: "pending",
      missingGateIds: ["merge"]
    });
  });

  it("serializes concurrent evidence reassessments without regressing the assessment head", async () => {
    let snapshot: CompletionEvaluationSnapshot = { ...baseInput(), currentAssessment: null };
    const assessments: ReturnType<typeof evaluateCompletion>[] = [];
    const repository: GovernanceRepository = {
      async loadEvaluationSnapshot() {
        await Promise.resolve();
        return snapshot;
      },
      async recordEvidence(item) {
        if (snapshot.evidence.some((existing) => existing.id === item.id)) return { created: false };
        snapshot = { ...snapshot, evidence: [...snapshot.evidence, item] };
        return { created: true };
      },
      async recordWaiver() {
        return { created: false };
      },
      async resolveHumanEscalation() {
        return { resolved: false };
      },
      async appendAssessment({ assessment, expectedCurrentAssessmentId }) {
        await Promise.resolve();
        const duplicate = assessments.find((item) => item.inputDigest === assessment.inputDigest);
        if (duplicate) return { outcome: "duplicate" as const, assessment: duplicate };
        if ((snapshot.currentAssessment?.id ?? null) !== expectedCurrentAssessmentId) {
          return { outcome: "conflict" as const, currentAssessment: snapshot.currentAssessment };
        }
        assessments.push(assessment);
        snapshot = { ...snapshot, currentAssessment: assessment };
        return { outcome: "recorded" as const, assessment };
      },
      async listHumanEscalations() {
        return [];
      }
    };
    const governance = createOpenTagGovernance({ repository, clock: { now: () => t3 } });
    const checks = evidence({
      id: "checks-concurrent",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      observations: { build: "passed", test: "passed" }
    });
    const merge = evidence({
      id: "merge-concurrent",
      kind: "source_control.pull_request_state",
      predicate: "state",
      outcome: "merged"
    });

    await Promise.all([
      governance.execute({ type: "ingest_evidence", commandId: "checks", evidence: checks }),
      governance.execute({ type: "ingest_evidence", commandId: "merge", evidence: merge })
    ]);

    expect(snapshot.currentAssessment).toMatchObject({ state: "satisfied", sequence: assessments.length });
    expect(assessments.map((item) => item.sequence)).toEqual(assessments.map((_, index) => index + 1));
    expect(assessments.at(-1)?.inputDigest).toBe(completionInputDigest({ ...baseInput(), evidence: [checks, merge] }));
  });

  it("replays durable inputs without a new assessment and preserves first acceptance time", async () => {
    const checks = evidence({
      id: "checks-accepted",
      kind: "source_control.required_checks",
      predicate: "checks",
      outcome: "passed",
      observations: { build: "passed", test: "passed" }
    });
    const merge = evidence({
      id: "merge-accepted",
      kind: "source_control.pull_request_state",
      predicate: "state",
      outcome: "merged"
    });
    let snapshot: CompletionEvaluationSnapshot = { ...baseInput(), evidence: [checks, merge], currentAssessment: null };
    const assessments: ReturnType<typeof evaluateCompletion>[] = [];
    const repository: GovernanceRepository = {
      async loadEvaluationSnapshot() { return snapshot; },
      async recordEvidence(item) {
        if (snapshot.evidence.some((existing) => existing.id === item.id)) return { created: false };
        snapshot = { ...snapshot, evidence: [...snapshot.evidence, item] };
        return { created: true };
      },
      async recordWaiver() { return { created: false }; },
      async resolveHumanEscalation() { return { resolved: false }; },
      async appendAssessment({ assessment, expectedCurrentAssessmentId }) {
        if ((snapshot.currentAssessment?.id ?? null) !== expectedCurrentAssessmentId) {
          return { outcome: "conflict" as const, currentAssessment: snapshot.currentAssessment };
        }
        assessments.push(assessment);
        snapshot = { ...snapshot, currentAssessment: assessment };
        return { outcome: "recorded" as const, assessment };
      },
      async listHumanEscalations() { return []; }
    };
    let now = t3;
    const governance = createOpenTagGovernance({ repository, clock: { now: () => now } });
    const accepted = await governance.execute({ type: "reassess_completion", commandId: "first", workThreadId: "thread-1" });
    now = "2026-07-21T10:10:00.000Z";
    const replay = await governance.execute({ type: "reassess_completion", commandId: "replay", workThreadId: "thread-1" });
    const unrelated = evidence({
      id: "unrelated-accepted",
      kind: "source_control.review",
      predicate: "review",
      outcome: "approved",
      observedAt: now
    });
    const reassessed = await governance.execute({ type: "ingest_evidence", commandId: "unrelated", evidence: unrelated });

    expect(accepted.assessment).toMatchObject({ state: "satisfied", acceptedAt: t3, sequence: 1 });
    expect(replay).toMatchObject({ outcome: "duplicate", assessment: { id: accepted.assessment.id, sequence: 1 } });
    expect(reassessed.assessment).toMatchObject({ state: "satisfied", acceptedAt: t3, sequence: 2 });
    expect(assessments).toHaveLength(2);
  });
});
