#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfig } from "../src/config.mjs";
import { closedErrorCode } from "../src/errors.mjs";
import { MCP_ENVELOPE_MAX_BYTES } from "../src/constants.mjs";
import { createMcpDispatcher } from "../src/mcp-service.mjs";
import { ImageContextRuntime } from "../src/runtime.mjs";
import { byteLengthJson } from "../src/safety.mjs";

export function parseServerArgs(argv) {
  if (!Array.isArray(argv)) throw new Error("argv must be an array");
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== "--config" || typeof argv[1] !== "string" || !path.isAbsolute(argv[1])) {
    const error = new Error("only --config <absolute-path> is supported");
    error.code = "CONFIG_INVALID";
    throw error;
  }
  return { configPath: path.resolve(argv[1]) };
}

export async function startMcpServer({ configPath, env = process.env, input = process.stdin, output = process.stdout, provider, providerOptions } = {}) {
  const config = await loadRuntimeConfig({ configPath, env });
  const runtime = new ImageContextRuntime(config, { provider, providerOptions });
  await runtime.initialize();
  const dispatch = createMcpDispatcher({ runtime });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let closePromise = null;
  const signalHandlers = new Map();
  const close = async () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      if (!lines.closed) lines.close();
      await runtime.close();
    })();
    return closePromise;
  };
  lines.once("close", () => { void close(); });
  if (input === process.stdin) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        void close().finally(() => {
          process.exitCode = signal === "SIGINT" ? 130 : 143;
        });
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    if (Buffer.byteLength(line, "utf8") > 128 * 1024) {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      return;
    }
    void dispatch(message).then((response) => {
      if (!response) return;
      const encoded = JSON.stringify(response);
      if (Buffer.byteLength(encoded, "utf8") <= MCP_ENVELOPE_MAX_BYTES) output.write(`${encoded}\n`);
      else output.write(`${JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, result: { isError: true, content: [{ type: "text", text: "Image runtime tool failed: mcp_envelope_too_large." }], structuredContent: { status: "error", error: "mcp_envelope_too_large", stage: "stdio" } } })}\n`);
    }).catch(() => {});
  });
  return {
    runtime,
    lines,
    close
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startMcpServer(parseServerArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "failed", error: closedErrorCode(error, "MCP_START_FAILED") })}\n`);
    process.exitCode = 1;
  });
}
