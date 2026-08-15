import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";

import { startBrokeredMcpServer } from "../mcp/server.mjs";
import { brokerDescriptorPath, connectToBroker, readBrokerDescriptor, startBroker } from "../src/broker.mjs";
import { normalizeRuntimeConfig } from "../src/config.mjs";
import { createMockProvider } from "../src/providers/mock.mjs";
import { diagnose } from "../scripts/doctor.mjs";

const CONFIG_SCHEMA = "codex-image-context-config-v1";

const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await sleep(50);
  }
  throw new Error("detached broker did not exit before test cleanup");
}

async function fixture(t, { provider } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-context-broker-test-"));
  const workspace = path.join(root, "workspace");
  const runtimeDir = path.join(root, "runtime");
  const configPath = path.join(root, "config.json");
  await fs.mkdir(workspace, { recursive: true });
  const persisted = {
    schema: CONFIG_SCHEMA,
    runtime_dir: runtimeDir,
    provider: { mode: "mock", generation_model: "mock-image-v1", vision_model: "mock-vision-v1" },
    workspaces: [{ id: "workspace", root: workspace }]
  };
  await fs.writeFile(configPath, `${JSON.stringify(persisted)}\n`, { encoding: "utf8", flag: "wx" });
  const config = await normalizeRuntimeConfig(persisted);
  const broker = await startBroker({ configPath, provider: provider ?? createMockProvider(), idleTimeoutMs: 10_000 });
  t.after(async () => {
    await broker.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, workspace, runtimeDir, configPath, config, broker };
}

async function clientFor(config) {
  const socket = await connectToBroker(config);
  const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  return {
    socket,
    call(message) {
      return new Promise((resolve, reject) => {
        pending.set(message.id, { resolve, reject });
        socket.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) {
            pending.delete(message.id);
            reject(error);
          }
        });
      });
    },
    close() {
      lines.close();
      socket.destroy();
      for (const waiter of pending.values()) waiter.reject(new Error("client closed"));
      pending.clear();
    }
  };
}

const generationCall = (id, key, outputPath) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: {
    name: "submit_image_generation",
    arguments: {
      workspace_id: "workspace",
      prompt: "Synthetic shared broker image.",
      output_path: outputPath,
      size: "1024x1024",
      quality: "low",
      idempotency_key: key
    }
  }
});

test("two authenticated clients share one Runtime and one idempotent dispatch", async (t) => {
  let calls = 0;
  const mock = createMockProvider({ delayMs: 50 });
  const provider = {
    ...mock,
    async generate(request) {
      calls += 1;
      return mock.generate(request);
    }
  };
  const { config, broker } = await fixture(t, { provider });
  const first = await clientFor(config);
  const second = await clientFor(config);
  t.after(() => { first.close(); second.close(); });

  const [left, right] = await Promise.all([
    first.call(generationCall(1, "shared-broker-idempotency-key", "shared/frame.png")),
    second.call(generationCall(2, "shared-broker-idempotency-key", "shared/frame.png"))
  ]);
  assert.equal(left.result.structuredContent.job_id, right.result.structuredContent.job_id);
  const jobId = left.result.structuredContent.job_id;
  const settled = await broker.runtime.waitForIdle(jobId);
  assert.equal(settled.status, "completed");
  assert.equal(calls, 1);

  const listed = await second.call({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  assert.equal(listed.result.tools.length, 7);
});

test("provider concurrency is globally bounded across broker clients", async (t) => {
  let active = 0;
  let maximum = 0;
  const mock = createMockProvider({ delayMs: 100 });
  const provider = {
    ...mock,
    async generate(request) {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        return await mock.generate(request);
      } finally {
        active -= 1;
      }
    }
  };
  const { config, broker } = await fixture(t, { provider });
  const clients = [await clientFor(config), await clientFor(config)];
  t.after(() => clients.forEach((client) => client.close()));
  const submissions = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    clients[index % clients.length].call(generationCall(index + 10, `broker-concurrency-key-${index}`, `parallel/frame-${index}.png`))
  ));
  await Promise.all(submissions.map((response) => broker.runtime.waitForIdle(response.result.structuredContent.job_id)));
  assert.equal(maximum, 2);
});

test("broker authentication rejects a wrong token without echoing it", async (t) => {
  const { config } = await fixture(t);
  const descriptor = await readBrokerDescriptor(config);
  const wrongToken = "0".repeat(64);
  const response = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: descriptor.port });
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "auth", protocol: "broker-v1", token: wrongToken, config_hash: config.config_hash })}\n`));
    socket.once("data", (data) => {
      socket.destroy();
      resolve(data);
    });
  });
  assert.match(response, /broker_auth_failed/);
  assert.equal(response.includes(wrongToken), false);
  assert.equal(response.includes(descriptor.token), false);
});

test("broker removes only its owned descriptor on close", async (t) => {
  const { config, broker } = await fixture(t);
  assert.equal((await readBrokerDescriptor(config)).pid, process.pid);
  const diagnosis = await diagnose(["--config", path.join(config.runtime_dir, "..", "config.json")], { env: {} });
  assert.equal(diagnosis.broker, "running");
  assert.equal(diagnosis.warnings.includes("runtime_lock_present"), false);
  await broker.close();
  await assert.rejects(fs.stat(brokerDescriptorPath(config)), (error) => error?.code === "ENOENT");
});

test("stdio bridge autostarts one detached mock broker from a clean config", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-context-broker-bridge-"));
  const workspace = path.join(root, "workspace");
  const runtimeDir = path.join(root, "runtime");
  const configPath = path.join(root, "config.json");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify({
    schema: CONFIG_SCHEMA,
    runtime_dir: runtimeDir,
    provider: { mode: "mock", generation_model: "mock-image-v1", vision_model: "mock-vision-v1" },
    workspaces: [{ id: "workspace", root: workspace }]
  })}\n`, { encoding: "utf8", flag: "wx" });
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let brokerPid = null;
  let bridge = null;
  let config = null;
  t.after(async () => {
    await bridge?.close().catch(() => {});
    if (!brokerPid) {
      try {
        config ??= await normalizeRuntimeConfig(JSON.parse(await fs.readFile(configPath, "utf8")));
        brokerPid = (await readBrokerDescriptor(config))?.pid ?? null;
      } catch {}
    }
    if (brokerPid) {
      try { process.kill(brokerPid, "SIGTERM"); } catch {}
      await waitForProcessExit(brokerPid);
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  bridge = await startBrokeredMcpServer({
    configPath,
    env: { ...process.env, CODEX_IMAGE_CONTEXT_BROKER_IDLE_MS: "500" },
    input,
    output
  });
  const responsePromise = new Promise((resolve) => {
    let text = "";
    output.on("data", (chunk) => {
      text += chunk;
      const lines = text.trim().split(/\r?\n/);
      if (lines.length >= 2) resolve(lines.slice(0, 2).map((line) => JSON.parse(line)));
    });
  });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const responses = await responsePromise;
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(byId.has(1), true, JSON.stringify(responses));
  assert.equal(byId.has(2), true, JSON.stringify(responses));
  assert.equal(byId.get(1).result.serverInfo.name, "codex-image-context-runtime");
  assert.equal(byId.get(2).result.tools.length, 7);
  config = await normalizeRuntimeConfig(JSON.parse(await fs.readFile(configPath, "utf8")));
  brokerPid = (await readBrokerDescriptor(config)).pid;
  assert.notEqual(brokerPid, process.pid);
  input.end();
  await bridge.close();
});
