import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadRuntimeConfig, normalizeRuntimeConfig, standardConfigPath } from "../src/config.mjs";
import { HANDOFF_MAX_BYTES, MCP_ENVELOPE_MAX_BYTES } from "../src/constants.mjs";
import { createMcpDispatcher, createMcpService, MCP_TOOLS } from "../src/mcp-service.mjs";
import { createMockProvider } from "../src/providers/mock.mjs";
import { ImageContextRuntime } from "../src/runtime.mjs";

const CONFIG_SCHEMA = "codex-image-context-config-v1";

async function makeFixture(t, { providerConfig, provider, delayMs = 0 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-context-runtime-test-"));
  const workspace = path.join(root, "workspace");
  const runtimeDir = path.join(root, "runtime");
  await fs.mkdir(workspace, { recursive: true });
  const config = await normalizeRuntimeConfig({
    schema: CONFIG_SCHEMA,
    runtime_dir: runtimeDir,
    provider: providerConfig ?? {
      mode: "mock",
      generation_model: "mock-image-v1",
      vision_model: "mock-vision-v1"
    },
    workspaces: [{ id: "workspace", root: workspace }]
  });
  const runtime = new ImageContextRuntime(config, {
    provider: provider ?? createMockProvider({ delayMs })
  });
  t.after(async () => {
    await runtime.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, workspace, runtimeDir, config, runtime };
}

function allStrings(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allStrings(item, result));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => allStrings(item, result));
  return result;
}

function assertPublicBoundary(value, { workspace, runtimeDir } = {}) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /data:image|b64_json|;base64,/i);
  for (const text of allStrings(value)) {
    assert.equal(path.isAbsolute(text), false, `absolute path escaped the public boundary: ${text}`);
    if (workspace) assert.equal(text.includes(workspace), false, "workspace absolute path escaped the public boundary");
    if (runtimeDir) assert.equal(text.includes(runtimeDir), false, "runtime absolute path escaped the public boundary");
  }
}

test("configuration fails closed without a config file or explicit roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-context-config-test-"));
  try {
    const missing = path.join(root, "missing.json");
    await assert.rejects(
      loadRuntimeConfig({
        configPath: missing,
        env: {
          CODEX_IMAGE_CONTEXT_HOME: path.join(root, "home"),
          XDG_CONFIG_HOME: path.join(root, "config-home"),
          APPDATA: path.join(root, "appdata")
        }
      }),
      (error) => error?.code === "CONFIG_REQUIRED"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stable config discovery does not depend on PLUGIN_DATA", () => {
  const platformConfigHome = path.join(os.tmpdir(), "image-context-stable-config");
  const common = process.platform === "win32"
    ? { APPDATA: platformConfigHome }
    : { XDG_CONFIG_HOME: platformConfigHome };
  const first = standardConfigPath({ ...common, PLUGIN_DATA: path.join(os.tmpdir(), "plugin-a") });
  const second = standardConfigPath({ ...common, PLUGIN_DATA: path.join(os.tmpdir(), "plugin-b") });
  assert.equal(first, second);
  assert.equal(first, path.join(platformConfigHome, "codex-image-context-runtime", "config.json"));
});

test("mock generation and inspection stay text-only and within MCP and handoff budgets", async (t) => {
  const { runtime, workspace, runtimeDir } = await makeFixture(t);
  const service = createMcpService(runtime);

  const generationEnvelope = await service.call("submit_image_generation", {
    workspace_id: "workspace",
    prompt: "A deterministic blue square for an offline test.",
    output_path: "art/generated.png",
    size: "1024x1024",
    quality: "low",
    idempotency_key: "generation-boundary-test"
  });
  assert.ok(Buffer.byteLength(JSON.stringify(generationEnvelope)) <= MCP_ENVELOPE_MAX_BYTES);
  assert.deepEqual(generationEnvelope.content.map((item) => item.type), ["text"]);
  assertPublicBoundary(generationEnvelope, { workspace, runtimeDir });

  const generated = await runtime.waitForIdle(generationEnvelope.structuredContent.job_id);
  assert.equal(generated.status, "completed");
  assert.equal(generated.artifacts[0].path, "art/generated.png");
  assert.equal((await fs.stat(path.join(workspace, "art", "generated.png"))).isFile(), true);
  assertPublicBoundary(generated, { workspace, runtimeDir });

  const generationHandoff = await service.call("get_image_handoff", { job_id: generated.job_id });
  assert.ok(Buffer.byteLength(generationHandoff.structuredContent.handoff_text) <= HANDOFF_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(generationHandoff)) <= MCP_ENVELOPE_MAX_BYTES);
  assert.deepEqual(generationHandoff.content.map((item) => item.type), ["text"]);
  assertPublicBoundary(generationHandoff, { workspace, runtimeDir });

  const inspectionEnvelope = await service.call("submit_image_inspection", {
    workspace_id: "workspace",
    image_path: "art/generated.png",
    prompt: "Report format and obvious technical properties.",
    mode: "qa",
    idempotency_key: "inspection-boundary-test"
  });
  assert.ok(Buffer.byteLength(JSON.stringify(inspectionEnvelope)) <= MCP_ENVELOPE_MAX_BYTES);
  assert.deepEqual(inspectionEnvelope.content.map((item) => item.type), ["text"]);
  assertPublicBoundary(inspectionEnvelope, { workspace, runtimeDir });

  const inspected = await runtime.waitForIdle(inspectionEnvelope.structuredContent.job_id);
  assert.equal(inspected.status, "completed");
  const inspectionHandoff = await service.call("get_image_handoff", { job_id: inspected.job_id });
  assert.match(inspectionHandoff.structuredContent.handoff_text, /Offline deterministic visual QA/);
  assert.ok(Buffer.byteLength(inspectionHandoff.structuredContent.handoff_text) <= HANDOFF_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(inspectionHandoff)) <= MCP_ENVELOPE_MAX_BYTES);
  assert.deepEqual(inspectionHandoff.content.map((item) => item.type), ["text"]);
  assertPublicBoundary(inspectionHandoff, { workspace, runtimeDir });
});

test("completed generation replays the same idempotency key without redispatch", async (t) => {
  let generationCalls = 0;
  const base = createMockProvider();
  const provider = Object.freeze({
    ...base,
    async generate(args) {
      generationCalls += 1;
      return base.generate(args);
    }
  });
  const { runtime } = await makeFixture(t, { provider });
  const args = {
    workspace_id: "workspace",
    prompt: "Idempotent offline image.",
    output_path: "replay.png",
    size: "1024x1024",
    quality: "low",
    idempotency_key: "same-generation-key"
  };
  const first = await runtime.submitGeneration(args);
  const completed = await runtime.waitForIdle(first.job_id);
  assert.equal(completed.status, "completed");
  const replay = await runtime.submitGeneration(args);
  assert.equal(replay.job_id, first.job_id);
  assert.equal(replay.status, "completed");
  assert.equal(replay.deduped, true);
  assert.equal(generationCalls, 1);
});

test("different idempotency keys cannot concurrently dispatch to the same output", async (t) => {
  let generationCalls = 0;
  const base = createMockProvider({ delayMs: 75 });
  const provider = Object.freeze({
    ...base,
    async generate(args) {
      generationCalls += 1;
      return base.generate(args);
    }
  });
  const { runtime } = await makeFixture(t, { provider });
  const common = {
    workspace_id: "workspace",
    prompt: "Competing output reservation.",
    output_path: "reserved.png",
    size: "1024x1024",
    quality: "low"
  };
  const settled = await Promise.allSettled([
    runtime.submitGeneration({ ...common, idempotency_key: "reservation-key-one" }),
    runtime.submitGeneration({ ...common, idempotency_key: "reservation-key-two" })
  ]);

  const submitted = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
  for (const job of submitted) await runtime.waitForIdle(job.job_id).catch(() => {});
  const publicJobs = await runtime.listJobs({ limit: 25 });
  const completed = publicJobs.jobs.filter((job) => job.status === "completed" && job.artifacts[0]?.path === "reserved.png");
  const reservationFailures = [
    ...settled.filter((item) => item.status === "rejected"),
    ...publicJobs.jobs.filter((job) => job.status === "failed")
  ];
  assert.equal(completed.length, 1);
  assert.equal(generationCalls, 1, "the losing output reservation must fail before Provider dispatch");
  assert.ok(reservationFailures.length >= 1, "one competing request must fail locally");
});

test("runtime lock rejects a second live owner and permits stale PID recovery", async (t) => {
  const { config, runtime, runtimeDir } = await makeFixture(t);
  const contender = new ImageContextRuntime(config, { provider: createMockProvider() });
  t.after(() => contender.close().catch(() => {}));
  await runtime.initialize();
  await assert.rejects(contender.initialize(), (error) => error?.code === "RUNTIME_ALREADY_RUNNING");
  await runtime.close();

  await fs.writeFile(path.join(runtimeDir, "runtime.lock"), `${JSON.stringify({
    pid: 2147483647,
    token: "stale-test-token",
    acquired_at: "2000-01-01T00:00:00.000Z"
  })}\n`, { flag: "wx" });
  await contender.initialize();
  const recovered = JSON.parse(await fs.readFile(path.join(runtimeDir, "runtime.lock"), "utf8"));
  assert.equal(recovered.pid, process.pid);
  assert.notEqual(recovered.token, "stale-test-token");
});

test("a provider config switch keeps terminal historical jobs queryable", async (t) => {
  const fixture = await makeFixture(t);
  const first = await fixture.runtime.submitGeneration({
    workspace_id: "workspace",
    prompt: "Historical terminal job.",
    output_path: "history.png",
    size: "1024x1024",
    quality: "low",
    idempotency_key: "historical-provider-job"
  });
  const completed = await fixture.runtime.waitForIdle(first.job_id);
  assert.equal(completed.status, "completed");
  await fixture.runtime.close();

  const switchedConfig = await normalizeRuntimeConfig({
    schema: CONFIG_SCHEMA,
    runtime_dir: fixture.runtimeDir,
    provider: {
      mode: "openai",
      generation_model: "gpt-image-2",
      vision_model: "gpt-5.6"
    },
    workspaces: [{ id: "workspace", root: fixture.workspace }]
  });
  const switched = new ImageContextRuntime(switchedConfig, { provider: createMockProvider() });
  t.after(() => switched.close().catch(() => {}));
  await switched.initialize();
  const historical = await switched.getJob(first.job_id);
  assert.equal(historical.status, "completed");
  assert.equal(historical.artifacts[0].path, "history.png");
});

test("MCP exposes exactly seven tools and labels remote OpenAI cost-bearing submits", async () => {
  const names = MCP_TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, [
    "submit_image_generation",
    "submit_image_inspection",
    "get_image_job",
    "get_image_handoff",
    "resume_image_job",
    "cancel_image_job",
    "list_image_jobs"
  ]);
  for (const name of ["submit_image_generation", "submit_image_inspection"]) {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
    assert.equal(tool.annotations.openWorldHint, true);
    assert.match(tool.description, /OpenAI/i);
    assert.match(tool.description, /remote/i);
    assert.match(tool.description, /cost/i);
  }
  const generationSchema = MCP_TOOLS.find((tool) => tool.name === "submit_image_generation").inputSchema;
  assert.equal(generationSchema.oneOf.length, 2, "generation schema must require exactly one prompt source");
  const inspectionSchema = MCP_TOOLS.find((tool) => tool.name === "submit_image_inspection").inputSchema;
  assert.deepEqual(inspectionSchema.not.required, ["prompt", "prompt_ref"], "inspection schema must reject two prompt sources");
  const dispatch = createMcpDispatcher({ runtime: { config: {} } });
  const listed = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(listed.result.tools.length, 7);
  assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= MCP_ENVELOPE_MAX_BYTES);
});

test("MCP negotiates supported protocols, ignores notifications, and rejects invalid requests", async () => {
  const dispatch = createMcpDispatcher({ runtime: { config: {
    schema: CONFIG_SCHEMA,
    provider: { mode: "mock", generation_model: "mock-image-v1", vision_model: "mock-vision-v1" },
    workspaces: []
  } } });

  const current = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } });
  assert.equal(current.result.protocolVersion, "2025-06-18", "an unknown client version must not be echoed as supported");

  const compatible = await dispatch({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(compatible.result.protocolVersion, "2025-03-26");

  assert.equal(await dispatch({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }), null);
  assert.equal(await dispatch({ jsonrpc: "2.0", method: "tools/list", params: {} }), null, "requests without IDs are notifications and must not receive responses");

  const invalidVersion = await dispatch({ jsonrpc: "1.0", id: 3, method: "ping" });
  assert.deepEqual(invalidVersion, { jsonrpc: "2.0", id: 3, error: { code: -32600, message: "Invalid Request" } });
  const invalidShape = await dispatch([]);
  assert.deepEqual(invalidShape, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
});
