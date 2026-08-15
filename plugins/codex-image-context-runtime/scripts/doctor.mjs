#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfig, safeConfigSummary } from "../src/config.mjs";
import { VERSION } from "../src/constants.mjs";
import { closedErrorCode, fail } from "../src/errors.mjs";

function parseArgs(argv, { cwd = process.cwd() } = {}) {
  let configPath;
  let json = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") { json = true; continue; }
    if (flag === "--help") { help = true; continue; }
    if (flag !== "--config") fail("DOCTOR_ARGUMENT_INVALID", "unknown doctor argument");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) fail("DOCTOR_ARGUMENT_INVALID", "--config requires a value");
    configPath = path.resolve(cwd, value);
    index += 1;
  }
  return { configPath, help, json };
}

async function entryKind(filePath) {
  try {
    const entry = await fs.lstat(filePath);
    return entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    return "unavailable";
  }
}

function nodeMajor(version = process.versions.node) {
  const value = Number.parseInt(String(version).split(".")[0], 10);
  return Number.isInteger(value) ? value : 0;
}

export async function diagnose(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env } = {}) {
  const args = parseArgs(argv, { cwd });
  if (args.help) return { help: true, json: args.json };
  const config = await loadRuntimeConfig({ configPath: args.configPath, env });
  const summary = safeConfigSummary(config);
  const warnings = [];
  const runtimeLock = await entryKind(path.join(config.runtime_dir, "runtime.lock"));
  const acquisitionGuard = await entryKind(path.join(config.runtime_dir, "runtime.lock.guard"));
  const apiKeyRequired = summary.provider_mode === "openai";
  const apiKeyPresent = typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length >= 8;
  if (nodeMajor() < 22) warnings.push("node_version_unsupported");
  if (apiKeyRequired && !apiKeyPresent) warnings.push("openai_api_key_missing");
  if (runtimeLock !== "absent") warnings.push("runtime_lock_present");
  if (acquisitionGuard !== "absent") warnings.push("runtime_lock_guard_present");
  return {
    schema: "codex-image-context-doctor-v1",
    status: warnings.length === 0 ? "ok" : "warning",
    version: VERSION,
    node_version: process.versions.node,
    provider: summary.provider_mode,
    generation_model: summary.generation_model,
    vision_model: summary.vision_model,
    workspace_ids: summary.workspace_ids,
    credential: apiKeyRequired ? (apiKeyPresent ? "available" : "missing") : "not_required",
    runtime_lock: runtimeLock,
    acquisition_guard: acquisitionGuard,
    warnings
  };
}

export function doctorHelp() {
  return `Codex Image Context Runtime doctor\n\nUsage:\n  node scripts/doctor.mjs [--config <path>] [--json]\n\nThe report never prints workspace paths, Runtime paths, credentials, prompts, or media.\n`;
}

export function renderDoctor(result, { json = false } = {}) {
  if (result.help) return doctorHelp();
  if (json) return `${JSON.stringify(result)}\n`;
  const lines = [
    `Codex Image Context Runtime doctor ${result.version}`,
    `Status: ${result.status}`,
    `Node: ${result.node_version}`,
    `Provider: ${result.provider}`,
    `Models: ${result.generation_model} / ${result.vision_model}`,
    `Workspaces: ${result.workspace_ids.join(", ")}`,
    `Credential: ${result.credential}`,
    `Runtime lock: ${result.runtime_lock}`,
    `Acquisition guard: ${result.acquisition_guard}`
  ];
  if (result.warnings.length > 0) lines.push(`Warnings: ${result.warnings.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  diagnose(argv).then((result) => process.stdout.write(renderDoctor(result, { json: argv.includes("--json") }))).catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "failed", error: closedErrorCode(error, "DOCTOR_FAILED") })}\n`);
    process.exitCode = 1;
  });
}
