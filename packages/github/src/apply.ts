import type { AdapterMutationCompiler, AdapterMutationMapping, ApplyIntentOutcome, MutationIntent } from "@opentag/core";
import type { FetchLike } from "./pull-request.js";

export type GitHubIssueMutationTarget = {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  pullRequestNumber?: number;
};

export type GitHubIssueMutationOperation =
  | {
      kind: "add_label";
      intentId: string;
      label: string;
    }
  | {
      kind: "remove_label";
      intentId: string;
      label: string;
    }
  | {
      kind: "replace_mapped_label";
      intentId: string;
      label: string;
      removeLabels: string[];
    }
  | {
      kind: "set_labels";
      intentId: string;
      labels: string[];
    }
  | {
      kind: "set_assignees";
      intentId: string;
      assignees: string[];
    }
  | {
      kind: "add_assignee";
      intentId: string;
      assignee: string;
    }
  | {
      kind: "remove_assignee";
      intentId: string;
      assignee: string;
    }
  | {
      kind: "request_review";
      intentId: string;
      reviewers: string[];
      teamReviewers?: string[];
    };

export type GitHubIssueMutationCompilation =
  | {
      ok: true;
      intentId: string;
      operation: GitHubIssueMutationOperation;
    }
  | {
      ok: false;
      outcome: ApplyIntentOutcome;
    };

function labelFromIntent(intent: MutationIntent): string | undefined {
  const value = intent.params?.["label"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function labelsFromIntent(intent: MutationIntent): string[] | undefined {
  const value = intent.params?.["labels"];
  if (!Array.isArray(value)) return undefined;
  const labels = value.filter((label): label is string => typeof label === "string" && label.length > 0);
  return labels.length > 0 ? labels : undefined;
}

function assigneeFromIntent(intent: MutationIntent): string | undefined {
  const value = intent.params?.["assignee"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function assigneesFromIntent(intent: MutationIntent): string[] | undefined {
  const value = intent.params?.["assignees"];
  if (!Array.isArray(value)) return undefined;
  const assignees = value.filter((assignee): assignee is string => typeof assignee === "string" && assignee.length > 0);
  return assignees.length > 0 ? assignees : undefined;
}

function reviewersFromIntent(intent: MutationIntent): string[] | undefined {
  const reviewer = intent.params?.["reviewer"];
  const reviewers = intent.params?.["reviewers"];
  const values = [
    ...(typeof reviewer === "string" ? [reviewer] : []),
    ...(Array.isArray(reviewers) ? reviewers : [])
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function teamReviewersFromIntent(intent: MutationIntent): string[] | undefined {
  const reviewer = intent.params?.["teamReviewer"];
  const reviewers = intent.params?.["teamReviewers"] ?? intent.params?.["team_reviewers"];
  const values = [
    ...(typeof reviewer === "string" ? [reviewer] : []),
    ...(Array.isArray(reviewers) ? reviewers : [])
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function mappedValueFromIntent(intent: MutationIntent): string | undefined {
  const key = intent.domain === "status" ? "status" : "priority";
  const value = intent.params?.[key] ?? intent.params?.["value"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function labelMappingForIntent(input: { intent: MutationIntent; mappings: AdapterMutationMapping[] }): { label: string; removeLabels: string[] } | undefined {
  const semanticValue = mappedValueFromIntent(input.intent);
  if (!semanticValue) return undefined;
  const mapping = input.mappings.find(
    (candidate) => candidate.adapter === "github" && candidate.domain === input.intent.domain && candidate.strategy === "label"
  );
  const label = mapping?.values[semanticValue];
  if (!label || !mapping) return undefined;
  return {
    label,
    removeLabels: Object.values(mapping.values).filter((mappedLabel) => mappedLabel !== label)
  };
}

async function githubJson(input: {
  target: GitHubIssueMutationTarget;
  fetchImpl: FetchLike;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  okStatuses?: number[];
}): Promise<string | undefined> {
  const response = await input.fetchImpl(`https://api.github.com/repos/${input.target.owner}/${input.target.repo}${input.path}`, {
    method: input.method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.target.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28"
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {})
  });

  if (!response.ok && !(input.okStatuses ?? []).includes(response.status)) {
    throw new Error(`${input.method} ${input.path} failed: ${response.status} ${await response.text()}`);
  }
  return `https://github.com/${input.target.owner}/${input.target.repo}/issues/${input.target.issueNumber}`;
}

export function compileGitHubIssueMutationIntent(
  intent: MutationIntent,
  options: { mappings?: AdapterMutationMapping[]; targetKind?: "issue" | "pull_request" } = {}
): GitHubIssueMutationCompilation {
  if (intent.action === "request_review" || intent.domain === "review") {
    if (options.targetKind !== "pull_request") {
      return {
        ok: false,
        outcome: {
          intentId: intent.intentId,
          outcome: "unsupported",
          message: "GitHub review requests require a pull request target."
        }
      };
    }
    const reviewers = reviewersFromIntent(intent);
    const teamReviewers = teamReviewersFromIntent(intent);
    if (!reviewers?.length && !teamReviewers?.length) {
      return {
        ok: false,
        outcome: {
          intentId: intent.intentId,
          outcome: "failed",
          message: "request_review requires params.reviewer, params.reviewers, or params.teamReviewers."
        }
      };
    }
    return {
      ok: true,
      intentId: intent.intentId,
      operation: {
        kind: "request_review",
        intentId: intent.intentId,
        reviewers: reviewers ?? [],
        ...(teamReviewers?.length ? { teamReviewers } : {})
      }
    };
  }

  if (intent.domain === "status") {
    const mapped = labelMappingForIntent({ intent, mappings: options.mappings ?? [] });
    if (mapped) {
      return { ok: true, intentId: intent.intentId, operation: { kind: "replace_mapped_label", intentId: intent.intentId, ...mapped } };
    }
    return {
      ok: false,
      outcome: {
        intentId: intent.intentId,
        outcome: "unsupported",
        message: "GitHub status writes require an explicit Project field or label mapping policy."
      }
    };
  }
  if (intent.domain === "priority") {
    const mapped = labelMappingForIntent({ intent, mappings: options.mappings ?? [] });
    if (mapped) {
      return { ok: true, intentId: intent.intentId, operation: { kind: "replace_mapped_label", intentId: intent.intentId, ...mapped } };
    }
    return {
      ok: false,
      outcome: {
        intentId: intent.intentId,
        outcome: "unsupported",
        message: "GitHub priority writes require an explicit label or Project field mapping policy."
      }
    };
  }
  if (intent.domain !== "labels" && intent.domain !== "assignee") {
    return {
      ok: false,
      outcome: {
        intentId: intent.intentId,
        outcome: "unsupported",
        message: `GitHub apply supports labels and assignee only, not ${intent.domain}.`
      }
    };
  }

  if (intent.domain === "assignee") {
    if (intent.action === "set_assignee") {
      const assignee = assigneeFromIntent(intent);
      return assignee
        ? { ok: true, intentId: intent.intentId, operation: { kind: "set_assignees", intentId: intent.intentId, assignees: [assignee] } }
        : { ok: false, outcome: { intentId: intent.intentId, outcome: "failed", message: "set_assignee requires params.assignee." } };
    }
    if (intent.action === "set_assignees") {
      const assignees = assigneesFromIntent(intent);
      return assignees
        ? { ok: true, intentId: intent.intentId, operation: { kind: "set_assignees", intentId: intent.intentId, assignees } }
        : { ok: false, outcome: { intentId: intent.intentId, outcome: "failed", message: "set_assignees requires params.assignees." } };
    }
    if (intent.action === "add_assignee") {
      const assignee = assigneeFromIntent(intent);
      return assignee
        ? { ok: true, intentId: intent.intentId, operation: { kind: "add_assignee", intentId: intent.intentId, assignee } }
        : { ok: false, outcome: { intentId: intent.intentId, outcome: "failed", message: "add_assignee requires params.assignee." } };
    }
    if (intent.action === "remove_assignee") {
      const assignee = assigneeFromIntent(intent);
      return assignee
        ? { ok: true, intentId: intent.intentId, operation: { kind: "remove_assignee", intentId: intent.intentId, assignee } }
        : { ok: false, outcome: { intentId: intent.intentId, outcome: "failed", message: "remove_assignee requires params.assignee." } };
    }
    return {
      ok: false,
      outcome: {
        intentId: intent.intentId,
        outcome: "unsupported",
        message: `GitHub apply does not support assignee action ${intent.action}.`
      }
    };
  }

  if (intent.action === "add_label") {
    const label = labelFromIntent(intent);
    return label
      ? { ok: true, intentId: intent.intentId, operation: { kind: "add_label", intentId: intent.intentId, label } }
      : { ok: false, outcome: { intentId: intent.intentId, outcome: "failed", message: "add_label requires params.label." } };
  }
  if (intent.action === "remove_label") {
    const label = labelFromIntent(intent);
    return label
      ? { ok: true, intentId: intent.intentId, operation: { kind: "remove_label", intentId: intent.intentId, label } }
      : { ok: false, outcome: { intentId: intent.intentId, outcome: "failed", message: "remove_label requires params.label." } };
  }
  if (intent.action === "set_labels") {
    const labels = labelsFromIntent(intent);
    return labels
      ? { ok: true, intentId: intent.intentId, operation: { kind: "set_labels", intentId: intent.intentId, labels } }
      : { ok: false, outcome: { intentId: intent.intentId, outcome: "failed", message: "set_labels requires params.labels." } };
  }

  return {
    ok: false,
    outcome: {
      intentId: intent.intentId,
      outcome: "unsupported",
      message: `GitHub apply does not support labels action ${intent.action}.`
    }
  };
}

export function compileGitHubIssueMutationIntents(
  intents: MutationIntent[],
  options: { mappings?: AdapterMutationMapping[]; targetKind?: "issue" | "pull_request" } = {}
): GitHubIssueMutationCompilation[] {
  return intents.map((intent) => compileGitHubIssueMutationIntent(intent, options));
}

export function createGitHubIssueMutationCompiler(options: {
  mappings?: AdapterMutationMapping[];
  targetKind?: "issue" | "pull_request";
} = {}): AdapterMutationCompiler<GitHubIssueMutationOperation> {
  return {
    adapter: "github",
    compile(intent) {
      const compilation = compileGitHubIssueMutationIntent(intent, options);
      if (!compilation.ok) {
        return {
          ok: false,
          adapter: "github",
          outcome: compilation.outcome
        };
      }
      return {
        ok: true,
        adapter: "github",
        intentId: compilation.intentId,
        operation: compilation.operation
      };
    }
  };
}

export async function applyGitHubIssueMutationOperation(input: {
  target: GitHubIssueMutationTarget;
  operation: GitHubIssueMutationOperation;
  fetchImpl?: FetchLike;
}): Promise<ApplyIntentOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    if (input.operation.kind === "request_review") {
      const pullRequestNumber = input.target.pullRequestNumber;
      if (typeof pullRequestNumber !== "number") {
        return {
          intentId: input.operation.intentId,
          outcome: "failed",
          message: "request_review requires target.pullRequestNumber."
        };
      }
      await githubJson({
        target: input.target,
        fetchImpl,
        method: "POST",
        path: `/pulls/${pullRequestNumber}/requested_reviewers`,
        body: {
          reviewers: input.operation.reviewers,
          ...(input.operation.teamReviewers?.length ? { team_reviewers: input.operation.teamReviewers } : {})
        }
      });
      return {
        intentId: input.operation.intentId,
        outcome: "applied",
        externalUri: `https://github.com/${input.target.owner}/${input.target.repo}/pull/${pullRequestNumber}`
      };
    }

    if (input.operation.kind === "set_assignees") {
      const externalUri = await githubJson({
        target: input.target,
        fetchImpl,
        method: "PATCH",
        path: `/issues/${input.target.issueNumber}`,
        body: { assignees: input.operation.assignees }
      });
      return { intentId: input.operation.intentId, outcome: "applied", externalUri };
    }

    if (input.operation.kind === "add_assignee") {
      const externalUri = await githubJson({
        target: input.target,
        fetchImpl,
        method: "POST",
        path: `/issues/${input.target.issueNumber}/assignees`,
        body: { assignees: [input.operation.assignee] }
      });
      return { intentId: input.operation.intentId, outcome: "applied", externalUri };
    }

    if (input.operation.kind === "remove_assignee") {
      const externalUri = await githubJson({
        target: input.target,
        fetchImpl,
        method: "DELETE",
        path: `/issues/${input.target.issueNumber}/assignees`,
        body: { assignees: [input.operation.assignee] }
      });
      return { intentId: input.operation.intentId, outcome: "applied", externalUri };
    }

    if (input.operation.kind === "replace_mapped_label") {
      for (const label of input.operation.removeLabels) {
        await githubJson({
          target: input.target,
          fetchImpl,
          method: "DELETE",
          path: `/issues/${input.target.issueNumber}/labels/${encodeURIComponent(label)}`,
          okStatuses: [200, 404]
        });
      }
      const externalUri = await githubJson({
        target: input.target,
        fetchImpl,
        method: "POST",
        path: `/issues/${input.target.issueNumber}/labels`,
        body: { labels: [input.operation.label] }
      });
      return { intentId: input.operation.intentId, outcome: "applied", externalUri };
    }

    if (input.operation.kind === "add_label") {
      const externalUri = await githubJson({
        target: input.target,
        fetchImpl,
        method: "POST",
        path: `/issues/${input.target.issueNumber}/labels`,
        body: { labels: [input.operation.label] }
      });
      return { intentId: input.operation.intentId, outcome: "applied", externalUri };
    }

    if (input.operation.kind === "remove_label") {
      const externalUri = await githubJson({
        target: input.target,
        fetchImpl,
        method: "DELETE",
        path: `/issues/${input.target.issueNumber}/labels/${encodeURIComponent(input.operation.label)}`
      });
      return { intentId: input.operation.intentId, outcome: "applied", externalUri };
    }

    const externalUri = await githubJson({
      target: input.target,
      fetchImpl,
      method: "PUT",
      path: `/issues/${input.target.issueNumber}/labels`,
      body: { labels: input.operation.labels }
    });
    return { intentId: input.operation.intentId, outcome: "applied", externalUri };
  } catch (error) {
    return {
      intentId: input.operation.intentId,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function applyGitHubIssueMutationIntent(input: {
  target: GitHubIssueMutationTarget;
  intent: MutationIntent;
  mappings?: AdapterMutationMapping[];
  targetKind?: "issue" | "pull_request";
  fetchImpl?: FetchLike;
}): Promise<ApplyIntentOutcome> {
  const compiled = compileGitHubIssueMutationIntent(input.intent, {
    ...(input.mappings ? { mappings: input.mappings } : {}),
    ...(input.targetKind ? { targetKind: input.targetKind } : {})
  });
  if (!compiled.ok) return compiled.outcome;
  return applyGitHubIssueMutationOperation({
    target: input.target,
    operation: compiled.operation,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
}

export async function applyGitHubIssueMutationIntents(input: {
  target: GitHubIssueMutationTarget;
  intents: MutationIntent[];
  mappings?: AdapterMutationMapping[];
  targetKind?: "issue" | "pull_request";
  fetchImpl?: FetchLike;
}): Promise<ApplyIntentOutcome[]> {
  const outcomes: ApplyIntentOutcome[] = [];
  for (const intent of input.intents) {
    outcomes.push(
      await applyGitHubIssueMutationIntent({
        target: input.target,
        intent,
        ...(input.mappings ? { mappings: input.mappings } : {}),
        ...(input.targetKind ? { targetKind: input.targetKind } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
      })
    );
  }
  return outcomes;
}
