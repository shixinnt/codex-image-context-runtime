#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRuntimeConfig } from "../src/config.mjs";
import { closedErrorCode, fail } from "../src/errors.mjs";
import { ImageContextRuntime } from "../src/runtime.mjs";

export function parseCompactArgs(argv, { cwd = process.cwd() } = {}) {
  let configPath;
  let olderThanDays = 30;
  let limit = 25;
  let dryRun = true;
  let json = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") { dryRun = false; continue; }
    if (flag === "--json") { json = true; continue; }
    if (flag === "--help") { help = true; continue; }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) fail("COMPACT_ARGUMENT_INVALID", `${flag} requires a value`);
    index += 1;
    if (flag === "--config") configPath = path.resolve(cwd, value);
    else if (flag === "--older-than-days") olderThanDays = Number(value);
    else if (flag === "--limit") limit = Number(value);
    else fail("COMPACT_ARGUMENT_INVALID", "unknown compaction argument");
  }
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0 || olderThanDays > 36_500) fail("COMPACT_ARGUMENT_INVALID", "--older-than-days must be between 0 and 36500");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("COMPACT_ARGUMENT_INVALID", "--limit must be between 1 and 100");
  return { configPath, olderThanDays, limit, dryRun, json, help };
}

export function compactHelp() {
  return `Codex Image Context Runtime compaction\n\nUsage:\n  node scripts/compact.mjs [--config <path>] [--older-than-days <days>] [--limit <count>] [--apply] [--json]\n\nThe default is a dry run. Stop Codex and the shared broker before applying compaction. Only completed or cancelled Job bodies are replaced with privacy-minimized tombstones. Idempotency bindings and compact artifact receipts are retained; secure erasure is not guaranteed.\n`;
}

export async function compact(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env, provider } = {}) {
  const args = parseCompactArgs(argv, { cwd });
  if (args.help) return { help: true, json: args.json };
  const config = await loadRuntimeConfig({ configPath: args.configPath, env });
  const runtime = new ImageContextRuntime(config, { provider });
  try {
    return await runtime.compactJobs({ olderThanDays: args.olderThanDays, limit: args.limit, dryRun: args.dryRun });
  } finally {
    await runtime.close().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) process.stdout.write(compactHelp());
  else compact(argv).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "failed", error: closedErrorCode(error, "COMPACTION_FAILED") })}\n`);
    process.exitCode = 1;
  });
}
