import type { AdapterMutationCompiler, ApplyIntentOutcome, MutationIntent } from "@opentag/core";
import { createMergeRequestViaFetch, type FetchLike } from "./merge-request.js";

export type GitLabMutationTarget = {
  token: string;
  projectPathWithNamespace: string;
  baseUrl?: string;
};

export type GitLabMutationOperation = {
  kind: "create_merge_request";
  intentId: string;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  removeSourceBranch?: boolean;
};

export type GitLabMutationCompilation =
  | {
      ok: true;
      intentId: string;
      operation: GitLabMutationOperation;
    }
  | {
      ok: false;
      outcome: ApplyIntentOutcome;
    };

function stringParam(intent: MutationIntent, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = intent.params?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function booleanParam(intent: MutationIntent, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = intent.params?.[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function stringArrayParam(intent: MutationIntent, key: string): string[] {
  const value = intent.params?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function verificationLinesFromIntent(intent: MutationIntent): string[] {
  const value = intent.params?.["verification"];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
      const command = (item as Record<string, unknown>)["command"];
      const outcome = (item as Record<string, unknown>)["outcome"];
      return typeof command === "string" && typeof outcome === "string" ? `- \`${command}\`: ${outcome}` : undefined;
    })
    .filter((line): line is string => Boolean(line));
}

function mergeRequestDescriptionFromIntent(intent: MutationIntent): string {
  const explicitBody = stringParam(intent, "body", "description");
  const changedFiles = stringArrayParam(intent, "changedFiles");
  const risks = stringArrayParam(intent, "risks");
  const verification = verificationLinesFromIntent(intent);
  const executorConditions = stringArrayParam(intent, "executorConditions");
  const lines = explicitBody ? [explicitBody] : ["## Summary", "", intent.summary];
  if (changedFiles.length > 0) {
    lines.push("", "## Changed Files", ...changedFiles.map((file) => `- \`${file}\``));
  }
  if (risks.length > 0) {
    lines.push("", "## Risks", ...risks.map((risk) => `- ${risk}`));
  }
  if (verification.length > 0) {
    lines.push("", "## Verification", ...verification);
  }
  if (executorConditions.length > 0) {
    lines.push("", "## Executor Conditions", ...executorConditions.map((condition) => `- ${condition}`));
  }
  return lines.join("\n");
}

export function compileGitLabMutationIntent(intent: MutationIntent): GitLabMutationCompilation {
  if (intent.action !== "create_pull_request") {
    return {
      ok: false,
      outcome: {
        intentId: intent.intentId,
        outcome: "unsupported",
        message: `GitLab apply supports create_pull_request only, not ${intent.action}.`
      }
    };
  }

  const sourceBranch = stringParam(intent, "head", "branch", "sourceBranch", "source_branch");
  if (!sourceBranch) {
    return {
      ok: false,
      outcome: {
        intentId: intent.intentId,
        outcome: "failed",
        message: "create_pull_request requires params.head or params.branch."
      }
    };
  }

  const removeSourceBranch = booleanParam(intent, "removeSourceBranch", "remove_source_branch");
  return {
    ok: true,
    intentId: intent.intentId,
    operation: {
      kind: "create_merge_request",
      intentId: intent.intentId,
      title: stringParam(intent, "title") ?? intent.summary,
      description: mergeRequestDescriptionFromIntent(intent),
      sourceBranch,
      targetBranch: stringParam(intent, "base", "baseBranch", "targetBranch", "target_branch") ?? "main",
      ...(removeSourceBranch !== undefined ? { removeSourceBranch } : {})
    }
  };
}

export function createGitLabMutationCompiler(): AdapterMutationCompiler<GitLabMutationOperation> {
  return {
    adapter: "gitlab",
    compile(intent) {
      const compilation = compileGitLabMutationIntent(intent);
      if (!compilation.ok) {
        return {
          ok: false,
          adapter: "gitlab",
          outcome: compilation.outcome
        };
      }
      return {
        ok: true,
        adapter: "gitlab",
        intentId: compilation.intentId,
        operation: compilation.operation
      };
    }
  };
}

export async function applyGitLabMutationOperation(input: {
  target: GitLabMutationTarget;
  operation: GitLabMutationOperation;
  fetchImpl?: FetchLike;
}): Promise<ApplyIntentOutcome> {
  try {
    const externalUri = await createMergeRequestViaFetch(
      {
        token: input.target.token,
        projectPathWithNamespace: input.target.projectPathWithNamespace,
        ...(input.target.baseUrl ? { baseUrl: input.target.baseUrl } : {}),
        title: input.operation.title,
        description: input.operation.description,
        sourceBranch: input.operation.sourceBranch,
        targetBranch: input.operation.targetBranch,
        ...(input.operation.removeSourceBranch !== undefined ? { removeSourceBranch: input.operation.removeSourceBranch } : {})
      },
      input.fetchImpl ?? fetch
    );
    return { intentId: input.operation.intentId, outcome: "applied", externalUri };
  } catch (error) {
    return {
      intentId: input.operation.intentId,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function applyGitLabMutationIntent(input: {
  target: GitLabMutationTarget;
  intent: MutationIntent;
  fetchImpl?: FetchLike;
}): Promise<ApplyIntentOutcome> {
  const compiled = compileGitLabMutationIntent(input.intent);
  if (!compiled.ok) return compiled.outcome;
  return applyGitLabMutationOperation({
    target: input.target,
    operation: compiled.operation,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
}
