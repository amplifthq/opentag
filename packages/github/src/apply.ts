import type { AdapterMutationCompiler, AdapterMutationMapping, ApplyIntentOutcome, MutationIntent } from "@opentag/core";
import type { FetchLike } from "./pull-request.js";

export type GitHubIssueMutationTarget = {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
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

function mappedValueFromIntent(intent: MutationIntent): string | undefined {
  const key = intent.domain === "status" ? "status" : "priority";
  const value = intent.params?.[key] ?? intent.params?.["value"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function labelMappingForIntent(input: { intent: MutationIntent; mappings: AdapterMutationMapping[] }): string | undefined {
  const semanticValue = mappedValueFromIntent(input.intent);
  if (!semanticValue) return undefined;
  const mapping = input.mappings.find(
    (candidate) => candidate.adapter === "github" && candidate.domain === input.intent.domain && candidate.strategy === "label"
  );
  return mapping?.values[semanticValue];
}

async function githubJson(input: {
  target: GitHubIssueMutationTarget;
  fetchImpl: FetchLike;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
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

  if (!response.ok) {
    throw new Error(`${input.method} ${input.path} failed: ${response.status} ${await response.text()}`);
  }
  return `https://github.com/${input.target.owner}/${input.target.repo}/issues/${input.target.issueNumber}`;
}

export function compileGitHubIssueMutationIntent(
  intent: MutationIntent,
  options: { mappings?: AdapterMutationMapping[] } = {}
): GitHubIssueMutationCompilation {
  if (intent.domain === "status") {
    const label = labelMappingForIntent({ intent, mappings: options.mappings ?? [] });
    if (label) {
      return { ok: true, intentId: intent.intentId, operation: { kind: "add_label", intentId: intent.intentId, label } };
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
    const label = labelMappingForIntent({ intent, mappings: options.mappings ?? [] });
    if (label) {
      return { ok: true, intentId: intent.intentId, operation: { kind: "add_label", intentId: intent.intentId, label } };
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
  options: { mappings?: AdapterMutationMapping[] } = {}
): GitHubIssueMutationCompilation[] {
  return intents.map((intent) => compileGitHubIssueMutationIntent(intent, options));
}

export function createGitHubIssueMutationCompiler(options: {
  mappings?: AdapterMutationMapping[];
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
  fetchImpl?: FetchLike;
}): Promise<ApplyIntentOutcome> {
  const compiled = compileGitHubIssueMutationIntent(input.intent);
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
  fetchImpl?: FetchLike;
}): Promise<ApplyIntentOutcome[]> {
  const outcomes: ApplyIntentOutcome[] = [];
  for (const intent of input.intents) {
    outcomes.push(await applyGitHubIssueMutationIntent({ target: input.target, intent, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) }));
  }
  return outcomes;
}
