#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_SCHEMA } from "../src/constants.mjs";
import { normalizeRuntimeConfig, runtimeHome, standardConfigPath } from "../src/config.mjs";
import { closedErrorCode, fail } from "../src/errors.mjs";
import { atomicWriteJson, writeNewJson } from "../src/safety.mjs";

export function parseConfigureArgs(argv, { env = process.env, cwd = process.cwd() } = {}) {
  if (!Array.isArray(argv)) throw new Error("argv must be an array");
  const workspaces = [];
  let providerMode = "mock";
  let configPath = standardConfigPath(env);
  let runtimeDir = path.join(runtimeHome(env), "runtime");
  let generationModel;
  let visionModel;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--force") { force = true; continue; }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) fail("CONFIG_INVALID", `${flag} requires a value`);
    index += 1;
    if (flag === "--workspace") {
      const equals = value.indexOf("=");
      const explicitId = equals > 0 && /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/.test(value.slice(0, equals));
      workspaces.push({ id: explicitId ? value.slice(0, equals) : null, root: explicitId ? value.slice(equals + 1) : value });
    } else if (flag === "--provider") providerMode = value;
    else if (flag === "--config") configPath = value;
    else if (flag === "--runtime-dir") runtimeDir = value;
    else if (flag === "--image-model") generationModel = value;
    else if (flag === "--vision-model") visionModel = value;
    else fail("CONFIG_INVALID", "unknown configure argument");
  }
  if (workspaces.length === 0) fail("CONFIG_INVALID", "at least one --workspace is required");
  workspaces.forEach((workspace, index) => {
    workspace.id ??= index === 0 ? "workspace" : `workspace-${index + 1}`;
    workspace.root = path.resolve(cwd, workspace.root);
  });
  if (!path.isAbsolute(configPath) || !path.isAbsolute(runtimeDir)) fail("CONFIG_INVALID", "config and runtime paths must be absolute");
  if (!new Set(["mock", "openai"]).has(providerMode)) fail("CONFIG_INVALID", "provider must be mock or openai");
  const defaults = providerMode === "openai"
    ? { generation_model: "gpt-image-2", vision_model: "gpt-5.6" }
    : { generation_model: "mock-image-v1", vision_model: "mock-vision-v1" };
  return {
    configPath: path.resolve(configPath),
    force,
    config: {
      schema: CONFIG_SCHEMA,
      runtime_dir: path.resolve(runtimeDir),
      provider: {
        mode: providerMode,
        generation_model: generationModel ?? defaults.generation_model,
        vision_model: visionModel ?? defaults.vision_model
      },
      workspaces
    }
  };
}

export function configureHelp() {
  return `Codex Image Context Runtime configuration\n\nUsage:\n  node scripts/configure.mjs --workspace <path> [options]\n\nOptions:\n  --workspace <[id=]path>  Bind one workspace; repeat for multiple roots. Relative paths resolve from the current directory.\n  --provider <mock|openai> Provider mode (default: mock).\n  --runtime-dir <path>     Absolute durable Runtime directory.\n  --config <path>          Absolute configuration file path.\n  --image-model <name>     OpenAI image model override.\n  --vision-model <name>    OpenAI vision model override.\n  --force                  Replace an existing configuration.\n  --help                   Show this help.\n`;
}

export async function configure(argv = process.argv.slice(2), options = {}) {
  const parsed = parseConfigureArgs(argv, options);
  const normalized = await normalizeRuntimeConfig(parsed.config);
  const persisted = {
    schema: normalized.schema,
    runtime_dir: normalized.runtime_dir,
    provider: { ...normalized.provider },
    workspaces: normalized.workspaces.map((workspace) => ({ id: workspace.id, root: workspace.root }))
  };
  if (parsed.force) {
    await atomicWriteJson(parsed.configPath, persisted);
  } else {
    try {
      await writeNewJson(parsed.configPath, persisted);
    } catch (error) {
      if (error?.code === "EEXIST") fail("CONFIG_EXISTS", "configuration already exists; pass --force to replace it");
      throw error;
    }
  }
  return { status: "configured", config_path: parsed.configPath, provider: normalized.provider.mode, workspace_ids: normalized.workspaces.map((workspace) => workspace.id) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(configureHelp());
  } else configure().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "failed", error: closedErrorCode(error, "CONFIGURE_FAILED") })}\n`);
    process.exitCode = 1;
  });
}
