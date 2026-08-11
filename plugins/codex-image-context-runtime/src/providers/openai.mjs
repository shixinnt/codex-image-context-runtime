import { MAX_IMAGE_BYTES, MAX_INSPECTION_BYTES, MAX_INSPECTION_CHARS } from "../constants.mjs";
import { RuntimeError } from "../errors.mjs";

const BASE_URL = "https://api.openai.com/v1";
const GENERATION_MODEL = "gpt-image-2";
const VISION_MODEL = "gpt-5.6";
const GENERATION_RESPONSE_MAX_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64 * 1024;
const VISION_RESPONSE_MAX_BYTES = 256 * 1024;

function apiKey(env) {
  const value = env?.OPENAI_API_KEY;
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{8,512}$/.test(value)) throw new RuntimeError("OPENAI_API_KEY_MISSING", "OpenAI API key is unavailable");
  return value;
}

function headers(env) {
  return {
    Authorization: `Bearer ${apiKey(env)}`,
    "Content-Type": "application/json"
  };
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function safeRequestId(response) {
  const value = response?.headers?.get?.("x-request-id");
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

async function parseSuccessJson(response, maxBytes) {
  const contentLength = response?.headers?.get?.("content-length");
  if (typeof contentLength === "string" && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await response?.body?.cancel?.().catch?.(() => {});
    throw new RuntimeError("PROVIDER_RESPONSE_TOO_LARGE", "provider response exceeded its byte budget", { dispatchStarted: true });
  }
  const chunks = [];
  let total = 0;
  try {
    if (response?.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          total += chunk.length;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new RuntimeError("PROVIDER_RESPONSE_TOO_LARGE", "provider response exceeded its byte budget", { dispatchStarted: true });
          }
          chunks.push(chunk);
        }
      } finally {
        reader.releaseLock?.();
      }
    } else throw new RuntimeError("PROVIDER_RESPONSE_INVALID", "provider response body is not a readable byte stream", { dispatchStarted: true });
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)));
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    await response?.body?.cancel?.().catch?.(() => {});
    throw new RuntimeError("PROVIDER_RESPONSE_INVALID", "provider returned invalid JSON", { dispatchStarted: true });
  }
}

function validateEncodedImage(encoded) {
  const maxEncodedLength = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4;
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > maxEncodedLength || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new RuntimeError("PROVIDER_RESPONSE_INVALID", "provider returned invalid image data", { dispatchStarted: true });
  }
  return encoded;
}

function extractResponseText(payload) {
  let result = typeof payload?.output_text === "string" ? payload.output_text.trim() : "";
  if (result.length === 0) {
    const fragments = [];
    for (const item of Array.isArray(payload?.output) ? payload.output : []) {
      for (const content of Array.isArray(item?.content) ? item.content : []) {
        if (typeof content?.text === "string") fragments.push(content.text);
        else if (typeof content?.output_text === "string") fragments.push(content.output_text);
      }
    }
    result = fragments.join("\n").trim();
  }
  if (result.length === 0) throw new RuntimeError("PROVIDER_RESPONSE_INVALID", "provider returned no inspection text", { dispatchStarted: true });
  if (result.length > MAX_INSPECTION_CHARS || Buffer.byteLength(result, "utf8") > MAX_INSPECTION_BYTES) throw new RuntimeError("PROVIDER_RESPONSE_TOO_LARGE", "provider inspection text exceeded its budget", { dispatchStarted: true });
  return result;
}

async function checkedFetch(fetchImpl, url, options) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch {
    throw new RuntimeError("PROVIDER_OUTCOME_UNKNOWN", "provider request outcome is unknown", { dispatchStarted: true });
  }
  if (!response?.ok) {
    await response?.body?.cancel?.().catch?.(() => {});
    const status = Number.isInteger(response?.status) ? response.status : null;
    throw new RuntimeError("PROVIDER_REJECTED", `provider rejected request${status ? ` with HTTP ${status}` : ""}`, { definitive: true, dispatchStarted: true });
  }
  return response;
}

export function createOpenAIProvider({ fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 180_000, generationModel = GENERATION_MODEL, visionModel = VISION_MODEL } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl must be a function");
  return Object.freeze({
    name: "openai",
    generationModel,
    visionModel,
    async generate({ prompt, size, quality, signal, onCheckpoint }) {
      const authHeaders = headers(env);
      await onCheckpoint({ dispatch_state: "dispatch_started", model: generationModel });
      const response = await checkedFetch(fetchImpl, `${BASE_URL}/images/generations`, {
        method: "POST",
        headers: authHeaders,
        redirect: "error",
        signal: requestSignal(signal, timeoutMs),
        body: JSON.stringify({ model: generationModel, prompt, n: 1, size, quality, output_format: "png" })
      });
      const payload = await parseSuccessJson(response, GENERATION_RESPONSE_MAX_BYTES);
      const encoded = validateEncodedImage(payload?.data?.[0]?.b64_json);
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length <= 0 || bytes.length > MAX_IMAGE_BYTES) {
        throw new RuntimeError("PROVIDER_RESPONSE_TOO_LARGE", "provider image exceeded its byte budget", { dispatchStarted: true });
      }
      await onCheckpoint({ dispatch_state: "result_available", model: generationModel });
      return { bytes, media_type: "image/png", model: generationModel, request_id: safeRequestId(response) };
    },
    async inspect({ bytes, mediaType, prompt, mode, signal, onCheckpoint }) {
      const authHeaders = headers(env);
      const imageDataUrl = `data:${mediaType};base64,${bytes.toString("base64")}`;
      const instruction = mode === "qa"
        ? `Perform bounded visual QA. Separate observations, failures, uncertainty, and next human review. ${prompt}`
        : `Inspect this image. Return concise observations and uncertainty only. ${prompt}`;
      await onCheckpoint({ dispatch_state: "dispatch_started", model: visionModel });
      const response = await checkedFetch(fetchImpl, `${BASE_URL}/responses`, {
        method: "POST",
        headers: authHeaders,
        redirect: "error",
        signal: requestSignal(signal, timeoutMs),
        body: JSON.stringify({
          model: visionModel,
          input: [{ role: "user", content: [
            { type: "input_text", text: instruction },
            { type: "input_image", image_url: imageDataUrl, detail: "low" }
          ] }]
        })
      });
      const payload = await parseSuccessJson(response, VISION_RESPONSE_MAX_BYTES);
      const text = extractResponseText(payload);
      await onCheckpoint({ dispatch_state: "result_available", model: visionModel });
      return { text, model: visionModel, request_id: safeRequestId(response) };
    }
  });
}
