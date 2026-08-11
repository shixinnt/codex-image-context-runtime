import crypto from "node:crypto";
import zlib from "node:zlib";
import { inspectImageFormat } from "../image-format.mjs";
import { sha256 } from "../safety.mjs";
import { RuntimeError } from "../errors.mjs";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function deterministicPng({ width, height, seed }) {
  const digest = crypto.createHash("sha256").update(seed).digest();
  const row = Buffer.alloc(1 + width * 4);
  row[0] = 0;
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 4] = digest[0];
    row[2 + x * 4] = digest[1];
    row[3 + x * 4] = digest[2];
    row[4 + x * 4] = 255;
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function dimensions(size) {
  const [width, height] = String(size).split("x").map(Number);
  return { width, height };
}

function sleep(delayMs, signal) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new RuntimeError("PROVIDER_ABORTED", "mock provider was aborted", { dispatchStarted: true }));
    }, { once: true });
  });
}

export function createMockProvider({ delayMs = 0 } = {}) {
  return Object.freeze({
    name: "mock",
    generationModel: "mock-image-v1",
    visionModel: "mock-vision-v1",
    async generate({ prompt, size, quality, signal, onCheckpoint }) {
      await onCheckpoint({ dispatch_state: "dispatch_started", model: "mock-image-v1" });
      await sleep(delayMs, signal);
      if (signal?.aborted) throw new RuntimeError("PROVIDER_ABORTED", "mock provider was aborted", { dispatchStarted: true });
      const { width, height } = dimensions(size);
      const bytes = deterministicPng({ width, height, seed: `${prompt}\n${size}\n${quality}` });
      await onCheckpoint({ dispatch_state: "result_available", model: "mock-image-v1" });
      return { bytes, media_type: "image/png", model: "mock-image-v1", request_id: null };
    },
    async inspect({ bytes, relativePath, prompt, mode, signal, onCheckpoint }) {
      await onCheckpoint({ dispatch_state: "dispatch_started", model: "mock-vision-v1" });
      await sleep(delayMs, signal);
      if (signal?.aborted) throw new RuntimeError("PROVIDER_ABORTED", "mock provider was aborted", { dispatchStarted: true });
      const format = inspectImageFormat(bytes, relativePath);
      const dimensionsText = format.dimensions ? `${format.dimensions.width} x ${format.dimensions.height}` : "not decoded";
      const text = [
        `Offline deterministic ${mode === "qa" ? "visual QA" : "image inspection"}.`,
        `- Media type: ${format.media_type}`,
        `- Byte size: ${bytes.length}`,
        `- SHA-256: ${sha256(bytes)}`,
        `- Dimensions: ${dimensionsText}`,
        `- Prompt fingerprint: ${sha256(prompt).slice(0, 23)}`,
        "- No media bytes were returned through MCP."
      ].join("\n");
      await onCheckpoint({ dispatch_state: "result_available", model: "mock-vision-v1" });
      return { text, model: "mock-vision-v1", request_id: null };
    }
  });
}
