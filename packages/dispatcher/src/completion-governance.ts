import { createHash } from "node:crypto";
import {
  CompletionContractSchema,
  type CompletionContract,
  type CompletionWaiver,
  type HumanEscalation,
  type OpenTagEvent,
  type OpenTagRun
} from "@opentag/core";
import {
  createOpenTagGovernance,
  type CompletionArtifact,
  type CompletionEvidenceFact,
  type CompletionEvaluationSnapshot,
  type GovernanceCommandResult,
  type GovernanceRepository,
  type WorkLoopView
} from "@opentag/governance";
import type { GitHubVerifiedPullRequestSnapshot } from "@opentag/github";
import {
  createOpenTagRepository,
  type RecordVerificationEvidenceInput,
  type StoredVerificationEvidence
} from "@opentag/store";

type OpenTagRepository = ReturnType<typeof createOpenTagRepository>;

export type GitHubCompletionPolicy = {
  provider: "github";
  owner: string;
  repo: string;
  requiredChecks: string[];
  baseBranch?: string;
  requireMerge?: boolean;
};

function repositoryIdentity(event: OpenTagEvent): { provider: string; owner: string; repo: string } | null {
  const provider = event.metadata["repoProvider"];
  const owner = event.metadata["owner"];
  const repo = event.metadata["repo"];
  if (typeof provider !== "string" || typeof owner !== "string" || typeof repo !== "string") return null;
  return { provider, owner, repo };
}

function matchingPolicy(event: OpenTagEvent, policies: readonly GitHubCompletionPolicy[]): GitHubCompletionPolicy | undefined {
  const identity = repositoryIdentity(event);
  if (!identity || identity.provider !== "github") return undefined;
  return policies.find((policy) =>
    policy.owner.toLowerCase() === identity.owner.toLowerCase()
    && policy.repo.toLowerCase() === identity.repo.toLowerCase()
  );
}

function validatePolicies(policies: readonly GitHubCompletionPolicy[]): GitHubCompletionPolicy[] {
  const seen = new Set<string>();
  return policies.map((policy, index) => {
    const owner = policy.owner.trim();
    const repo = policy.repo.trim();
    const requiredChecks = [...new Set(policy.requiredChecks.map((name) => name.trim()).filter(Boolean))].sort();
    if (!owner || !repo) throw new Error(`GitHub completion policy ${index} must identify a non-empty owner and repository.`);
    if (requiredChecks.length === 0) throw new Error(`GitHub completion policy ${owner}/${repo} must configure at least one required check.`);
    const key = `${owner}/${repo}`.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate GitHub completion policy for ${owner}/${repo}.`);
    seen.add(key);
    return { ...policy, owner, repo, requiredChecks };
  });
}

function strictContract(input: {
  workThreadId: string;
  policy: GitHubCompletionPolicy;
  createdAt: string;
}): CompletionContract {
  const policyRef = `github:${input.policy.owner}/${input.policy.repo}`;
  return CompletionContractSchema.parse({
    id: `completion:${input.workThreadId}:github-pr`,
    version: 1,
    workThreadId: input.workThreadId,
    cycle: 1,
    mode: "governed",
    targetSelectors: [{ key: "primary_change", kind: "change_request", lineage: "current_cycle", cardinality: "exactly_one" }],
    resolvedFrom: [{ scope: "work_context_owner_container", ref: policyRef, version: "1" }],
    gates: [
      { id: "pull_request", kind: "artifact", targetKey: "primary_change", artifactKind: "pull_request", minimum: 1 },
      {
        id: "required_checks",
        kind: "verification",
        targetKey: "primary_change",
        evidenceKind: "source_control.required_checks",
        requiredObservations: [...new Set(input.policy.requiredChecks)].sort(),
        requiredOutcome: "passed",
        minimumAssurance: "verified"
      },
      ...(input.policy.baseBranch
        ? [{
            id: "base_branch",
            kind: "verification" as const,
            targetKey: "primary_change",
            evidenceKind: "source_control.pull_request",
            requiredObservations: [`base:${input.policy.baseBranch}`],
            requiredOutcome: "passed",
            minimumAssurance: "verified" as const
          }]
        : []),
      ...(input.policy.requireMerge === false
        ? []
        : [{
            id: "merge",
            kind: "external_state" as const,
            targetKey: "primary_change",
            provider: "github" as const,
            requiredState: "merged",
            minimumAssurance: "verified" as const
          }])
    ],
    maxAutomaticRetries: 1,
    onSatisfied: "report_only",
    createdAt: input.createdAt
  });
}

function compatibilityContract(input: { workThreadId: string; createdAt: string }): CompletionContract {
  return CompletionContractSchema.parse({
    id: `completion:${input.workThreadId}:compat`,
    version: 1,
    workThreadId: input.workThreadId,
    cycle: 1,
    mode: "execution_compat",
    targetSelectors: [],
    resolvedFrom: [{ scope: "organization_default", ref: "execution-compatibility", version: "1" }],
    gates: [{ id: "execution", kind: "material_action", actionFamily: "executor_run", requiredOutcome: "succeeded" }],
    maxAutomaticRetries: 0,
    onSatisfied: "report_only",
    createdAt: input.createdAt
  });
}

function parseGitHubPullRequestUrl(
  uri: string,
  repository: { owner: string; repo: string }
): { resourceRef: string } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/u);
  if (!match) return null;
  const [, owner, repo, number] = match;
  if (!owner || !repo || !number) return null;
  if (owner.toLowerCase() !== repository.owner.toLowerCase() || repo.toLowerCase() !== repository.repo.toLowerCase()) return null;
  return { resourceRef: `github:${repository.owner}/${repository.repo}:pull_request:${number}` };
}

function completionFactFromStoredEvidence(record: StoredVerificationEvidence): CompletionEvidenceFact | null {
  const metadata = record.evidence.metadata;
  const direct = metadata?.["completionFact"];
  const template = metadata?.["completionFactTemplate"];
  const value = direct ?? (record.workThreadId && template && typeof template === "object" && !Array.isArray(template)
    ? { ...template as Record<string, unknown>, workThreadId: record.workThreadId }
    : null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fact = value as Partial<CompletionEvidenceFact>;
  if (
    typeof fact.id !== "string"
    || typeof fact.workThreadId !== "string"
    || typeof fact.cycle !== "number"
    || typeof fact.kind !== "string"
    || (fact.assurance !== "verified" && fact.assurance !== "reported" && fact.assurance !== "unverifiable")
    || !fact.subject
    || typeof fact.subject.provider !== "string"
    || typeof fact.subject.resourceRef !== "string"
    || typeof fact.subject.resourceVersion !== "string"
    || !fact.claim
    || typeof fact.claim.predicate !== "string"
    || typeof fact.claim.outcome !== "string"
    || !fact.provenance
    || typeof fact.provenance.adapter !== "string"
    || typeof fact.provenance.adapterVersion !== "string"
    || typeof fact.provenance.payloadDigest !== "string"
    || typeof fact.observedAt !== "string"
    || typeof fact.receivedAt !== "string"
  ) return null;
  return fact as CompletionEvidenceFact;
}

function factDigest(snapshotDigest: string, kind: string): string {
  return `sha256:${createHash("sha256").update(`${snapshotDigest}:${kind}`).digest("hex")}`;
}

function githubFactTemplates(input: {
  snapshot: GitHubVerifiedPullRequestSnapshot;
  receivedAt: string;
}): Array<Omit<CompletionEvidenceFact, "workThreadId">> {
  const common = {
    cycle: 1,
    assurance: "verified" as const,
    subject: {
      provider: "github",
      resourceRef: input.snapshot.pullRequest.resourceRef,
      resourceVersion: input.snapshot.pullRequest.headSha
    },
    observedAt: input.snapshot.observedAt,
    receivedAt: input.receivedAt
  };
  const provenance = (kind: string) => ({
    adapter: "@opentag/github",
    adapterVersion: "0.6.0",
    payloadDigest: factDigest(input.snapshot.payloadDigest, kind),
    providerDeliveryId: input.snapshot.deliveryId
  });
  const idPrefix = `github:${input.snapshot.deliveryId}:pr:${input.snapshot.pullRequest.number}:${input.snapshot.pullRequest.headSha}`;
  return [
    {
      ...common,
      id: `${idPrefix}:identity`,
      kind: "source_control.pull_request",
      claim: {
        predicate: "existence",
        outcome: "passed",
        observations: {
          [`base:${input.snapshot.pullRequest.baseBranch}`]: "passed",
          base_branch: input.snapshot.pullRequest.baseBranch,
          base_sha: input.snapshot.pullRequest.baseSha
        }
      },
      provenance: provenance("source_control.pull_request")
    },
    {
      ...common,
      id: `${idPrefix}:checks`,
      kind: "source_control.required_checks",
      claim: { predicate: "checks", outcome: "passed", observations: input.snapshot.checks },
      provenance: provenance("source_control.required_checks")
    },
    {
      ...common,
      id: `${idPrefix}:state`,
      kind: "source_control.pull_request_state",
      claim: { predicate: "state", outcome: input.snapshot.pullRequest.state },
      provenance: provenance("source_control.pull_request_state")
    }
  ];
}

function githubEvidenceRecords(input: {
  snapshot: GitHubVerifiedPullRequestSnapshot;
  receivedAt: string;
  workThreadId?: string;
}): RecordVerificationEvidenceInput[] {
  return githubFactTemplates(input).map((template) => {
    const fact = input.workThreadId ? { ...template, workThreadId: input.workThreadId } : null;
    return {
      id: template.id,
      ...(input.workThreadId ? { workThreadId: input.workThreadId } : {}),
      provider: "github",
      deliveryId: input.snapshot.deliveryId,
      subjectRef: input.snapshot.pullRequest.resourceRef,
      subjectVersion: input.snapshot.pullRequest.headSha,
      evidence: {
        id: template.id,
        kind: template.kind,
        assurance: "verified",
        subjectRef: `${template.subject.resourceRef}@${template.subject.resourceVersion}`,
        summary: `${template.claim.predicate}=${template.claim.outcome}`,
        sourceRef: `github-api:${input.snapshot.eventName}`,
        createdAt: input.snapshot.observedAt,
        metadata: fact ? { completionFact: fact } : { completionFactTemplate: template }
      },
      payloadDigest: template.provenance.payloadDigest,
      observedAt: input.snapshot.observedAt,
      receivedAt: input.receivedAt
    };
  });
}

function artifactsFromRuns(input: {
  runs: Array<{ run: OpenTagRun; event: OpenTagEvent }>;
  evidence: CompletionEvidenceFact[];
  contract: CompletionContract;
}): CompletionArtifact[] {
  const artifacts: CompletionArtifact[] = [];
  for (const stored of input.runs) {
    const result = stored.run.result;
    if (!result) continue;
    const repository = repositoryIdentity(stored.event);
    if (!repository || repository.provider !== "github") continue;
    const candidates = [
      ...(result.createdPullRequestUrl
        ? [{ id: `${stored.run.id}:created-pull-request`, kind: "pull_request", uri: result.createdPullRequestUrl }]
        : []),
      ...(result.artifacts ?? []).map((artifact, index) => ({
        id: artifact.id ?? `${stored.run.id}:artifact:${index}`,
        kind: artifact.kind ?? artifact.type ?? "custom",
        uri: artifact.uri
      }))
    ];
    for (const candidate of candidates) {
      if (candidate.kind !== "pull_request") continue;
      const parsed = parseGitHubPullRequestUrl(candidate.uri, repository);
      if (!parsed) continue;
      const authoritative = [...input.evidence]
        .filter((fact) =>
          fact.assurance === "verified"
          && fact.subject.provider === "github"
          && fact.subject.resourceRef === parsed.resourceRef
        )
        .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
        .at(-1);
      artifacts.push({
        id: candidate.id,
        kind: "pull_request",
        sourceRunId: stored.run.id,
        uri: candidate.uri,
        target: {
          key: "primary_change",
          provider: "github",
          resourceRef: parsed.resourceRef,
          resourceVersion: authoritative?.subject.resourceVersion ?? "unverified"
        },
        recordedAt: stored.run.updatedAt
      });
    }
  }
  return artifacts;
}

function githubPullRequestResourceRefs(stored: { run: OpenTagRun; event: OpenTagEvent }): Set<string> {
  const repository = repositoryIdentity(stored.event);
  if (!repository || repository.provider !== "github" || !stored.run.result) return new Set();
  const result = stored.run.result;
  const uris = [
    ...(result.createdPullRequestUrl ? [result.createdPullRequestUrl] : []),
    ...(result.artifacts ?? []).flatMap((artifact) =>
      (artifact.kind ?? artifact.type) === "pull_request" ? [artifact.uri] : []
    )
  ];
  return new Set(uris.flatMap((uri) => {
    const parsed = parseGitHubPullRequestUrl(uri, repository);
    return parsed ? [parsed.resourceRef] : [];
  }));
}

async function matchingWorkThreadIds(input: {
  repo: OpenTagRepository;
  resourceRef: string;
}): Promise<string[]> {
  const runs = await input.repo.listRunsWithResults();
  return [...new Set(runs.flatMap((stored) => {
    const workThreadId = stored.run.thread?.id;
    return workThreadId && githubPullRequestResourceRefs(stored).has(input.resourceRef) ? [workThreadId] : [];
  }))].sort();
}

async function attachCorrelatableEvidence(input: {
  repo: OpenTagRepository;
  attachedAt: string;
}): Promise<Set<string>> {
  const uncorrelated = (await input.repo.listVerificationEvidence({})).filter((record) =>
    record.provider === "github" && !record.workThreadId && record.evidence.metadata?.["completionFactTemplate"]
  );
  const attachedThreads = new Set<string>();
  const identities = new Map<string, StoredVerificationEvidence>();
  for (const record of uncorrelated) {
    identities.set(JSON.stringify([record.provider, record.deliveryId, record.subjectRef]), record);
  }
  for (const record of identities.values()) {
    const candidates = await matchingWorkThreadIds({ repo: input.repo, resourceRef: record.subjectRef });
    if (candidates.length !== 1) continue;
    await input.repo.attachVerificationEvidenceDeliveryToWorkThread({
      provider: record.provider,
      deliveryId: record.deliveryId,
      subjectRef: record.subjectRef,
      workThreadId: candidates[0]!,
      attachedAt: input.attachedAt
    });
    attachedThreads.add(candidates[0]!);
  }
  return attachedThreads;
}

async function ensureContract(input: {
  repo: OpenTagRepository;
  run: OpenTagRun;
  event: OpenTagEvent;
  policies: readonly GitHubCompletionPolicy[];
}): Promise<CompletionContract> {
  const workThreadId = input.run.thread?.id;
  if (!workThreadId) throw new Error(`Run ${input.run.id} has no durable WorkThread.`);
  const existing = await input.repo.getLatestCompletionContractForWorkThread({ workThreadId });
  if (existing) return existing;
  const policy = matchingPolicy(input.event, input.policies);
  const contract = policy
    ? strictContract({ workThreadId, policy, createdAt: input.run.updatedAt })
    : compatibilityContract({ workThreadId, createdAt: input.run.updatedAt });
  return (await input.repo.recordCompletionContract({ contract })).contract;
}

export type GitHubCompletionEvidenceIngestion = {
  outcome: "recorded" | "duplicate" | "uncorrelated" | "ambiguous";
  workThreadId?: string;
  completion?: WorkLoopView;
};

export function createDispatcherCompletionGovernance(input: {
  repo: OpenTagRepository;
  policies?: readonly GitHubCompletionPolicy[];
  now?: () => string;
}) {
  const policies = validatePolicies(input.policies ?? []);
  const governanceRepository: GovernanceRepository = {
    async loadEvaluationSnapshot(workThreadId): Promise<CompletionEvaluationSnapshot> {
      const contract = await input.repo.getLatestCompletionContractForWorkThread({ workThreadId });
      if (!contract) throw new Error(`WorkThread ${workThreadId} has no completion contract.`);
      const runs = await input.repo.listRunsForWorkThread({ workThreadId });
      const storedEvidence = await input.repo.listVerificationEvidence({ workThreadId });
      const evidence = storedEvidence.map(completionFactFromStoredEvidence).filter((fact): fact is CompletionEvidenceFact => Boolean(fact));
      const assessments = await input.repo.listCompletionAssessments({ workThreadId });
      return {
        contract,
        runResults: runs.flatMap(({ run }) => run.result ? [{ runId: run.id, result: run.result, recordedAt: run.updatedAt }] : []),
        artifacts: artifactsFromRuns({ runs, evidence, contract }),
        evidence,
        materialActionReceipts: [],
        waivers: assessments.flatMap((assessment) => assessment.waiver ? [assessment.waiver] : []),
        currentAssessment: await input.repo.getCurrentCompletionAssessment({ workThreadId })
      };
    },
    async recordEvidence(fact) {
      const recorded = await input.repo.recordVerificationEvidence({
        id: fact.id,
        workThreadId: fact.workThreadId,
        provider: fact.subject.provider,
        deliveryId: fact.provenance.providerDeliveryId ?? fact.provenance.sourceEventId ?? fact.id,
        subjectRef: fact.subject.resourceRef,
        subjectVersion: fact.subject.resourceVersion,
        evidence: {
          id: fact.id,
          kind: fact.kind,
          assurance: fact.assurance,
          subjectRef: `${fact.subject.resourceRef}@${fact.subject.resourceVersion}`,
          summary: `${fact.claim.predicate}=${fact.claim.outcome}`,
          sourceRef: `${fact.provenance.adapter}@${fact.provenance.adapterVersion}`,
          createdAt: fact.observedAt,
          metadata: { completionFact: fact }
        },
        payloadDigest: fact.provenance.payloadDigest,
        observedAt: fact.observedAt,
        receivedAt: fact.receivedAt
      });
      return { created: recorded.created };
    },
    async recordWaiver(_waiver: CompletionWaiver) {
      throw new Error("Completion waiver persistence is not enabled until the bounded waiver slice.");
    },
    async resolveHumanEscalation(escalation: HumanEscalation) {
      return input.repo.resolveHumanEscalation({ escalation });
    },
    async appendAssessment(assessmentInput) {
      return input.repo.appendCompletionAssessment(assessmentInput);
    },
    async listHumanEscalations(workThreadId) {
      return input.repo.listHumanEscalations({ workThreadId });
    }
  };
  const governance = createOpenTagGovernance({
    repository: governanceRepository,
    clock: { now: input.now ?? (() => new Date().toISOString()) }
  });

  return {
    async ingestRunResult(runId: string): Promise<GovernanceCommandResult | null> {
      const stored = await input.repo.getRun({ runId });
      if (!stored?.run.thread?.id || !stored.run.result) return null;
      await ensureContract({ repo: input.repo, run: stored.run, event: stored.event, policies });
      await attachCorrelatableEvidence({ repo: input.repo, attachedAt: input.now?.() ?? new Date().toISOString() });
      return governance.execute({
        type: "ingest_run_result",
        commandId: `run-result:${runId}:${stored.run.updatedAt}`,
        workThreadId: stored.run.thread.id,
        runId
      });
    },

    async ingestEvidence(fact: CompletionEvidenceFact): Promise<GovernanceCommandResult> {
      return governance.execute({ type: "ingest_evidence", commandId: `evidence:${fact.id}`, evidence: fact });
    },

    async ingestGitHubSnapshot(snapshot: GitHubVerifiedPullRequestSnapshot): Promise<GitHubCompletionEvidenceIngestion> {
      const expectedRef = `github:${snapshot.repository.owner}/${snapshot.repository.repo}:pull_request:${snapshot.pullRequest.number}`;
      if (snapshot.pullRequest.resourceRef !== expectedRef) {
        throw new Error("GitHub completion evidence resource identity does not match its repository and pull request number.");
      }
      const existing = (await input.repo.listVerificationEvidence({})).filter((record) =>
        record.provider === "github"
        && record.deliveryId === snapshot.deliveryId
        && record.subjectRef === snapshot.pullRequest.resourceRef
      );
      if (existing.length > 0) {
        const attached = [...new Set(existing.flatMap((record) => record.workThreadId ? [record.workThreadId] : []))];
        if (attached.length === 1) {
          const workThreadId = attached[0]!;
          const completion = await governance.read({ type: "get_work_loop", workThreadId }) as WorkLoopView;
          return { outcome: "duplicate", workThreadId, completion };
        }
        const newlyAttached = await attachCorrelatableEvidence({
          repo: input.repo,
          attachedAt: input.now?.() ?? new Date().toISOString()
        });
        if (newlyAttached.size === 1) {
          const workThreadId = [...newlyAttached][0]!;
          const result = await governance.execute({
            type: "reassess_completion",
            commandId: `github-evidence:${snapshot.deliveryId}:${snapshot.pullRequest.resourceRef}`,
            workThreadId
          });
          return { outcome: "duplicate", workThreadId, completion: result.view };
        }
        return { outcome: "duplicate" };
      }
      const candidates = await matchingWorkThreadIds({ repo: input.repo, resourceRef: snapshot.pullRequest.resourceRef });
      const workThreadId = candidates.length === 1 ? candidates[0] : undefined;
      const receivedAt = input.now?.() ?? new Date().toISOString();
      await input.repo.recordVerificationEvidenceBatch({
        records: githubEvidenceRecords({ snapshot, receivedAt, ...(workThreadId ? { workThreadId } : {}) })
      });
      if (!workThreadId) {
        return { outcome: candidates.length > 1 ? "ambiguous" : "uncorrelated" };
      }
      const result = await governance.execute({
        type: "reassess_completion",
        commandId: `github-evidence:${snapshot.deliveryId}:${snapshot.pullRequest.resourceRef}`,
        workThreadId
      });
      return { outcome: "recorded", workThreadId, completion: result.view };
    },

    async getWorkLoop(workThreadId: string): Promise<WorkLoopView | null> {
      const contract = await input.repo.getLatestCompletionContractForWorkThread({ workThreadId });
      if (!contract) return null;
      return governance.read({ type: "get_work_loop", workThreadId }) as Promise<WorkLoopView>;
    }
  };
}
