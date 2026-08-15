import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRuntimeConfig } from "./config.mjs";
import { closedErrorCode, fail } from "./errors.mjs";
import { createMcpDispatcher } from "./mcp-service.mjs";
import { ImageContextRuntime } from "./runtime.mjs";
import { atomicWriteJson, readJsonFileBounded, retryTransientFs } from "./safety.mjs";

const BROKER_SCHEMA = "codex-image-context-broker-v1";
const BROKER_PROTOCOL = "broker-v1";
const MAX_BROKER_REQUEST_BYTES = 128 * 1024;
const MAX_AUTH_BYTES = 4 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const TOKEN = /^[a-f0-9]{64}$/;

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function safeInteger(value, { min, max, fallback }) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function brokerDescriptorPath(config) {
  return path.join(config.runtime_dir, "broker.json");
}

function validateDescriptor(value, config) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("BROKER_DESCRIPTOR_INVALID", "broker descriptor is invalid");
  if (value.schema !== BROKER_SCHEMA || value.protocol !== BROKER_PROTOCOL) fail("BROKER_DESCRIPTOR_INVALID", "broker descriptor contract is invalid");
  if (!Number.isInteger(value.pid) || value.pid <= 0) fail("BROKER_DESCRIPTOR_INVALID", "broker process identity is invalid");
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65_535) fail("BROKER_DESCRIPTOR_INVALID", "broker port is invalid");
  if (typeof value.token !== "string" || !TOKEN.test(value.token)) fail("BROKER_DESCRIPTOR_INVALID", "broker token record is invalid");
  if (value.config_hash !== config.config_hash) fail("BROKER_CONFIG_MISMATCH", "the live broker uses a different configuration");
  return value;
}

export async function readBrokerDescriptor(config) {
  try {
    return validateDescriptor(await readJsonFileBounded(brokerDescriptorPath(config), 16 * 1024), config);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "BROKER_CONFIG_MISMATCH" || error?.code === "BROKER_DESCRIPTOR_INVALID") throw error;
    fail("BROKER_DESCRIPTOR_INVALID", "broker descriptor is unreadable");
  }
}

function constantTimeTokenMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function attachBoundedLineReader(socket, { maxBytes, onLine, onOverflow }) {
  let pending = "";
  socket.setEncoding("utf8");
  const onData = (chunk) => {
    pending += chunk;
    if (Buffer.byteLength(pending, "utf8") > maxBytes) {
      socket.off("data", onData);
      onOverflow();
      return;
    }
    for (;;) {
      const boundary = pending.indexOf("\n");
      if (boundary < 0) break;
      const line = pending.slice(0, boundary).replace(/\r$/, "");
      pending = pending.slice(boundary + 1);
      if (line.length > 0) onLine(line);
      if (Buffer.byteLength(pending, "utf8") > maxBytes) {
        socket.off("data", onData);
        onOverflow();
        return;
      }
    }
  };
  socket.on("data", onData);
  return () => socket.off("data", onData);
}

async function removeOwnedDescriptor(config, descriptor) {
  const descriptorPath = brokerDescriptorPath(config);
  try {
    const current = validateDescriptor(await readJsonFileBounded(descriptorPath, 16 * 1024), config);
    if (current.pid === descriptor.pid && current.token === descriptor.token) {
      await retryTransientFs(() => fs.rm(descriptorPath, { force: true }));
    }
  } catch {
    // A missing, malformed, or replaced descriptor is never removed blindly.
  }
}

export async function startBroker({
  configPath,
  env = process.env,
  provider,
  providerOptions,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  host = "127.0.0.1"
} = {}) {
  if (host !== "127.0.0.1") fail("BROKER_BIND_INVALID", "broker must bind to IPv4 loopback");
  const normalizedIdleMs = safeInteger(idleTimeoutMs, { min: 50, max: 300_000, fallback: DEFAULT_IDLE_TIMEOUT_MS });
  const config = await loadRuntimeConfig({ configPath, env });
  const runtime = new ImageContextRuntime(config, { provider, providerOptions });
  await runtime.initialize();
  const dispatch = createMcpDispatcher({ runtime });
  const token = crypto.randomBytes(32).toString("hex");
  const sockets = new Set();
  let descriptor = null;
  let closePromise = null;
  let idleTimer = null;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    let authenticated = false;
    let detachReader;
    const rejectConnection = (error = "broker_auth_failed") => {
      socket.end(`${JSON.stringify({ type: "error", error })}\n`);
    };
    detachReader = attachBoundedLineReader(socket, {
      maxBytes: MAX_BROKER_REQUEST_BYTES,
      onOverflow: () => rejectConnection(authenticated ? "broker_request_too_large" : "broker_auth_failed"),
      onLine: (line) => {
        if (!authenticated) {
          if (Buffer.byteLength(line, "utf8") > MAX_AUTH_BYTES) return rejectConnection();
          const hello = parseJsonLine(line);
          if (!hello || hello.type !== "auth" || hello.protocol !== BROKER_PROTOCOL || hello.config_hash !== config.config_hash || !constantTimeTokenMatch(hello.token, token)) {
            return rejectConnection();
          }
          authenticated = true;
          socket.write(`${JSON.stringify({ type: "ready", protocol: BROKER_PROTOCOL })}\n`);
          return;
        }
        const message = parseJsonLine(line);
        if (!message) {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
          return;
        }
        void dispatch(message).then((response) => {
          if (response && !socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
        }).catch(() => {
          if (!socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: "Internal error" } })}\n`);
        });
      }
    });
    socket.once("close", () => {
      detachReader?.();
      sockets.delete(socket);
      scheduleIdleClose();
    });
    socket.once("error", () => {});
  });

  const close = async () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
      if (descriptor) await removeOwnedDescriptor(config, descriptor);
      await runtime.close();
    })();
    return closePromise;
  };

  const scheduleIdleClose = () => {
    if (closePromise || sockets.size > 0 || idleTimer) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (sockets.size === 0 && runtime.active.size === 0) void close();
      else scheduleIdleClose();
    }, normalizedIdleMs);
    idleTimer.unref?.();
  };

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port: 0, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") fail("BROKER_START_FAILED", "broker address is unavailable");
    descriptor = {
      schema: BROKER_SCHEMA,
      protocol: BROKER_PROTOCOL,
      pid: process.pid,
      port: address.port,
      token,
      config_hash: config.config_hash,
      started_at: new Date().toISOString()
    };
    await atomicWriteJson(brokerDescriptorPath(config), descriptor);
    scheduleIdleClose();
    return { config, runtime, server, descriptor, close, closed: () => closePromise };
  } catch (error) {
    await close();
    throw error;
  }
}

function connectSocket(descriptor, config, { timeoutMs = 2_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: descriptor.port });
    let pending = "";
    const timer = setTimeout(() => finish(Object.assign(new Error("broker connection timed out"), { code: "BROKER_UNAVAILABLE" })), timeoutMs);
    const finish = (error) => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(socket);
    };
    const onConnect = () => socket.write(`${JSON.stringify({ type: "auth", protocol: BROKER_PROTOCOL, token: descriptor.token, config_hash: config.config_hash })}\n`);
    const onError = () => finish(Object.assign(new Error("broker connection failed"), { code: "BROKER_UNAVAILABLE" }));
    const onData = (chunk) => {
      pending += chunk;
      if (Buffer.byteLength(pending, "utf8") > MAX_AUTH_BYTES) return finish(Object.assign(new Error("broker authentication failed"), { code: "BROKER_AUTH_FAILED" }));
      const boundary = pending.indexOf("\n");
      if (boundary < 0) return;
      const response = parseJsonLine(pending.slice(0, boundary).replace(/\r$/, ""));
      if (!response || response.type !== "ready" || response.protocol !== BROKER_PROTOCOL) {
        return finish(Object.assign(new Error("broker authentication failed"), { code: "BROKER_AUTH_FAILED" }));
      }
      finish();
    };
    socket.setEncoding("utf8");
    socket.once("connect", onConnect);
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

export async function connectToBroker(config, options = {}) {
  const descriptor = await readBrokerDescriptor(config);
  if (!descriptor) fail("BROKER_UNAVAILABLE", "broker descriptor is unavailable");
  return connectSocket(descriptor, config, options);
}

function startDetachedBroker({ configPath, env, brokerScriptPath }) {
  const args = [brokerScriptPath];
  if (configPath) args.push("--config", configPath);
  const child = spawn(process.execPath, args, {
    detached: true,
    env,
    stdio: "ignore",
    windowsHide: true
  });
  child.once("error", () => {});
  child.unref();
}

export async function ensureBroker({
  configPath,
  env = process.env,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  brokerScriptPath = fileURLToPath(new URL("../broker/server.mjs", import.meta.url))
} = {}) {
  const config = await loadRuntimeConfig({ configPath, env });
  try {
    return { config, socket: await connectToBroker(config) };
  } catch (error) {
    const code = closedErrorCode(error, "BROKER_UNAVAILABLE");
    if (!new Set(["BROKER_UNAVAILABLE", "ECONNREFUSED", "ECONNRESET"]).has(code)) throw error;
  }
  startDetachedBroker({ configPath, env, brokerScriptPath });
  const timeout = safeInteger(startupTimeoutMs, { min: 500, max: 30_000, fallback: DEFAULT_STARTUP_TIMEOUT_MS });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(100);
    try {
      return { config, socket: await connectToBroker(config, { timeoutMs: 500 }) };
    } catch (error) {
      const code = closedErrorCode(error, "BROKER_UNAVAILABLE");
      if (code === "BROKER_CONFIG_MISMATCH" || code === "BROKER_DESCRIPTOR_INVALID" || code === "BROKER_AUTH_FAILED") throw error;
    }
  }
  fail("BROKER_UNAVAILABLE", "shared Runtime broker did not become ready");
}
