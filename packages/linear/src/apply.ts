import type { AdapterMutationCompiler, AdapterMutationMapping, ApplyIntentOutcome, MutationIntent } from "@opentag/core";
import { linearGraphql, type FetchLike } from "./graphql.js";
import { linearIssueIdFromCallbackUri } from "./normalize.js";

export type LinearMutationTarget = {
  token: string;
  issueId?: string;
  graphqlUrl?: string;
};

export type LinearIssueCommentRecord = {
  id?: string;
  url?: string;
};

export type LinearIssueRecord = {
  id?: string;
  url?: string;
};

export type LinearMutationOperation =
  | {
      kind: "create_comment";
      intentId: string;
      body: string;
    }
  | {
      kind: "update_issue";
      intentId: string;
      input: LinearIssueUpdateInput;
    }
  | {
      kind: "create_issue";
      intentId: string;
      input: LinearIssueCreateInput;
    };

export type LinearIssueUpdateInput = {
  stateId?: string;
  assigneeId?: string | null;
  priority?: number | null;
  labelIds?: string[];
};

export type LinearIssueCreateInput = {
  title: string;
  description?: string;
  teamId: string;
  projectId?: string;
  priority?: number | null;
  labelIds?: string[];
  assigneeId?: string | null;
};

export type LinearMutationCompilation =
  | {
      ok: true;
      intentId: string;
      operation: LinearMutationOperation;
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

function numberParam(intent: MutationIntent, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = intent.params?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function stringArrayParam(intent: MutationIntent, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = intent.params?.[key];
    if (!Array.isArray(value)) continue;
    const values = value.filter((item): item is string => typeof item === "string" && item.length > 0);
    if (values.length > 0) return values;
  }
  return undefined;
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function lookupMappingValue(values: Record<string, string>, value: string): string | undefined {
  return values[value] ?? values[slug(value)] ?? values[value.trim().toLowerCase()];
}

function mappingFor(input: { intent: MutationIntent; mappings: AdapterMutationMapping[]; strategy: string; domain?: string }): AdapterMutationMapping | undefined {
  const domain = input.domain ?? input.intent.domain;
  return input.mappings.find(
    (candidate) => candidate.adapter === "linear" && candidate.domain === domain && candidate.strategy === input.strategy
  );
}

function mappedValue(input: { intent: MutationIntent; mappings: AdapterMutationMapping[]; strategy: string; key: string; domain?: string }): string | undefined {
  const semanticValue = stringParam(input.intent, input.key, "value");
  if (!semanticValue) return undefined;
  const mapping = mappingFor(input);
  return mapping ? lookupMappingValue(mapping.values, semanticValue) : undefined;
}

function mappedStringArray(input: { intent: MutationIntent; mappings: AdapterMutationMapping[]; strategy: string; key: string; domain?: string }): string[] | undefined {
  const semanticValues = stringArrayParam(input.intent, input.key);
  if (!semanticValues?.length) return undefined;
  const mapping = mappingFor(input);
  return semanticValues.map((value) => (mapping ? lookupMappingValue(mapping.values, value) : undefined) ?? value).filter((value) => value.length > 0);
}

function mappedNumber(input: { intent: MutationIntent; mappings: AdapterMutationMapping[]; strategy: string; key: string; domain?: string }): number | undefined {
  const mapped = mappedValue(input);
  return mapped !== undefined && Number.isFinite(Number(mapped)) ? Number(mapped) : undefined;
}

function singleMappedValue(input: { mappings: AdapterMutationMapping[]; domain: string; strategy: string }): string | undefined {
  const mapping = input.mappings.find(
    (candidate) => candidate.adapter === "linear" && candidate.domain === input.domain && candidate.strategy === input.strategy
  );
  if (!mapping) return undefined;
  const uniqueValues = [...new Set(Object.values(mapping.values).filter((value) => value.length > 0))];
  return uniqueValues.length === 1 ? uniqueValues[0] : undefined;
}

function commentBodyFromIntent(intent: MutationIntent): string | undefined {
  return stringParam(intent, "body", "comment", "text", "message") ?? (intent.action === "add_comment" ? intent.summary : undefined);
}

function isCreateIssueIntent(intent: MutationIntent): boolean {
  return intent.action === "create_issue" || (intent.domain === "issue" && intent.action === "create");
}

function compileIssueCreateIntent(
  intent: MutationIntent,
  mappings: AdapterMutationMapping[]
): { ok: true; input: LinearIssueCreateInput } | { ok: false; outcome: ApplyIntentOutcome } {
  const title = stringParam(intent, "title")?.trim();
  if (!title) {
    return {
      ok: false,
      outcome: {
        intentId: intent.intentId,
        outcome: "failed",
        message: "create_issue requires params.title."
      }
    };
  }

  const teamId =
    stringParam(intent, "teamId", "team_id") ??
    mappedValue({ intent, mappings, domain: "team", strategy: "team_id", key: "team" }) ??
    mappedValue({ intent, mappings, domain: "team", strategy: "team_id", key: "teamKey" }) ??
    mappedValue({ intent, mappings, domain: "team", strategy: "team_id", key: "team_key" }) ??
    singleMappedValue({ mappings, domain: "team", strategy: "team_id" });
  if (!teamId) {
    return {
      ok: false,
      outcome: {
        intentId: intent.intentId,
        outcome: "unsupported",
        message: "Linear issue creation requires params.teamId, a mapped params.team/teamKey, or a single discovered Linear team mapping."
      }
    };
  }

  const description = stringParam(intent, "description", "body");
  const projectId = stringParam(intent, "projectId", "project_id");
  const priority = numberParam(intent, "priority") ?? mappedNumber({ intent, mappings, domain: "priority", strategy: "priority", key: "priority" });
  const labelIds =
    stringArrayParam(intent, "labelIds", "label_ids") ??
    mappedStringArray({ intent, mappings, domain: "label", strategy: "label_id", key: "labels" }) ??
    mappedStringArray({ intent, mappings, domain: "label", strategy: "label_id", key: "label" });
  const assigneeId =
    stringParam(intent, "assigneeId", "assignee_id") ??
    mappedValue({ intent, mappings, domain: "assignee", strategy: "user_id", key: "assignee" });

  return {
    ok: true,
    input: {
      title,
      teamId,
      ...(description ? { description } : {}),
      ...(projectId ? { projectId } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(labelIds?.length ? { labelIds } : {}),
      ...(assigneeId ? { assigneeId } : {})
    }
  };
}

function compileIssueUpdateIntent(intent: MutationIntent, mappings: AdapterMutationMapping[]): LinearIssueUpdateInput | undefined {
  if (intent.action === "transition_status" || intent.action === "set_status") {
    const stateId = stringParam(intent, "stateId", "state_id") ?? mappedValue({ intent, mappings, strategy: "state_id", key: "status" });
    return stateId ? { stateId } : undefined;
  }
  if (intent.action === "set_assignee") {
    const assigneeId =
      stringParam(intent, "assigneeId", "assignee_id") ??
      mappedValue({ intent, mappings, strategy: "user_id", key: "assignee" }) ??
      stringParam(intent, "assignee");
    return assigneeId ? { assigneeId } : { assigneeId: null };
  }
  if (intent.action === "set_priority") {
    const priority = numberParam(intent, "priority") ?? mappedNumber({ intent, mappings, strategy: "priority", key: "priority" });
    return priority !== undefined ? { priority } : undefined;
  }
  if (intent.action === "set_labels") {
    const labelIds =
      stringArrayParam(intent, "labelIds", "label_ids") ??
      mappedStringArray({ intent, mappings, strategy: "label_id", key: "labels" }) ??
      mappedStringArray({ intent, mappings, strategy: "label_id", key: "label" }) ??
      stringArrayParam(intent, "labels");
    return labelIds ? { labelIds } : undefined;
  }
  return undefined;
}

export function compileLinearMutationIntent(
  intent: MutationIntent,
  options: { mappings?: AdapterMutationMapping[] } = {}
): LinearMutationCompilation {
  if (isCreateIssueIntent(intent)) {
    const compilation = compileIssueCreateIntent(intent, options.mappings ?? []);
    if (!compilation.ok) return compilation;
    return {
      ok: true,
      intentId: intent.intentId,
      operation: { kind: "create_issue", intentId: intent.intentId, input: compilation.input }
    };
  }

  if (intent.action === "add_comment" || intent.action === "create_comment") {
    const body = commentBodyFromIntent(intent);
    if (!body) {
      return {
        ok: false,
        outcome: {
          intentId: intent.intentId,
          outcome: "failed",
          message: `${intent.action} requires params.body, params.comment, or params.text.`
        }
      };
    }
    return {
      ok: true,
      intentId: intent.intentId,
      operation: { kind: "create_comment", intentId: intent.intentId, body }
    };
  }

  const input = compileIssueUpdateIntent(intent, options.mappings ?? []);
  if (input) {
    return {
      ok: true,
      intentId: intent.intentId,
      operation: { kind: "update_issue", intentId: intent.intentId, input }
    };
  }

  return {
    ok: false,
    outcome: {
      intentId: intent.intentId,
      outcome: "unsupported",
      message: `Linear apply does not support ${intent.action}.`
    }
  };
}

export function createLinearMutationCompiler(options: { mappings?: AdapterMutationMapping[] } = {}): AdapterMutationCompiler<LinearMutationOperation> {
  return {
    adapter: "linear",
    compile(intent) {
      const compilation = compileLinearMutationIntent(intent, options);
      if (!compilation.ok) {
        return {
          ok: false,
          adapter: "linear",
          outcome: compilation.outcome
        };
      }
      return {
        ok: true,
        adapter: "linear",
        intentId: compilation.intentId,
        operation: compilation.operation
      };
    }
  };
}

export async function createLinearIssueCommentRecord(input: {
  token: string;
  issueId: string;
  body: string;
  parentId?: string;
  graphqlUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<LinearIssueCommentRecord> {
  const data = await linearGraphql<{
    commentCreate?: {
      success?: boolean;
      comment?: { id?: string; url?: string };
    };
  }>({
    token: input.token,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
    fetchImpl: input.fetchImpl ?? fetch,
    query: `mutation OpenTagCreateLinearComment($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id url }
  }
}`,
    variables: {
      input: {
        issueId: input.issueId,
        body: input.body,
        ...(input.parentId ? { parentId: input.parentId } : {})
      }
    }
  });
  if (data.commentCreate?.success === false) {
    throw new Error("Linear commentCreate returned success=false.");
  }
  return data.commentCreate?.comment ?? {};
}

export async function createLinearIssueComment(input: {
  token: string;
  issueId: string;
  body: string;
  graphqlUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<string | undefined> {
  return (await createLinearIssueCommentRecord(input)).url;
}

export async function updateLinearComment(input: {
  token: string;
  commentId: string;
  body: string;
  graphqlUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<string | undefined> {
  const data = await linearGraphql<{
    commentUpdate?: {
      success?: boolean;
      comment?: { id?: string; url?: string };
    };
  }>({
    token: input.token,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
    fetchImpl: input.fetchImpl ?? fetch,
    query: `mutation OpenTagUpdateLinearComment($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) {
    success
    comment { id url }
  }
}`,
    variables: {
      id: input.commentId,
      input: {
        body: input.body
      }
    }
  });
  if (data.commentUpdate?.success === false) {
    throw new Error("Linear commentUpdate returned success=false.");
  }
  return data.commentUpdate?.comment?.url;
}

export async function updateLinearIssue(input: {
  token: string;
  issueId: string;
  issueInput: LinearIssueUpdateInput;
  graphqlUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<string | undefined> {
  const data = await linearGraphql<{
    issueUpdate?: {
      success?: boolean;
      issue?: { id?: string; url?: string };
    };
  }>({
    token: input.token,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
    fetchImpl: input.fetchImpl ?? fetch,
    query: `mutation OpenTagUpdateLinearIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id url }
  }
}`,
    variables: {
      id: input.issueId,
      input: input.issueInput
    }
  });
  if (data.issueUpdate?.success === false) {
    throw new Error("Linear issueUpdate returned success=false.");
  }
  return data.issueUpdate?.issue?.url;
}

export async function createLinearIssue(input: {
  token: string;
  issueInput: LinearIssueCreateInput;
  graphqlUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<LinearIssueRecord> {
  const data = await linearGraphql<{
    issueCreate?: {
      success?: boolean;
      issue?: { id?: string; url?: string };
    };
  }>({
    token: input.token,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
    fetchImpl: input.fetchImpl ?? fetch,
    query: `mutation OpenTagCreateLinearIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id url }
  }
}`,
    variables: {
      input: input.issueInput
    }
  });
  if (data.issueCreate?.success === false) {
    throw new Error("Linear issueCreate returned success=false.");
  }
  return data.issueCreate?.issue ?? {};
}

export async function applyLinearMutationOperation(input: {
  target: LinearMutationTarget;
  operation: LinearMutationOperation;
  fetchImpl?: FetchLike;
}): Promise<ApplyIntentOutcome> {
  try {
    if (input.operation.kind === "create_issue") {
      const issue = await createLinearIssue({
        token: input.target.token,
        issueInput: input.operation.input,
        ...(input.target.graphqlUrl ? { graphqlUrl: input.target.graphqlUrl } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
      });
      return {
        intentId: input.operation.intentId,
        outcome: "applied",
        ...(issue.id ? { externalId: issue.id } : {}),
        ...(issue.url ? { externalUri: issue.url } : {})
      };
    }

    if (!input.target.issueId) {
      throw new Error(`Linear ${input.operation.kind} requires an existing issue target.`);
    }
    const externalUri =
      input.operation.kind === "create_comment"
        ? await createLinearIssueComment({
            token: input.target.token,
            issueId: input.target.issueId,
            body: input.operation.body,
            ...(input.target.graphqlUrl ? { graphqlUrl: input.target.graphqlUrl } : {}),
            ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
          })
        : await updateLinearIssue({
            token: input.target.token,
            issueId: input.target.issueId,
            issueInput: input.operation.input,
            ...(input.target.graphqlUrl ? { graphqlUrl: input.target.graphqlUrl } : {}),
            ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
          });
    return { intentId: input.operation.intentId, outcome: "applied", ...(externalUri ? { externalUri } : {}) };
  } catch (error) {
    return {
      intentId: input.operation.intentId,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function applyLinearMutationIntent(input: {
  target: LinearMutationTarget;
  intent: MutationIntent;
  mappings?: AdapterMutationMapping[];
  fetchImpl?: FetchLike;
}): Promise<ApplyIntentOutcome> {
  const compiled = compileLinearMutationIntent(input.intent, { mappings: input.mappings ?? [] });
  if (!compiled.ok) return compiled.outcome;
  return applyLinearMutationOperation({
    target: input.target,
    operation: compiled.operation,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
}

export function linearIssueTargetFromCallbackUri(uri: string): { issueId: string } | null {
  const issueId = linearIssueIdFromCallbackUri(uri);
  return issueId ? { issueId } : null;
}
