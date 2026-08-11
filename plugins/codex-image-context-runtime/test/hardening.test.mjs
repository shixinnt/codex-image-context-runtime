import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { startMcpServer } from "../mcp/server.mjs";
import { normalizeRuntimeConfig } from "../src/config.mjs";
import { RuntimeError } from "../src/errors.mjs";
import { createMockProvider } from "../src/providers/mock.mjs";
import { createOpenAIProvider } from "../src/providers/openai.mjs";
import { ImageContextRuntime } from "../src/runtime.mjs";
import { assertSafePublicText, retryTransientFs } from "../src/safety.mjs";
import { JobStore } from "../src/store.mjs";

const CONFIG_SCHEMA = "codex-image-context-config-v1";

async function fixture(t, { provider, providerConfig } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-context-hardening-"));
  const workspace = path.join(root, "workspace");
  const runtimeDir = path.join(root, "runtime");
  const configPath = path.join(root, "config.json");
  await fs.mkdir(workspace, { recursive: true });
  const persisted = {
    schema: CONFIG_SCHEMA,
    runtime_dir: runtimeDir,
    provider: providerConfig ?? { mode: "mock", generation_model: "mock-image-v1", vision_model: "mock-vision-v1" },
    workspaces: [{ id: "workspace", root: workspace }]
  };
  const config = await normalizeRuntimeConfig(persisted);
  await fs.writeFile(configPath, `${JSON.stringify(persisted)}\n`, "utf8");
  const runtime = new ImageContextRuntime(config, { provider: provider ?? createMockProvider() });
  t.after(async () => {
    await runtime.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, workspace, runtimeDir, configPath, config, runtime };
}

const generationArgs = (index) => ({
  workspace_id: "workspace",
  prompt: `Offline bounded concurrency image ${index}.`,
  output_path: `batch/image-${index}.png`,
  size: "1024x1024",
  quality: "low",
  idempotency_key: `bounded-provider-key-${index}`
});

test("one runtime memoizes concurrent initialization", async (t) => {
  const { runtime } = await fixture(t);
  const [first, second] = await Promise.all([runtime.initialize(), runtime.initialize()]);
  assert.equal(first, runtime);
  assert.equal(second, runtime);
});

test("transient filesystem retries are bounded and never retry EEXIST", async () => {
  const sleeps = [];
  let transientAttempts = 0;
  const recovered = await retryTransientFs(async () => {
    transientAttempts += 1;
    if (transientAttempts < 3) throw Object.assign(new Error("synthetic transient filesystem contention"), { code: "EPERM" });
    return "recovered";
  }, { delaysMs: [10, 20, 30], sleep: async (delayMs) => sleeps.push(delayMs) });
  assert.equal(recovered, "recovered");
  assert.equal(transientAttempts, 3);
  assert.deepEqual(sleeps, [10, 20]);

  let existsAttempts = 0;
  await assert.rejects(retryTransientFs(async () => {
    existsAttempts += 1;
    throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
  }, { delaysMs: [0, 0], sleep: async () => {} }), (error) => error?.code === "EEXIST");
  assert.equal(existsAttempts, 1, "no-overwrite EEXIST must never be retried");

  let exhaustedAttempts = 0;
  await assert.rejects(retryTransientFs(async () => {
    exhaustedAttempts += 1;
    throw Object.assign(new Error("persistent contention"), { code: "EBUSY" });
  }, { delaysMs: [1, 2], sleep: async () => {} }), (error) => error?.code === "EBUSY");
  assert.equal(exhaustedAttempts, 3, "the retry budget must remain finite");
});

test("configuration rejects overlapping roots and a runtime junction resolving inside a workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-context-canonical-roots-"));
  try {
    const workspace = path.join(root, "workspace");
    const nested = path.join(workspace, "nested");
    const runtimeAlias = path.join(root, "runtime-alias");
    await fs.mkdir(nested, { recursive: true });
    await assert.rejects(normalizeRuntimeConfig({
      schema: CONFIG_SCHEMA,
      runtime_dir: path.join(root, "runtime"),
      provider: { mode: "mock", generation_model: "mock-image-v1", vision_model: "mock-vision-v1" },
      workspaces: [{ id: "one", root: workspace }, { id: "two", root: nested }]
    }), (error) => error?.code === "CONFIG_INVALID");

    await fs.symlink(workspace, runtimeAlias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(normalizeRuntimeConfig({
      schema: CONFIG_SCHEMA,
      runtime_dir: runtimeAlias,
      provider: { mode: "mock", generation_model: "mock-image-v1", vision_model: "mock-vision-v1" },
      workspaces: [{ id: "workspace", root: workspace }]
    }), (error) => error?.code === "CONFIG_INVALID");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("output directory aliases fail before Provider dispatch", async (t) => {
  let generationCalls = 0;
  const base = createMockProvider();
  const provider = Object.freeze({
    ...base,
    async generate(args) {
      generationCalls += 1;
      return base.generate(args);
    }
  });
  const { workspace, runtime } = await fixture(t, { provider });
  const physical = path.join(workspace, "physical-output");
  const alias = path.join(workspace, "aliased-output");
  await fs.mkdir(physical);
  await fs.symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");

  const result = await runtime.submitGeneration({
    workspace_id: "workspace",
    prompt: "This request must stop before Provider dispatch.",
    output_path: "aliased-output/frame.png",
    size: "1024x1024",
    quality: "low",
    idempotency_key: "output-alias-preflight"
  });

  assert.equal(result.status, "failed");
  assert.equal(result.diagnostic?.code, "OUTPUT_PATH_ALIAS_FORBIDDEN");
  assert.equal(generationCalls, 0);
});

test("output reservations conservatively fold filename case on every platform", async (t) => {
  let generationCalls = 0;
  const base = createMockProvider({ delayMs: 25 });
  const provider = Object.freeze({
    ...base,
    async generate(args) {
      generationCalls += 1;
      return base.generate(args);
    }
  });
  const { runtime } = await fixture(t, { provider });
  const common = {
    workspace_id: "workspace",
    prompt: "Case-folded output reservation.",
    size: "1024x1024",
    quality: "low"
  };
  const [upper, lower] = await Promise.all([
    runtime.submitGeneration({ ...common, output_path: "CaseTarget.png", idempotency_key: "case-output-upper" }),
    runtime.submitGeneration({ ...common, output_path: "casetarget.png", idempotency_key: "case-output-lower" })
  ]);
  const accepted = [upper, lower].find((job) => job.status !== "failed");
  const rejected = [upper, lower].find((job) => job.status === "failed");
  assert.ok(accepted);
  assert.equal(rejected?.diagnostic?.code, "OUTPUT_RESERVED");
  const settled = await runtime.waitForIdle(accepted.job_id);
  assert.equal(settled.status, "completed", `winner failed with ${JSON.stringify(settled.diagnostic)}`);
  assert.equal(generationCalls, 1);
});

test("provider dispatch concurrency is bounded to two", async (t) => {
  const base = createMockProvider({ delayMs: 50 });
  let active = 0;
  let maximum = 0;
  const provider = {
    ...base,
    async generate(args) {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        return await base.generate(args);
      } finally {
        active -= 1;
      }
    }
  };
  const { runtime } = await fixture(t, { provider });
  const submitted = await Promise.all(Array.from({ length: 6 }, (_, index) => runtime.submitGeneration(generationArgs(index))));
  await Promise.all(submitted.map((job) => runtime.waitForIdle(job.job_id, { timeoutMs: 10_000 })));
  assert.equal(maximum, 2);
});

test("waitForIdle follows the active worker without high-frequency state polling", async (t) => {
  const { runtime } = await fixture(t, { provider: createMockProvider({ delayMs: 500 }) });
  const originalRequireJob = runtime.store.requireJob.bind(runtime.store);
  let reads = 0;
  runtime.store.requireJob = async (...args) => {
    reads += 1;
    return originalRequireJob(...args);
  };

  const submitted = await runtime.submitGeneration(generationArgs("active-wait"));
  const completed = await runtime.waitForIdle(submitted.job_id);
  assert.equal(completed.status, "completed");
  assert.ok(reads < 20, `active wait performed too many durable state reads: ${reads}`);
});

test("resume refuses a safe-retry job after provider configuration changes", async (t) => {
  const failingProvider = {
    name: "mock",
    async generate() { throw new RuntimeError("LOCAL_PRE_DISPATCH_FAILURE", "offline failure"); },
    async inspect() { throw new RuntimeError("LOCAL_PRE_DISPATCH_FAILURE", "offline failure"); }
  };
  const state = await fixture(t, { provider: failingProvider });
  const submitted = await state.runtime.submitGeneration(generationArgs("resume"));
  const failed = await state.runtime.waitForIdle(submitted.job_id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.resumable, true);
  await state.runtime.close();

  const changed = await normalizeRuntimeConfig({
    schema: CONFIG_SCHEMA,
    runtime_dir: state.runtimeDir,
    provider: { mode: "openai", generation_model: "gpt-image-2", vision_model: "gpt-5.6" },
    workspaces: [{ id: "workspace", root: state.workspace }]
  });
  const replacement = new ImageContextRuntime(changed, { provider: createMockProvider() });
  t.after(() => replacement.close().catch(() => {}));
  await replacement.initialize();
  await assert.rejects(replacement.resumeJob(submitted.job_id), (error) => error?.code === "CONFIG_CHANGED");
});

test("a crash after idempotency claim remains recoverable and resume reclaims the output", async (t) => {
  const state = await fixture(t);
  await state.runtime.initialize();
  const originalSave = state.runtime.store.saveJob.bind(state.runtime.store);
  let saves = 0;
  state.runtime.store.saveJob = async (job) => {
    saves += 1;
    if (saves === 2) throw new Error("simulated crash after durable claim");
    return originalSave(job);
  };
  const args = generationArgs("claim-crash");
  await assert.rejects(state.runtime.submitGeneration(args), /simulated crash/);
  await state.runtime.close();

  const replacement = new ImageContextRuntime(state.config, { provider: createMockProvider() });
  t.after(() => replacement.close().catch(() => {}));
  await replacement.initialize();
  const jobs = await replacement.listJobs({ limit: 25 });
  assert.equal(jobs.jobs.length, 1);
  assert.equal(jobs.jobs[0].status, "failed");
  assert.equal(jobs.jobs[0].resumable, true);
  const replay = await replacement.submitGeneration(args);
  assert.equal(replay.job_id, jobs.jobs[0].job_id);
  assert.equal(replay.deduped, true);
  await replacement.resumeJob(replay.job_id);
  const completed = await replacement.waitForIdle(replay.job_id);
  assert.equal(completed.status, "completed");
  await replacement.close();
});

test("cancelling before dispatch releases the output for a new job", async (t) => {
  const { runtime } = await fixture(t, { provider: createMockProvider({ delayMs: 50 }) });
  const first = await runtime.submitGeneration(generationArgs("cancelled-output"));
  const cancelled = await runtime.cancelJob(first.job_id);
  assert.equal(cancelled.status, "cancelled");
  const second = await runtime.submitGeneration({ ...generationArgs("cancelled-output"), idempotency_key: "replacement-after-cancel-key" });
  assert.notEqual(second.status, "failed");
  assert.equal((await runtime.waitForIdle(second.job_id)).status, "completed");
});

test("raw common image base64 prefixes are rejected from public text", () => {
  for (const value of [
    "iVBORw0KGgoAAAANSUhEUgAAAAE=",
    "/9j/4AAQSkZJRgABAQAAAQABAAD=",
    "UklGRlIAAABXRUJQVlA4ICAAAAA=",
    "R0lGODlhAQABAIAAAAAAAP///yw="
  ]) {
    assert.throws(() => assertSafePublicText(value), (error) => error?.code === "INLINE_MEDIA_FORBIDDEN");
  }
});

test("public text rejects generic POSIX and assigned absolute paths", () => {
  for (const value of ["/srv/private/file.png", "path=/workspace/private/file.png", "source: /tmp/private.png", "C:\\private\\file.png", "\\\\server\\share\\file.png"]) {
    assert.throws(() => assertSafePublicText(value), (error) => error?.code === "ABSOLUTE_PATH_FORBIDDEN");
  }
  assert.doesNotThrow(() => assertSafePublicText("Official endpoint: https://api.openai.com/v1/responses"));
});

test("multi-byte inspection text is bounded before a completed handoff is recorded", async (t) => {
  const base = createMockProvider();
  const provider = {
    ...base,
    async inspect({ onCheckpoint }) {
      await onCheckpoint({ dispatch_state: "dispatch_started", model: "mock-vision-v1" });
      await onCheckpoint({ dispatch_state: "result_available", model: "mock-vision-v1" });
      return { text: "图".repeat(6_000), model: "mock-vision-v1" };
    }
  };
  const { runtime } = await fixture(t, { provider });
  const generated = await runtime.submitGeneration(generationArgs("unicode-source"));
  await runtime.waitForIdle(generated.job_id);
  const submitted = await runtime.submitInspection({
    workspace_id: "workspace",
    image_path: "batch/image-unicode-source.png",
    idempotency_key: "unicode-inspection-key"
  });
  assert.equal((await runtime.waitForIdle(submitted.job_id)).status, "completed");
  const handoff = await runtime.getHandoff(submitted.job_id);
  assert.ok(Buffer.byteLength(handoff.handoff_text, "utf8") <= 16 * 1024);
  assert.match(handoff.handoff_text, /truncated/i);
});

test("inspection output containing raw base64 fails closed behind the MCP boundary", async (t) => {
  const base = createMockProvider();
  const leaking = {
    ...base,
    async inspect({ onCheckpoint }) {
      await onCheckpoint({ dispatch_state: "dispatch_started", model: "mock-vision-v1" });
      return { text: "iVBORw0KGgoAAAANSUhEUgAAAAE=", model: "mock-vision-v1" };
    }
  };
  const { runtime } = await fixture(t, { provider: leaking });
  const generated = await runtime.submitGeneration(generationArgs("inspect-source"));
  await runtime.waitForIdle(generated.job_id);
  const submitted = await runtime.submitInspection({
    workspace_id: "workspace",
    image_path: "batch/image-inspect-source.png",
    idempotency_key: "base64-leak-inspection-key"
  });
  const result = await runtime.waitForIdle(submitted.job_id);
  assert.equal(result.status, "needs_review");
  const handoff = await runtime.getHandoff(submitted.job_id);
  assert.doesNotMatch(handoff.handoff_text, /iVBORw0KGgo/);
});

test("runtime lock treats permission errors as live ownership", async (t) => {
  const { config, runtimeDir } = await fixture(t);
  const lockPath = path.join(runtimeDir, "runtime.lock");
  await fs.writeFile(lockPath, `${JSON.stringify({ pid: 424242, token: "permission-test-token", acquired_at: new Date().toISOString() })}\n`, "utf8");
  const store = new JobStore(config, {
    processKill() { const error = new Error("not permitted"); error.code = "EPERM"; throw error; }
  });
  await assert.rejects(store.acquireRuntimeLock(), (error) => error?.code === "RUNTIME_ALREADY_RUNNING");
  assert.equal((await fs.stat(lockPath)).isFile(), true);
});

test("concurrent stale-lock takeover permits exactly one runtime owner", async (t) => {
  const { config, runtimeDir } = await fixture(t);
  await fs.writeFile(path.join(runtimeDir, "runtime.lock"), `${JSON.stringify({
    pid: 2147483647,
    token: "stale-concurrent-token",
    acquired_at: "2000-01-01T00:00:00.000Z"
  })}\n`, "utf8");
  const first = new ImageContextRuntime(config, { provider: createMockProvider() });
  const second = new ImageContextRuntime(config, { provider: createMockProvider() });
  t.after(async () => {
    await first.close().catch(() => {});
    await second.close().catch(() => {});
  });
  const settled = await Promise.allSettled([first.initialize(), second.initialize()]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(settled.filter((entry) => entry.status === "rejected" && entry.reason?.code === "RUNTIME_ALREADY_RUNNING").length, 1);
});

test("MCP EOF closes the worker and releases its exclusive runtime lock", async (t) => {
  const state = await fixture(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const server = await startMcpServer({ configPath: state.configPath, input, output, provider: createMockProvider() });
  const closed = new Promise((resolve) => server.lines.once("close", resolve));
  input.end();
  await closed;
  await server.close();
  const next = new ImageContextRuntime(state.config, { provider: createMockProvider() });
  t.after(() => next.close().catch(() => {}));
  await next.initialize();
});

test("OpenAI provider uses fixed official endpoints, request shapes, configured models, and redirects disabled", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (url.endsWith("/images/generations")) {
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("offline-image-bytes").toString("base64") }] }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "req_generation" }
      });
    }
    return new Response(JSON.stringify({ output_text: "Bounded offline visual inspection." }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "req_inspection" }
    });
  };
  const provider = createOpenAIProvider({
    fetchImpl,
    env: { OPENAI_API_KEY: "offline_contract_key_123" },
    generationModel: "gpt-image-custom",
    visionModel: "gpt-vision-custom"
  });
  const checkpoints = [];
  const generated = await provider.generate({
    prompt: "Offline contract request.", size: "1024x1024", quality: "low",
    onCheckpoint: (value) => { checkpoints.push(value); }
  });
  const inspected = await provider.inspect({
    bytes: Buffer.from("offline-image"), mediaType: "image/png", prompt: "Inspect offline.", mode: "inspect",
    onCheckpoint: (value) => { checkpoints.push(value); }
  });

  assert.equal(generated.bytes.toString(), "offline-image-bytes");
  assert.equal(generated.model, "gpt-image-custom");
  assert.equal(inspected.text, "Bounded offline visual inspection.");
  assert.equal(inspected.model, "gpt-vision-custom");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.openai.com/v1/images/generations",
    "https://api.openai.com/v1/responses"
  ]);
  assert.ok(calls.every((call) => call.options.redirect === "error"));
  assert.equal(calls[0].body.model, "gpt-image-custom");
  assert.equal(calls[0].body.output_format, "png");
  assert.equal(calls[1].body.model, "gpt-vision-custom");
  const imagePart = calls[1].body.input[0].content.find((part) => part.type === "input_image");
  assert.match(imagePart.image_url, /^data:image\/png;base64,/);
  assert.equal(checkpoints.filter((item) => item.dispatch_state === "dispatch_started").length, 2);
});

test("OpenAI provider rejects oversized Content-Length and streamed bodies without reading unbounded JSON", async () => {
  const checkpoint = async () => {};
  const contentLengthProvider = createOpenAIProvider({
    env: { OPENAI_API_KEY: "offline_bounds_key_123" },
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-length": "999999999" } })
  });
  await assert.rejects(
    contentLengthProvider.generate({ prompt: "x", size: "1024x1024", quality: "low", onCheckpoint: checkpoint }),
    (error) => error?.code === "PROVIDER_RESPONSE_TOO_LARGE" && error?.dispatchStarted === true
  );

  const streamedProvider = createOpenAIProvider({
    env: { OPENAI_API_KEY: "offline_stream_key_123" },
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(300 * 1024));
        controller.close();
      }
    }), { status: 200 })
  });
  await assert.rejects(
    streamedProvider.inspect({ bytes: Buffer.from("x"), mediaType: "image/png", prompt: "x", mode: "inspect", onCheckpoint: checkpoint }),
    (error) => error?.code === "PROVIDER_RESPONSE_TOO_LARGE" && error?.dispatchStarted === true
  );
});

test("OpenAI provider maps HTTP rejection, transport failure, and timeout to closed errors", async () => {
  const args = { prompt: "x", size: "1024x1024", quality: "low", onCheckpoint: async () => {} };
  const rejected = createOpenAIProvider({
    env: { OPENAI_API_KEY: "offline_errors_key_123" },
    fetchImpl: async () => new Response("secret body must not escape", { status: 429 })
  });
  await assert.rejects(rejected.generate(args), (error) => error?.code === "PROVIDER_REJECTED" && !error.message.includes("secret body"));

  const transport = createOpenAIProvider({
    env: { OPENAI_API_KEY: "offline_errors_key_123" },
    fetchImpl: async () => { throw new Error("private network detail"); }
  });
  await assert.rejects(transport.generate(args), (error) => error?.code === "PROVIDER_OUTCOME_UNKNOWN" && !error.message.includes("private network detail"));

  const timeout = createOpenAIProvider({
    env: { OPENAI_API_KEY: "offline_errors_key_123" },
    timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    })
  });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(timeout.generate(args), (error) => error?.code === "PROVIDER_OUTCOME_UNKNOWN");
  } finally {
    clearTimeout(keepAlive);
  }
});
