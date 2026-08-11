import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_SCHEMA } from "./constants.mjs";
import { assertExactKeys, assertSafeId, assertBoundedText, canonicalJson, isInsideOrEqual, readJsonFileBounded, sha256 } from "./safety.mjs";
import { fail } from "./errors.mjs";

function absoluteEnvPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) fail("CONFIG_INVALID", `${label} must be absolute`);
  return path.resolve(value);
}

export function runtimeHome(env = process.env) {
  if (env.CODEX_IMAGE_CONTEXT_HOME) return absoluteEnvPath(env.CODEX_IMAGE_CONTEXT_HOME, "CODEX_IMAGE_CONTEXT_HOME");
  if (env.PLUGIN_DATA) return absoluteEnvPath(env.PLUGIN_DATA, "PLUGIN_DATA");
  if (env.CLAUDE_PLUGIN_DATA) return absoluteEnvPath(env.CLAUDE_PLUGIN_DATA, "CLAUDE_PLUGIN_DATA");
  if (process.platform === "win32") return path.join(env.LOCALAPPDATA || os.homedir(), "codex-image-context-runtime");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "codex-image-context-runtime");
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "codex-image-context-runtime");
}

export function configHome(env = process.env) {
  if (process.platform === "win32") return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "codex-image-context-runtime");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "codex-image-context-runtime");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "codex-image-context-runtime");
}

export function standardConfigPath(env = process.env) {
  return path.join(configHome(env), "config.json");
}

function parseWorkspaceRoots(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const roots = raw.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
    if (roots.length === 0) fail("CONFIG_INVALID", "CODEX_IMAGE_CONTEXT_ROOTS is invalid");
    return roots.map((root, index) => ({ id: index === 0 ? "workspace" : `workspace-${index + 1}`, root }));
  }
  if (Array.isArray(parsed)) {
    return parsed.map((item, index) => typeof item === "string"
      ? { id: index === 0 ? "workspace" : `workspace-${index + 1}`, root: item }
      : item);
  }
  if (parsed && typeof parsed === "object") return Object.entries(parsed).map(([id, root]) => ({ id, root }));
  fail("CONFIG_INVALID", "CODEX_IMAGE_CONTEXT_ROOTS is invalid");
}

function safeModel(value, label) {
  assertBoundedText(value, label, { min: 1, max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail("CONFIG_INVALID", `${label} is invalid`);
  return value;
}

function providerDefaults(mode) {
  return mode === "openai"
    ? { mode, generation_model: "gpt-image-2", vision_model: "gpt-5.6" }
    : { mode: "mock", generation_model: "mock-image-v1", vision_model: "mock-vision-v1" };
}

function withEnvironmentOverrides(value, env, home) {
  const roots = parseWorkspaceRoots(env.CODEX_IMAGE_CONTEXT_ROOTS);
  const configuredMode = env.CODEX_IMAGE_CONTEXT_PROVIDER ?? value?.provider?.mode ?? "mock";
  if (!new Set(["mock", "openai"]).has(configuredMode)) fail("CONFIG_INVALID", "provider mode is unsupported");
  const defaults = providerDefaults(configuredMode);
  const provider = {
    mode: configuredMode,
    generation_model: env.CODEX_IMAGE_CONTEXT_IMAGE_MODEL ?? (value?.provider?.mode === configuredMode ? value.provider.generation_model : defaults.generation_model),
    vision_model: env.CODEX_IMAGE_CONTEXT_VISION_MODEL ?? (value?.provider?.mode === configuredMode ? value.provider.vision_model : defaults.vision_model)
  };
  return {
    schema: value?.schema ?? CONFIG_SCHEMA,
    runtime_dir: value?.runtime_dir ?? path.join(home, "runtime"),
    provider,
    workspaces: roots ?? value?.workspaces
  };
}

function validateProvider(value) {
  assertExactKeys(value, { required: ["mode", "generation_model", "vision_model"] }, "provider config");
  if (!new Set(["mock", "openai"]).has(value.mode)) fail("CONFIG_INVALID", "provider mode is unsupported");
  if (value.mode === "mock") {
    if (value.generation_model !== "mock-image-v1" || value.vision_model !== "mock-vision-v1") fail("CONFIG_INVALID", "mock model binding is fixed");
  } else {
    safeModel(value.generation_model, "generation model");
    safeModel(value.vision_model, "vision model");
  }
  return Object.freeze({ ...value });
}

export async function normalizeRuntimeConfig(value) {
  assertExactKeys(value, { required: ["schema", "runtime_dir", "provider", "workspaces"] }, "runtime config");
  if (value.schema !== CONFIG_SCHEMA) fail("CONFIG_INVALID", "runtime config schema is unsupported");
  if (typeof value.runtime_dir !== "string" || !path.isAbsolute(value.runtime_dir)) fail("CONFIG_INVALID", "runtime_dir must be absolute");
  if (!Array.isArray(value.workspaces) || value.workspaces.length < 1 || value.workspaces.length > 8) fail("CONFIG_INVALID", "workspaces must contain one to eight fixed roots");

  const provider = validateProvider(value.provider);
  const ids = new Set();
  const workspaces = [];
  for (const workspace of value.workspaces) {
    assertExactKeys(workspace, { required: ["id", "root"] }, "workspace binding");
    const id = assertSafeId(workspace.id, "workspace id");
    if (ids.has(id)) fail("CONFIG_INVALID", "workspace ids must be unique");
    ids.add(id);
    if (typeof workspace.root !== "string" || !path.isAbsolute(workspace.root)) fail("CONFIG_INVALID", "workspace root must be absolute");
    let root;
    try {
      root = await fs.realpath(workspace.root);
      if (!(await fs.stat(root)).isDirectory()) fail("CONFIG_INVALID", "workspace root must be a directory");
    } catch (error) {
      if (error?.code === "CONFIG_INVALID") throw error;
      fail("CONFIG_INVALID", "workspace root is unavailable");
    }
    workspaces.push(Object.freeze({ id, root: path.resolve(root) }));
  }

  for (let left = 0; left < workspaces.length; left += 1) {
    for (let right = left + 1; right < workspaces.length; right += 1) {
      if (isInsideOrEqual(workspaces[left].root, workspaces[right].root) || isInsideOrEqual(workspaces[right].root, workspaces[left].root)) {
        fail("CONFIG_INVALID", "workspace roots must be physically disjoint");
      }
    }
  }

  let runtimeDir;
  try {
    await fs.mkdir(path.resolve(value.runtime_dir), { recursive: true, mode: 0o700 });
    runtimeDir = path.resolve(await fs.realpath(value.runtime_dir));
    if (!(await fs.stat(runtimeDir)).isDirectory()) fail("CONFIG_INVALID", "runtime_dir must be a directory");
  } catch (error) {
    if (error?.code === "CONFIG_INVALID") throw error;
    fail("CONFIG_INVALID", "runtime_dir is unavailable");
  }
  for (const workspace of workspaces) {
    if (isInsideOrEqual(workspace.root, runtimeDir) || isInsideOrEqual(runtimeDir, workspace.root)) fail("CONFIG_INVALID", "runtime_dir and workspace roots must be disjoint");
  }
  const normalized = { schema: CONFIG_SCHEMA, runtime_dir: runtimeDir, provider, workspaces: Object.freeze(workspaces) };
  normalized.config_hash = sha256(canonicalJson(normalized));
  return Object.freeze(normalized);
}

export async function loadRuntimeConfig({ configPath, env = process.env } = {}) {
  const home = runtimeHome(env);
  const selected = configPath ?? env.CODEX_IMAGE_CONTEXT_CONFIG ?? standardConfigPath(env);
  if (typeof selected !== "string" || !path.isAbsolute(selected)) fail("CONFIG_INVALID", "config path must be absolute");
  let exists = false;
  try {
    const entry = await fs.stat(selected);
    if (!entry.isFile()) fail("CONFIG_INVALID", "config path must identify a file");
    exists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error?.code === "CONFIG_INVALID") throw error;
      fail("CONFIG_INVALID", "config path is unavailable");
    }
  }
  const explicitRoots = parseWorkspaceRoots(env.CODEX_IMAGE_CONTEXT_ROOTS);
  if (!exists && !explicitRoots) fail("CONFIG_REQUIRED", "run the configuration helper before starting the MCP server");
  const fileConfig = exists ? await readJsonFileBounded(path.resolve(selected)) : null;
  return normalizeRuntimeConfig(withEnvironmentOverrides(fileConfig, env, home));
}

export function workspaceById(config, requestedId) {
  const id = requestedId ?? (config.workspaces.length === 1 ? config.workspaces[0].id : null);
  if (id === null) fail("WORKSPACE_ID_REQUIRED", "workspace_id is required when multiple roots are configured");
  const workspace = config.workspaces.find((candidate) => candidate.id === id);
  if (!workspace) fail("WORKSPACE_NOT_ALLOWED", "workspace_id is not configured");
  return workspace;
}

export function safeConfigSummary(config) {
  return Object.freeze({ schema: config.schema, provider_mode: config.provider.mode, generation_model: config.provider.generation_model, vision_model: config.provider.vision_model, workspace_ids: config.workspaces.map((workspace) => workspace.id) });
}
