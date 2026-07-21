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
import { createOpenTagRepository, type StoredVerificationEvidence } from "@opentag/store";

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
  const value = metadata?.["completionFact"];
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

    async getWorkLoop(workThreadId: string): Promise<WorkLoopView | null> {
      const contract = await input.repo.getLatestCompletionContractForWorkThread({ workThreadId });
      if (!contract) return null;
      return governance.read({ type: "get_work_loop", workThreadId }) as Promise<WorkLoopView>;
    }
  };
}
