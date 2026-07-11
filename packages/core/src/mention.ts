import type {
  AgentTarget,
  CommandParseDiagnostic,
  CommandReference,
  OpenTagCommand,
  PermissionGrant
} from "./schema.js";

type MentionMatch = { matched: false } | ({ matched: true } & OpenTagCommand);
type KnownIntent = Exclude<OpenTagCommand["intent"], "unknown">;
type CommandArgValue = OpenTagCommand["args"][string];
type CommandFlagValue = CommandArgValue | CommandArgValue[];

const INTENTS: KnownIntent[] = ["fix", "review", "investigate", "explain", "run"];
const KNOWN_FLAGS = new Set([
  "approval",
  "executor",
  "file",
  "label",
  "line",
  "network",
  "path",
  "range",
  "runner",
  "scope",
  "timeout",
  "url"
]);
const SINGLE_VALUE_FLAGS = new Set(["approval", "executor", "line", "network", "range", "runner", "timeout"]);
const APPROVAL_VALUES = new Set<NonNullable<NonNullable<OpenTagCommand["parsed"]>["approval"]>>(["auto", "required", "never"]);
const EXECUTOR_HINTS = new Set<AgentTarget["executorHint"]>(["claude-code", "codex", "hermes", "openclaw", "custom"]);
const PERMISSION_SCOPES = new Set<PermissionGrant["scope"]>([
  "repo:read",
  "repo:write",
  "issue:comment",
  "issue:create",
  "chat:postMessage",
  "reactions:write",
  "pr:create",
  "pr:update",
  "runner:local",
  "network:restricted"
]);

export function commandFromRawText(rawText: string): OpenTagCommand {
  const normalizedRawText = rawText.trim();
  const parsed = parseCommandText(normalizedRawText);

  return {
    rawText: normalizedRawText,
    intent: parsed.intent,
    args: parsed.args,
    parsed: parsed.command
  };
}

export function parseOpenTagMention(body: string, mention = "@opentag"): MentionMatch {
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}(?=[\\s:,.!?]|$)`, "i");
  const match = body.match(pattern);

  if (typeof match?.index !== "number") {
    return { matched: false };
  }

  const rawText = extractCommandText(body.slice(match.index + match[0].length), mention);
  if (!rawText) {
    return { matched: false };
  }

  return {
    matched: true,
    ...commandFromRawText(rawText)
  };
}

function parseCommandText(rawText: string): { intent: OpenTagCommand["intent"]; args: OpenTagCommand["args"]; command: NonNullable<OpenTagCommand["parsed"]> } {
  const diagnostics: CommandParseDiagnostic[] = [];
  const { tokens, diagnostics: tokenDiagnostics } = tokenizeCommand(rawText);
  diagnostics.push(...tokenDiagnostics);

  const firstToken = tokens[0]?.toLowerCase();
  const intent = firstToken && isKnownIntent(firstToken) ? firstToken : "unknown";
  const commandTokens = intent === "unknown" ? tokens : tokens.slice(1);
  const parsed = parseCommandTokens(commandTokens, diagnostics);
  const references = referencesFromFlags(parsed.flags, diagnostics);
  const requestedScopes = requestedScopesFromFlags(parsed.flags, diagnostics);
  const network = stringValuesForFlag(parsed.flags, "network")[0]?.toLowerCase();
  if (network && network !== "restricted") {
    diagnostics.push({
      level: "warning",
      code: "invalid_network_policy",
      message: `Unsupported network policy '${network}'. V1 only supports 'restricted'.`,
      token: network
    });
  }
  const approval = enumValueForFlag(parsed.flags, "approval", APPROVAL_VALUES, diagnostics);
  const executorHint = executorHintFromFlags(parsed.flags, diagnostics);
  const normalizedNetwork = network === "restricted" ? "restricted" : undefined;

  if (normalizedNetwork === "restricted" && !requestedScopes.includes("network:restricted")) {
    requestedScopes.push("network:restricted");
  }

  const args = argsFromParsed(parsed.prompt, parsed.flags);
  if (approval) {
    args.approval = approval;
  }
  if (normalizedNetwork) {
    args.network = normalizedNetwork;
  }
  if (executorHint) {
    args.executor = executorHint;
  }

  if (tokens.length === 0) {
    diagnostics.push({
      level: "error",
      code: "empty_command",
      message: "The OpenTag command is empty."
    });
  }

  const command: NonNullable<OpenTagCommand["parsed"]> = {
    version: "v1",
    prompt: parsed.prompt,
    flags: parsed.flags,
    references,
    requestedScopes,
    diagnostics
  };
  if (approval) {
    command.approval = approval;
  }
  if (normalizedNetwork) {
    command.network = normalizedNetwork;
  }
  if (executorHint) {
    command.executorHint = executorHint;
  }

  return { intent, args, command };
}

function extractCommandText(afterMention: string, mention: string): string | null {
  const normalized = afterMention.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^[ \t]*[:,-]?[ \t]*/, "");
  const [firstLineRaw = "", ...remainingLines] = normalized.split("\n");
  const firstLine = firstLineRaw.trim();

  if (firstLine.length > 0) {
    const lines = [stripContinuationMarker(firstLine)];
    if (shouldConsumeContinuation(firstLine, remainingLines)) {
      lines.push(...collectContinuationLines(remainingLines, mention));
    }
    return joinCommandLines(lines);
  }

  return joinCommandLines(collectContinuationLines(remainingLines, mention, true));
}

function shouldConsumeContinuation(firstLine: string, remainingLines: string[]): boolean {
  if (!remainingLines.some((line) => line.trim().length > 0)) {
    return false;
  }

  const nextNonBlank = remainingLines.find((line) => line.trim().length > 0)?.trim();
  return (
    firstLine.trimEnd().endsWith("\\") ||
    nextNonBlank?.startsWith("--") === true
  );
}

function collectContinuationLines(lines: string[], mention: string, skipLeadingBlank = false): string[] {
  const collected: string[] = [];
  let started = !skipLeadingBlank;
  const mentionPattern = new RegExp(`^${mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s:,.!?]|$)`, "i");

  for (const line of lines) {
    const trimmed = line.trim();
    started = true;
    if (mentionPattern.test(trimmed)) {
      break;
    }
    collected.push(trimmed.length === 0 ? "" : stripContinuationMarker(trimmed));
  }

  return collected;
}

function stripContinuationMarker(line: string): string {
  return line.trimEnd().replace(/\\$/, "").trim();
}

function joinCommandLines(lines: string[]): string | null {
  const joined = lines.join("\n").trim();
  return joined.length > 0 ? joined : null;
}

function tokenizeCommand(rawText: string): { tokens: string[]; diagnostics: CommandParseDiagnostic[] } {
  const tokens: string[] = [];
  const diagnostics: CommandParseDiagnostic[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of rawText) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += "\\";
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  if (quote) {
    diagnostics.push({
      level: "warning",
      code: "unterminated_quote",
      message: `Command contains an unterminated ${quote} quote.`
    });
  }

  return { tokens, diagnostics };
}

function parseCommandTokens(
  tokens: string[],
  diagnostics: CommandParseDiagnostic[]
): { prompt: string; flags: Record<string, CommandFlagValue> } {
  const promptTokens: string[] = [];
  const flags: Record<string, CommandFlagValue> = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    if (!token.startsWith("--") || token === "--") {
      promptTokens.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    const rawName = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    const name = normalizeFlagName(rawName);
    if (!name) {
      diagnostics.push({
        level: "warning",
        code: "empty_flag",
        message: "Command contains an empty flag name.",
        token
      });
      continue;
    }

    if (!KNOWN_FLAGS.has(name)) {
      diagnostics.push({
        level: "warning",
        code: "unknown_flag",
        message: `Unknown OpenTag command flag '--${name}'.`,
        token
      });
    }

    let value: CommandArgValue = true;
    if (equalsIndex >= 0) {
      value = parseFlagValue(withoutPrefix.slice(equalsIndex + 1));
    } else {
      const nextToken = tokens[index + 1];
      if (nextToken && !nextToken.startsWith("--")) {
        value = parseFlagValue(nextToken);
        index += 1;
      }
    }

    if (flags[name] !== undefined && SINGLE_VALUE_FLAGS.has(name)) {
      diagnostics.push({
        level: "warning",
        code: "duplicate_flag",
        message: `Flag '--${name}' was provided more than once; later consumers should treat the last value as authoritative.`,
        token
      });
    }
    appendFlagValue(flags, name, value);
  }

  return { prompt: promptTokens.join(" ").trim(), flags };
}

function normalizeFlagName(name: string): string {
  return name.trim().toLowerCase();
}

function parseFlagValue(value: string): CommandArgValue {
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  return trimmed;
}

function appendFlagValue(flags: Record<string, CommandFlagValue>, name: string, value: CommandArgValue): void {
  const existing = flags[name];
  if (existing === undefined) {
    flags[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    flags[name] = [existing, value];
  }
}

function argsFromParsed(prompt: string, flags: Record<string, CommandFlagValue>): OpenTagCommand["args"] {
  const args: OpenTagCommand["args"] = {};
  if (prompt.length > 0) {
    args.prompt = prompt;
  }

  for (const [name, value] of Object.entries(flags)) {
    args[name] = collapseArgValue(value);
  }

  return args;
}

function collapseArgValue(value: CommandFlagValue): CommandArgValue {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((entry) => String(entry)).join(",");
}

function referencesFromFlags(flags: Record<string, CommandFlagValue>, diagnostics: CommandParseDiagnostic[]): CommandReference[] {
  const references: CommandReference[] = [];
  const line = lineFromFlag(flags, diagnostics);
  const range = rangeFromFlag(flags, diagnostics);

  for (const uri of stringValuesForFlag(flags, "file")) {
    references.push(commandReference("file", uri, line, range));
  }
  for (const uri of stringValuesForFlag(flags, "path")) {
    references.push(commandReference("path", uri, line, range));
  }
  for (const uri of stringValuesForFlag(flags, "url")) {
    references.push(commandReference("url", uri, undefined, undefined));
  }

  if (references.length === 0 && line !== undefined) {
    references.push(commandReference("line", String(line), line, undefined));
  }
  if (references.length === 0 && range !== undefined) {
    references.push(commandReference("range", `${range.startLine}-${range.endLine}`, undefined, range));
  }

  return references;
}

function commandReference(
  kind: CommandReference["kind"],
  uri: string,
  line: number | undefined,
  range: { startLine: number; endLine: number } | undefined
): CommandReference {
  const reference: CommandReference = { kind, uri };
  if (line !== undefined) {
    reference.line = line;
  }
  if (range !== undefined) {
    reference.startLine = range.startLine;
    reference.endLine = range.endLine;
  }
  return reference;
}

function requestedScopesFromFlags(
  flags: Record<string, CommandFlagValue>,
  diagnostics: CommandParseDiagnostic[]
): PermissionGrant["scope"][] {
  const requestedScopes: PermissionGrant["scope"][] = [];

  for (const scope of stringValuesForFlag(flags, "scope")) {
    if (PERMISSION_SCOPES.has(scope as PermissionGrant["scope"])) {
      appendUnique(requestedScopes, scope as PermissionGrant["scope"]);
    } else {
      diagnostics.push({
        level: "warning",
        code: "invalid_scope",
        message: `Unsupported permission scope '${scope}'.`,
        token: scope
      });
    }
  }

  return requestedScopes;
}

function enumValueForFlag<T extends string>(
  flags: Record<string, CommandFlagValue>,
  name: string,
  allowed: Set<T>,
  diagnostics: CommandParseDiagnostic[]
): T | undefined {
  const value = stringValuesForFlag(flags, name).at(-1)?.toLowerCase();
  if (!value) return undefined;
  if (allowed.has(value as T)) {
    return value as T;
  }
  diagnostics.push({
    level: "warning",
    code: `invalid_${name}`,
    message: `Unsupported ${name} value '${value}'.`,
    token: value
  });
  return undefined;
}

function executorHintFromFlags(
  flags: Record<string, CommandFlagValue>,
  diagnostics: CommandParseDiagnostic[]
): AgentTarget["executorHint"] | undefined {
  const value = stringValuesForFlag(flags, "executor").at(-1)?.toLowerCase();
  if (!value) return undefined;
  if (EXECUTOR_HINTS.has(value as AgentTarget["executorHint"])) {
    return value as AgentTarget["executorHint"];
  }
  diagnostics.push({
    level: "warning",
    code: "invalid_executor",
    message: `Unsupported executor hint '${value}'.`,
    token: value
  });
  return undefined;
}

function lineFromFlag(flags: Record<string, CommandFlagValue>, diagnostics: CommandParseDiagnostic[]): number | undefined {
  const value = valuesForFlag(flags, "line").at(-1);
  if (value === undefined) return undefined;
  const line = typeof value === "number" ? value : Number(value);
  if (Number.isInteger(line) && line > 0) {
    return line;
  }
  diagnostics.push({
    level: "warning",
    code: "invalid_line",
    message: `Line must be a positive integer; received '${String(value)}'.`,
    token: String(value)
  });
  return undefined;
}

function rangeFromFlag(
  flags: Record<string, CommandFlagValue>,
  diagnostics: CommandParseDiagnostic[]
): { startLine: number; endLine: number } | undefined {
  const value = valuesForFlag(flags, "range").at(-1);
  if (value === undefined) return undefined;
  const match = String(value).match(/^(\d+)-(\d+)$/);
  if (!match?.[1] || !match[2]) {
    diagnostics.push({
      level: "warning",
      code: "invalid_range",
      message: `Range must look like '10-20'; received '${String(value)}'.`,
      token: String(value)
    });
    return undefined;
  }

  const startLine = Number(match[1]);
  const endLine = Number(match[2]);
  if (startLine > 0 && endLine >= startLine) {
    return { startLine, endLine };
  }

  diagnostics.push({
    level: "warning",
    code: "invalid_range",
    message: `Range start must be less than or equal to range end; received '${String(value)}'.`,
    token: String(value)
  });
  return undefined;
}

function stringValuesForFlag(flags: Record<string, CommandFlagValue>, name: string): string[] {
  return valuesForFlag(flags, name).map((value) => String(value)).filter((value) => value.length > 0);
}

function valuesForFlag(flags: Record<string, CommandFlagValue>, name: string): CommandArgValue[] {
  const value = flags[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function appendUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function isKnownIntent(value: string): value is KnownIntent {
  return INTENTS.includes(value as KnownIntent);
}
