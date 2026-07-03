#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultPaths = ["packages/dispatcher/test/fixtures/replay", ".omx/live-e2e", ".omx/governance-matrix"];
const scannedExtensions = new Set([".json", ".md", ".txt", ".log"]);
const localAbsolutePathRegex =
  /(?:\/Users\/[A-Za-z0-9._-]+\/(?:repos|Library|Desktop|Downloads|\.config)\/[^\s"',)]+|\/(?:home|root)\/[A-Za-z0-9._-]+\/[^\s"',)]+|[A-Za-z]:\\Users\\[^\s"',)]+)/g;

const patterns = [
  {
    id: "github_token",
    description: "GitHub token-like value",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g
  },
  {
    id: "gitlab_token",
    description: "GitLab token-like value",
    regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g
  },
  {
    id: "slack_token",
    description: "Slack token-like value",
    regex: /\bx(?:ox[baprs]|app)-[A-Za-z0-9-]{20,}\b/g
  },
  {
    id: "private_key",
    description: "private key material",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
  },
  {
    id: "secret_field",
    description: "raw secret field value",
    regex: /"(?:authorization|PRIVATE-TOKEN|private[_-]?token|token|secret|webhookSecret|botToken|appSecret|privateKey)"\s*:\s*"[^"]{8,}"/gi
  },
  {
    id: "local_absolute_path",
    description: "local absolute path",
    regex: localAbsolutePathRegex
  },
  {
    id: "lark_message_id",
    description: "full Lark message id",
    regex: /\bom_[A-Za-z0-9]{20,}\b/g
  }
];

function usage() {
  return [
    "Usage: node scripts/test/privacy-redaction-scan.mjs [options]",
    "",
    "Options:",
    "  --path <path>       File or directory to scan. Repeatable.",
    "  --allow-missing     Skip missing paths instead of failing.",
    "  --report <path>     Write a JSON report.",
    "  --json              Print JSON instead of text.",
    "  --help              Show this help.",
    "",
    "Default paths:",
    ...defaultPaths.map((path) => `  ${path}`)
  ].join("\n");
}

function parseArgs(argv) {
  const paths = [];
  const options = { allowMissing: false, json: false, reportPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--allow-missing") {
      options.allowMissing = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--path") {
      const value = argv[index + 1];
      if (!value) throw new Error("--path requires a value.");
      paths.push(value);
      index += 1;
      continue;
    }
    if (arg === "--report") {
      const value = argv[index + 1];
      if (!value) throw new Error("--report requires a value.");
      options.reportPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return { ...options, paths: paths.length > 0 ? paths : defaultPaths };
}

function collectFiles(path, missing) {
  const absolute = resolve(rootDir, path);
  if (!existsSync(absolute)) {
    missing.push(path);
    return [];
  }

  const stats = statSync(absolute);
  if (stats.isFile()) {
    return scannedExtensions.has(extname(absolute)) ? [absolute] : [];
  }
  if (!stats.isDirectory()) return [];

  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = resolve(absolute, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(relative(rootDir, child), missing));
      continue;
    }
    if (entry.isFile() && scannedExtensions.has(extname(entry.name))) {
      files.push(child);
    }
  }
  return files;
}

function lineForIndex(content, index) {
  return content.slice(0, index).split("\n").length;
}

function isAllowedMatch(finding) {
  if (finding.patternId !== "local_absolute_path") return false;
  return (
    finding.match.includes("/Users/test/") ||
    finding.match.includes("/Users/example/") ||
    finding.match.includes("/home/test/") ||
    finding.match.includes("/home/example/") ||
    finding.match.includes("C:\\Users\\test\\") ||
    finding.match.includes("C:\\Users\\example\\")
  );
}

function redactExcerpt(value) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/-{0,5}BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[redacted-private-key]")
    .replace(/^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}\b/g, "[redacted-github-token]")
    .replace(/\bglpat-[A-Za-z0-9_-]{8,}\b/g, "[redacted-gitlab-token]")
    .replace(/\bx(?:ox[baprs]|app)-[A-Za-z0-9-]{8,}\b/g, "[redacted-slack-token]")
    .replace(/"(?:authorization|PRIVATE-TOKEN|private[_-]?token|token|secret|webhookSecret|botToken|appSecret|privateKey)"\s*:\s*"[^"]+"/gi, "\"[redacted-secret-field]\"")
    .replace(localAbsolutePathRegex, "[redacted-local-path]")
    .replace(/\bom_[A-Za-z0-9]{20,}\b/g, "[redacted-lark-message-id]");
}

function collectPrivateKeyRanges(content) {
  const ranges = [];
  const regex = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
  for (const match of content.matchAll(regex)) {
    const index = match.index ?? 0;
    ranges.push({ start: index, end: index + match[0].length });
  }
  return ranges;
}

function excerptForRange(content, start, end, privateKeyRanges) {
  const chunks = [];
  let cursor = start;
  for (const range of privateKeyRanges) {
    if (range.end <= start) continue;
    if (range.start >= end) break;
    const plainEnd = Math.min(range.start, end);
    if (cursor < plainEnd) chunks.push(content.slice(cursor, plainEnd));
    chunks.push("[redacted-private-key]");
    cursor = Math.max(cursor, Math.min(range.end, end));
  }
  if (cursor < end) chunks.push(content.slice(cursor, end));
  return redactExcerpt(chunks.join("").replace(/\s+/g, " ").trim());
}

function scanFile(file) {
  const content = readFileSync(file, "utf8");
  const privateKeyRanges = collectPrivateKeyRanges(content);
  const findings = [];
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (const match of content.matchAll(pattern.regex)) {
      const matched = match[0];
      const index = match.index ?? 0;
      const start = Math.max(0, index - 80);
      const end = Math.min(content.length, index + matched.length + 80);
      const finding = {
        file: relative(rootDir, file),
        line: lineForIndex(content, index),
        patternId: pattern.id,
        description: pattern.description,
        match: matched,
        excerpt: excerptForRange(content, start, end, privateKeyRanges)
      };
      if (!isAllowedMatch(finding)) findings.push(finding);
    }
  }
  return findings.map(({ match: _match, ...finding }) => finding);
}

function renderText(report) {
  const lines = [
    `Privacy redaction scan: ${report.scannedFiles.length} file(s)`,
    `Started: ${report.startedAt}`,
    ""
  ];
  if (report.missingPaths.length > 0) {
    lines.push(`Missing paths: ${report.missingPaths.join(", ")}`, "");
  }
  if (report.findings.length === 0) {
    lines.push("PASS no token, secret, private key, local path, or full Lark message id patterns found.");
    return lines.join("\n");
  }
  lines.push(`FAIL ${report.findings.length} finding(s):`);
  for (const finding of report.findings) {
    lines.push(`- ${finding.file}:${finding.line} ${finding.patternId} ${finding.excerpt}`);
  }
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const missingPaths = [];
  const scannedFiles = [...new Set(options.paths.flatMap((path) => collectFiles(path, missingPaths)))].sort();
  if (missingPaths.length > 0 && !options.allowMissing) {
    throw new Error(`Missing scan path(s): ${missingPaths.join(", ")}`);
  }
  const report = {
    startedAt: new Date().toISOString(),
    paths: options.paths,
    missingPaths,
    scannedFiles: scannedFiles.map((file) => relative(rootDir, file)),
    findings: scannedFiles.flatMap(scanFile)
  };
  report.ok = report.findings.length === 0;
  report.completedAt = new Date().toISOString();

  if (options.reportPath) {
    const outputPath = resolve(rootDir, options.reportPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderText(report));
  }

  if (!report.ok) process.exitCode = 1;
}

main();
