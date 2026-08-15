import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CONFIG_SCHEMA } from "../src/constants.mjs";
import { configure, configureHelp, parseConfigureArgs } from "../scripts/configure.mjs";
import { diagnose, doctorHelp, renderDoctor } from "../scripts/doctor.mjs";

test("configure accepts an explicit relative workspace and documents safe options", () => {
  const root = path.join(os.tmpdir(), "image-context-relative-workspace");
  const parsed = parseConfigureArgs(["--workspace", ".", "--provider", "mock"], {
    cwd: root,
    env: {
      APPDATA: path.join(root, "config-home"),
      LOCALAPPDATA: path.join(root, "data-home")
    }
  });
  assert.equal(parsed.config.workspaces[0].root, path.resolve(root));
  assert.match(configureHelp(), /relative paths resolve from the current directory/i);
  assert.match(configureHelp(), /--force/);
});

test("doctor reports safe configuration facts without paths or credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-context-doctor-test-"));
  const workspace = path.join(root, "workspace");
  const runtimeDir = path.join(root, "runtime");
  const configPath = path.join(root, "config", "config.json");
  try {
    await fs.mkdir(workspace, { recursive: true });
    await configure([
      "--workspace", workspace,
      "--runtime-dir", runtimeDir,
      "--config", configPath,
      "--provider", "mock"
    ], { env: {} });
    const result = await diagnose(["--config", configPath], { env: {} });
    assert.equal(result.schema, "codex-image-context-doctor-v1");
    assert.equal(result.status, "ok");
    assert.equal(result.provider, "mock");
    assert.equal(result.credential, "not_required");
    assert.deepEqual(result.workspace_ids, ["workspace"]);
    const human = renderDoctor(result);
    const json = renderDoctor(result, { json: true });
    for (const output of [human, json]) {
      assert.equal(output.includes(root), false);
      assert.doesNotMatch(output, /OPENAI_API_KEY|sk-/i);
    }
    assert.match(doctorHelp(), /never prints workspace paths/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doctor warns about missing remote credentials and lock state without failing open", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-context-doctor-warning-test-"));
  const workspace = path.join(root, "workspace");
  const runtimeDir = path.join(root, "runtime");
  const configPath = path.join(root, "config", "config.json");
  try {
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify({
      schema: CONFIG_SCHEMA,
      runtime_dir: runtimeDir,
      provider: { mode: "openai", generation_model: "gpt-image-2", vision_model: "gpt-5.6" },
      workspaces: [{ id: "workspace", root: workspace }]
    })}\n`, { encoding: "utf8", flag: "wx" });
    await fs.writeFile(path.join(runtimeDir, "runtime.lock"), "{}\n", { flag: "wx" });
    const result = await diagnose(["--config", configPath], { env: {} });
    assert.equal(result.status, "warning");
    assert.equal(result.credential, "missing");
    assert.deepEqual(result.warnings.sort(), ["openai_api_key_missing", "runtime_lock_present"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
