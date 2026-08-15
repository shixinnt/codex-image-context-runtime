#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startBroker } from "../src/broker.mjs";
import { closedErrorCode } from "../src/errors.mjs";

export function parseBrokerArgs(argv) {
  if (!Array.isArray(argv)) throw new Error("argv must be an array");
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== "--config" || typeof argv[1] !== "string" || !path.isAbsolute(argv[1])) {
    const error = new Error("only --config <absolute-path> is supported");
    error.code = "CONFIG_INVALID";
    throw error;
  }
  return { configPath: path.resolve(argv[1]) };
}

export async function runBroker({ configPath, env = process.env, provider, providerOptions } = {}) {
  const idleTimeoutMs = env.CODEX_IMAGE_CONTEXT_BROKER_IDLE_MS;
  const broker = await startBroker({ configPath, env, provider, providerOptions, idleTimeoutMs });
  let closing = false;
  const handlers = new Map();
  const close = async () => {
    if (closing) return;
    closing = true;
    for (const [signal, handler] of handlers) process.off(signal, handler);
    await broker.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => { void close().finally(() => { process.exitCode = signal === "SIGINT" ? 130 : 143; }); };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return { ...broker, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runBroker(parseBrokerArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "failed", error: closedErrorCode(error, "BROKER_START_FAILED") })}\n`);
    process.exitCode = 1;
  });
}
