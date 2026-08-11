#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Public binary assets are accepted only after manual review and only at their
// exact audited digest. Any new or modified binary must be reviewed explicitly.
const REVIEWED_BINARY_SHA256 = new Map([
  ["docs/assets/image-context-runtime-workstation-comparison.png", "f722296aaa4c7de062bd82def947a53c9c7ddc732b9c3a6c25a3f9723960ee37"]
]);

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "coverage",
  ".nyc_output",
  ".cache",
  "reports",
  "dist",
  "build",
  "out"
]);

const CONTENT_PATTERNS = [
  ["email-address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  ["windows-user-directory", /\b[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'<>]+/gi],
  ["unix-user-directory", /(?:^|[\s"'=])\/(?:Users|home)\/[^/\s"'<>]+/gim],
  ["unc-path", /\\\\[^\\/\s"'<>]+[\\/][^\\/\s"'<>]+/g],
  ["credential-in-url", /https?:\/\/[^/\s:@]+:[^@\s/]+@/gi],
  ["database-credential-url", /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/\S+/gi],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["provider-secret", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  [
    "assigned-secret",
    /\b(?:(?:api|access)[_-]?key|client[_-]?secret|password|bearer[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_./+=:-]{8,}/gi
  ]
];

const SAFE_GIT_EMAIL = /^(?:(?:\d+\+)?[A-Za-z0-9_.+\[\]-]+@users\.noreply\.github\.com|noreply@github\.com)$/i;

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function addFinding(findings, kind, file, line = 1) {
  const key = `${kind}\0${file}\0${line}`;
  if (!findings.some((finding) => finding.key === key)) findings.push({ key, kind, file, line });
}

export function scanText(text, file = "<text>") {
  const findings = [];
  for (const [kind, pattern] of CONTENT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) addFinding(findings, kind, file, lineNumberAt(text, match.index ?? 0));
  }

  return findings.map(({ key: _key, ...finding }) => finding);
}

async function collectFiles(root) {
  const files = [];
  const findings = [];

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stats = await fs.lstat(absolute);
      if (stats.isSymbolicLink()) {
        addFinding(findings, "symlink-not-allowed", relative);
        continue;
      }
      if (stats.isDirectory()) await visit(absolute);
      else if (stats.isFile()) files.push({ absolute, relative, size: stats.size });
    }
  }

  await visit(root);
  return { files, findings };
}

export async function scanPublicTree(root = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(root);
  const { files, findings } = await collectFiles(resolvedRoot);
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (const file of files) {
    for (const finding of scanText(file.relative, `<path:${file.relative}>`)) {
      addFinding(findings, finding.kind, finding.file, finding.line);
    }
    if (file.size > MAX_FILE_BYTES) {
      addFinding(findings, "file-too-large", file.relative);
      continue;
    }

    const bytes = await fs.readFile(file.absolute);
    const reviewedDigest = REVIEWED_BINARY_SHA256.get(file.relative);
    if (reviewedDigest) {
      const actualDigest = createHash("sha256").update(bytes).digest("hex");
      if (actualDigest !== reviewedDigest) addFinding(findings, "reviewed-binary-hash-mismatch", file.relative);
      continue;
    }
    if (bytes.includes(0)) {
      addFinding(findings, "binary-review-required", file.relative);
      continue;
    }

    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      addFinding(findings, "non-utf8-file", file.relative);
      continue;
    }
    if (text.startsWith("\uFEFF")) addFinding(findings, "utf8-bom", file.relative);
    for (const finding of scanText(text, file.relative)) addFinding(findings, finding.kind, finding.file, finding.line);
  }

  return findings.map(({ key: _key, ...finding }) => finding);
}

function gitOutput(root, args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function isGitRepository(root) {
  try {
    return gitOutput(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

export function scanGitMetadata(root = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(root);
  if (!isGitRepository(resolvedRoot)) return [];
  const findings = [];

  let identities = "";
  try {
    identities = gitOutput(resolvedRoot, ["log", "--all", "--format=%H%x09%an%x09%ae%x09%cn%x09%ce"]);
  } catch {
    identities = "";
  }
  for (const row of identities.split(/\r?\n/).filter(Boolean)) {
    const [commit = "<unknown>", authorName = "", authorEmail = "", committerName = "", committerEmail = ""] = row.split("\t");
    if (authorEmail && !SAFE_GIT_EMAIL.test(authorEmail)) addFinding(findings, "git-author-email", `<git:${commit}>`);
    if (committerEmail && !SAFE_GIT_EMAIL.test(committerEmail)) addFinding(findings, "git-committer-email", `<git:${commit}>`);
  }

  try {
    const tags = gitOutput(resolvedRoot, ["for-each-ref", "refs/tags", "--format=%(refname)%09%(taggername)%09%(taggeremail)"]);
    for (const row of tags.split(/\r?\n/).filter(Boolean)) {
      const [, taggerName = "", taggerEmail = ""] = row.split("\t");
      const email = taggerEmail.replace(/^<|>$/g, "");
      if (email && !SAFE_GIT_EMAIL.test(email)) addFinding(findings, "git-tagger-email", "<git-tags>");
    }
    const tagMessages = gitOutput(resolvedRoot, ["for-each-ref", "refs/tags", "--format=%(contents)"]);
    for (const finding of scanText(tagMessages, "<git-tag-messages>")) addFinding(findings, finding.kind, finding.file, finding.line);
  } catch {
    // An unborn repository has no refs to inspect.
  }

  try {
    const messages = gitOutput(resolvedRoot, ["log", "--all", "--format=%B"]);
    for (const finding of scanText(messages, "<git-messages>")) addFinding(findings, finding.kind, finding.file, finding.line);
  } catch {
    // An unborn repository has no commit messages.
  }

  try {
    const remotes = gitOutput(resolvedRoot, ["remote", "-v"]);
    for (const finding of scanText(remotes, "<git-remotes>")) addFinding(findings, finding.kind, finding.file, finding.line);
  } catch {
    // A local-only repository may not have a remote.
  }

  try {
    const fsck = gitOutput(resolvedRoot, ["fsck", "--full", "--unreachable", "--no-reflogs"]);
    if (/\b(?:unreachable|dangling)\b/i.test(fsck)) addFinding(findings, "unreachable-git-object", "<git-objects>");
  } catch {
    addFinding(findings, "git-fsck-failed", "<git-objects>");
  }

  return findings.map(({ key: _key, ...finding }) => finding);
}

export async function scanRepository(root = DEFAULT_ROOT) {
  const findings = await scanPublicTree(root);
  for (const finding of scanGitMetadata(root)) {
    if (!findings.some((existing) => existing.kind === finding.kind && existing.file === finding.file && existing.line === finding.line)) {
      findings.push(finding);
    }
  }
  return findings;
}

async function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT;
  const findings = await scanRepository(root);
  if (findings.length > 0) {
    console.error(`Public-tree audit failed with ${findings.length} finding(s):`);
    for (const finding of findings) console.error(`- ${finding.kind}: ${finding.file}:${finding.line}`);
    process.exitCode = 1;
    return;
  }
  console.log("Public-tree audit passed: no personal paths, email addresses, secret shapes, or unreviewed binary files found.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`Public-tree audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
