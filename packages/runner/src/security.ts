import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import type { ContextPointer, OpenTagCommand, PermissionGrant } from "@opentag/core";
import type { CommandEnvironment } from "./command.js";

export type RunnerSecurityMode = "enforce" | "audit" | "off";

export type RunnerSecurityPolicy = {
  mode?: RunnerSecurityMode;
  allowedWorkspaceRoot?: string;
  allowUnsafePrompts?: boolean;
  extraSafeEnv?: string[];
};

export type RunnerSecurityFinding = {
  code: string;
  severity: "block" | "warn";
  message: string;
};

export type RunnerSecurityAssessment = {
  allowed: boolean;
  mode: RunnerSecurityMode;
  findings: RunnerSecurityFinding[];
};

export const DEFAULT_SAFE_ENV_NAMES = [
  "CI",
  "COLORTERM",
  "CODEX_HOME",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PWD",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "TMP",
  "TMPDIR",
  "TEMP",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME"
];

const SAFE_ENV_PREFIXES = ["LC_"];

const SENSITIVE_ENV_PATTERNS = [
  /TOKEN/,
  /SECRET/,
  /PASSWORD/,
  /PASS$/,
  /API[_-]?KEY/,
  /CREDENTIAL/,
  /COOKIE/,
  /SESSION/,
  /AUTH/,
  /^AWS_/,
  /^AZURE_/,
  /^GCP_/,
  /^GOOGLE_/,
  /^OPENAI_/,
  /^ANTHROPIC_/,
  /^SLACK_/,
  /^GITHUB_TOKEN$/,
  /^GH_TOKEN$/,
  /^SSH_/
];

const HIGH_RISK_TEXT_PATTERNS: Array<{ code: string; pattern: RegExp; message: string }> = [
  {
    code: "prompt.instruction_override",
    pattern: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|system|developer|safety)\s+instructions\b/i,
    message: "Request contains an instruction override pattern commonly used in prompt injection."
  },
  {
    code: "prompt.secret_exfiltration",
    pattern:
      /\b(print|dump|show|reveal|exfiltrate|send|upload|post|copy)\b[\s\S]{0,100}\b(secret|token|password|api[\s_-]?key|credential|environment variables?|env vars?)\b/i,
    message: "Request appears to ask the runner to expose secrets or environment variables."
  },
  {
    code: "prompt.sensitive_file_access",
    pattern: /\b(cat|open|read|print|dump)\b[\s\S]{0,80}(~\/\.ssh|~\/\.aws|\.env\b|id_rsa|known_hosts|credentials\b)/i,
    message: "Request appears to ask the runner to read sensitive local credential files."
  }
];

function securityMode(policy: RunnerSecurityPolicy | undefined): RunnerSecurityMode {
  return policy?.mode ?? "enforce";
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const child = resolve(childPath);
  const parent = resolve(parentPath);
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function fileContextPath(pointer: ContextPointer, workspacePath: string): string | null {
  if (pointer.kind !== "file") return null;
  if (pointer.uri.startsWith("file://")) {
    return fileURLToPath(pointer.uri);
  }
  if (isAbsolute(pointer.uri)) {
    return pointer.uri;
  }
  return resolve(workspacePath, pointer.uri);
}

function hasPermission(permissions: PermissionGrant[] | undefined, scope: string): boolean {
  return permissions?.some((permission) => permission.scope === scope) ?? false;
}

function needsWritePermission(command: OpenTagCommand, executorId: string, workspaceKind: "repository" | "scratch"): boolean {
  if (workspaceKind === "scratch") return false;
  if (executorId === "echo") return false;
  return command.intent === "fix" || command.intent === "run";
}

function scanTextForHighRiskPatterns(input: { command: OpenTagCommand; context: ContextPointer[] }): RunnerSecurityFinding[] {
  const sources = [
    { label: "command", text: input.command.rawText },
    ...input.context
      .filter((pointer) => pointer.kind === "text")
      .map((pointer) => ({ label: pointer.title ?? "text context", text: pointer.uri }))
  ];

  const findings: RunnerSecurityFinding[] = [];
  for (const source of sources) {
    for (const rule of HIGH_RISK_TEXT_PATTERNS) {
      if (rule.pattern.test(source.text)) {
        findings.push({
          code: rule.code,
          severity: "block",
          message: `${rule.message} Source: ${source.label}.`
        });
      }
    }
  }
  return findings;
}

export function assessRunnerSecurity(input: {
  executorId: string;
  workspaceKind?: "repository" | "scratch";
  workspacePath: string;
  executionPath?: string;
  command: OpenTagCommand;
  context: ContextPointer[];
  permissions?: PermissionGrant[];
  policy?: RunnerSecurityPolicy;
}): RunnerSecurityAssessment {
  const mode = securityMode(input.policy);
  if (mode === "off") {
    return { allowed: true, mode, findings: [] };
  }

  const findings: RunnerSecurityFinding[] = [];
  if (!isAbsolute(input.workspacePath)) {
    findings.push({
      code: "workspace.relative_path",
      severity: "block",
      message: "Workspace path must be absolute before a local executor can run."
    });
  }

  const workspacePath = resolve(input.workspacePath);
  const executionPath = resolve(input.executionPath ?? input.workspacePath);
  if (input.policy?.allowedWorkspaceRoot && !isPathInside(workspacePath, input.policy.allowedWorkspaceRoot)) {
    findings.push({
      code: "workspace.outside_allowed_root",
      severity: "block",
      message: "Workspace path is outside the configured allowed workspace root."
    });
  }
  if (input.policy?.allowedWorkspaceRoot && !isPathInside(executionPath, input.policy.allowedWorkspaceRoot)) {
    findings.push({
      code: "execution.outside_allowed_root",
      severity: "block",
      message: "Execution path is outside the configured allowed workspace root."
    });
  }

  for (const pointer of input.context) {
    const filePath = fileContextPath(pointer, workspacePath);
    if (filePath && !isPathInside(filePath, workspacePath)) {
      findings.push({
        code: "context.file_outside_workspace",
        severity: "block",
        message: `File context is outside the mapped workspace: ${pointer.uri}`
      });
    }
  }

  if (needsWritePermission(input.command, input.executorId, input.workspaceKind ?? "repository") && !hasPermission(input.permissions, "repo:write")) {
    findings.push({
      code: "permission.repo_write_required",
      severity: "block",
      message: "Write-capable commands require an explicit repo:write permission grant."
    });
  }

  if (!input.policy?.allowUnsafePrompts) {
    findings.push(...scanTextForHighRiskPatterns({ command: input.command, context: input.context }));
  }

  const hasBlockingFinding = findings.some((finding) => finding.severity === "block");
  return {
    allowed: mode === "audit" || !hasBlockingFinding,
    mode,
    findings
  };
}

function isSensitiveEnvName(name: string): boolean {
  const upperName = name.toUpperCase();
  return SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(upperName));
}

function isSafeEnvName(name: string, policy: RunnerSecurityPolicy | undefined): boolean {
  const upperName = name.toUpperCase();
  const safeNames = new Set([...DEFAULT_SAFE_ENV_NAMES, ...(policy?.extraSafeEnv ?? [])].map((envName) => envName.toUpperCase()));
  return safeNames.has(upperName) || SAFE_ENV_PREFIXES.some((prefix) => upperName.startsWith(prefix));
}

export function scrubEnvironment(env: CommandEnvironment = process.env, policy?: RunnerSecurityPolicy): CommandEnvironment {
  if (securityMode(policy) === "off") return { ...env };

  const scrubbed: CommandEnvironment = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (isSensitiveEnvName(name)) continue;
    if (!isSafeEnvName(name, policy)) continue;
    scrubbed[name] = value;
  }
  return scrubbed;
}

export function formatSecurityAssessment(assessment: RunnerSecurityAssessment): string {
  if (assessment.findings.length === 0) {
    return `OpenTag runner security assessment passed in ${assessment.mode} mode.`;
  }

  const prefix = assessment.allowed
    ? `OpenTag runner security assessment reported ${assessment.findings.length} finding(s) in ${assessment.mode} mode.`
    : "OpenTag runner security blocked this run.";
  const details = assessment.findings.map((finding) => `${finding.code}: ${finding.message}`).join(" ");
  return `${prefix} ${details}`;
}
