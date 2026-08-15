import { MCP_ENVELOPE_MAX_BYTES, RESULT_SCHEMA, VERSION } from "./constants.mjs";
import { safeConfigSummary } from "./config.mjs";
import { closedErrorCode, fail } from "./errors.mjs";
import { assertBoundedPublicJson, assertExactKeys, assertSafeJobId, assertSafePublicText, byteLengthJson, isPlainObject } from "./safety.mjs";

const JOB_ID_SCHEMA = { type: "string", pattern: "^img_[A-Za-z0-9_-]{8,96}$" };
const SUPPORTED_MCP_PROTOCOLS = new Set(["2025-06-18", "2025-03-26"]);
const DEFAULT_MCP_PROTOCOL = "2025-06-18";
const RESULT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "job_id", "status", "task_type", "workspace_id", "artifacts", "provider_state", "handoff_ref", "diagnostic", "resumable", "created_at", "updated_at"],
  properties: {
    schema: { const: RESULT_SCHEMA },
    job_id: JOB_ID_SCHEMA,
    status: { enum: ["queued", "running", "completed", "failed", "needs_review", "cancelled"] },
    task_type: { enum: ["generation", "inspection"] },
    workspace_id: { type: "string" },
    artifacts: { type: "array", maxItems: 1, items: { type: "object" } },
    provider_state: { type: "string" },
    handoff_ref: { type: ["string", "null"] },
    diagnostic: { type: ["object", "null"] },
    resumable: { type: "boolean" },
    created_at: { type: "string" },
    updated_at: { type: "string" },
    deduped: { type: "boolean" }
  }
};

const COMMON_SUBMIT = {
  workspace_id: { type: "string", description: "One fixed configured workspace ID." },
  prompt: { type: "string", minLength: 1, maxLength: 16384, description: "Bounded text prompt. Never include media or credentials." },
  prompt_ref: { type: "string", minLength: 1, maxLength: 512, description: "Workspace-relative UTF-8 prompt file." },
  idempotency_key: { type: "string", minLength: 8, maxLength: 256 }
};

export const MCP_TOOLS = Object.freeze([
  {
    name: "submit_image_generation",
    title: "Submit Image Generation",
    description: "Queue one durable image generation job. Media bytes stay behind the MCP boundary; the result contains only text receipts and relative refs. In OpenAI provider mode, the prompt is sent to the remote official OpenAI Image API and the request may incur API cost.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { ...COMMON_SUBMIT, output_path: { type: "string", minLength: 1, maxLength: 512 }, size: { enum: ["1024x1024", "1024x1536", "1536x1024"] }, quality: { enum: ["low", "medium", "high"] } },
      required: ["output_path", "size", "quality", "idempotency_key"],
      oneOf: [
        { required: ["prompt"], not: { required: ["prompt_ref"] } },
        { required: ["prompt_ref"], not: { required: ["prompt"] } }
      ]
    },
    outputSchema: RESULT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "submit_image_inspection",
    title: "Submit Image Inspection",
    description: "Queue one inspection or visual-QA job for a workspace-relative image. Input media is read inside the runtime and never returned through MCP. In OpenAI provider mode, the image and prompt are sent to the remote official OpenAI Responses API and the request may incur API cost.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { ...COMMON_SUBMIT, image_path: { type: "string", minLength: 1, maxLength: 512 }, mode: { enum: ["inspect", "qa"], default: "inspect" } },
      required: ["image_path", "idempotency_key"],
      not: { required: ["prompt", "prompt_ref"] }
    },
    outputSchema: RESULT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  ...[
    ["get_image_job", "Get Image Job", "Read one bounded durable job result.", true, false],
    ["get_image_handoff", "Get Image Handoff", "Read one bounded text-only handoff. No media content blocks are returned.", true, false],
    ["resume_image_job", "Resume Image Job", "Resume only a job proven not to have reached Provider dispatch. In OpenAI provider mode, resuming may send the prompt or image to the remote official OpenAI API and may incur API cost.", false, false],
    ["cancel_image_job", "Cancel Image Job", "Cancel before dispatch, or fail safe to needs_review after dispatch.", false, true]
  ].map(([name, title, description, readOnlyHint, destructiveHint]) => ({
    name, title, description,
    inputSchema: { type: "object", additionalProperties: false, properties: { job_id: JOB_ID_SCHEMA }, required: ["job_id"] },
    outputSchema: name === "get_image_handoff"
      ? { type: "object", additionalProperties: false, required: ["job", "handoff_ref", "handoff_text"], properties: { job: RESULT_OUTPUT_SCHEMA, handoff_ref: { type: "string" }, handoff_text: { type: "string", maxLength: 16384 } } }
      : RESULT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint, destructiveHint, idempotentHint: true, openWorldHint: name === "resume_image_job" }
  })),
  {
    name: "list_image_jobs",
    title: "List Image Jobs",
    description: "List bounded text-only job summaries without loading any media.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 25, default: 20 }, status: { enum: ["queued", "running", "completed", "failed", "needs_review", "cancelled"] }, workspace_id: { type: "string" } }
    },
    outputSchema: { type: "object", additionalProperties: false, required: ["count", "jobs"], properties: { count: { type: "integer" }, jobs: { type: "array", maxItems: 25, items: RESULT_OUTPUT_SCHEMA } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
]);

function success(text, structuredContent) {
  assertSafePublicText(text, "MCP content text");
  return assertBoundedPublicJson({ content: [{ type: "text", text }], structuredContent }, MCP_ENVELOPE_MAX_BYTES, "MCP tool result");
}

function errorResult(error, stage = "tool_call") {
  const code = closedErrorCode(error).toLowerCase();
  return {
    isError: true,
    content: [{ type: "text", text: `Image runtime tool failed: ${code}.` }],
    structuredContent: { status: "error", error: code, stage }
  };
}

function oneJobId(args) {
  assertExactKeys(args, { required: ["job_id"] }, "tool arguments");
  return assertSafeJobId(args.job_id);
}

export function createMcpService(runtime) {
  return Object.freeze({
    async call(name, args = {}) {
      try {
        if (name === "submit_image_generation") {
          const result = await runtime.submitGeneration(args);
          return success(`Image generation job ${result.job_id} is ${result.status}.`, result);
        }
        if (name === "submit_image_inspection") {
          const result = await runtime.submitInspection(args);
          return success(`Image inspection job ${result.job_id} is ${result.status}.`, result);
        }
        if (name === "get_image_job") {
          const result = await runtime.getJob(oneJobId(args));
          return success(`Image job ${result.job_id} is ${result.status}.`, result);
        }
        if (name === "get_image_handoff") {
          const result = await runtime.getHandoff(oneJobId(args));
          return success(`Loaded bounded handoff for ${result.job.job_id}.`, result);
        }
        if (name === "resume_image_job") {
          const result = await runtime.resumeJob(oneJobId(args));
          return success(`Image job ${result.job_id} is ${result.status}.`, result);
        }
        if (name === "cancel_image_job") {
          const result = await runtime.cancelJob(oneJobId(args));
          return success(`Image job ${result.job_id} is ${result.status}.`, result);
        }
        if (name === "list_image_jobs") {
          assertExactKeys(args, { optional: ["limit", "status", "workspace_id"] }, "tool arguments");
          const result = await runtime.listJobs(args);
          return success(`Found ${result.count} bounded image jobs.`, result);
        }
        fail("TOOL_NOT_FOUND", "tool is unavailable");
      } catch (error) {
        return assertBoundedPublicJson(errorResult(error), MCP_ENVELOPE_MAX_BYTES, "MCP error result");
      }
    }
  });
}

export function createMcpDispatcher({ runtime, service = createMcpService(runtime) } = {}) {
  return async function dispatch(message) {
    if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return { jsonrpc: "2.0", id: isPlainObject(message) && message.id !== undefined ? message.id : null, error: { code: -32600, message: "Invalid Request" } };
    }
    const { id, method, params } = message;
    if (id === undefined) return null;
    let response;
    if (method === "initialize") {
      const protocolVersion = SUPPORTED_MCP_PROTOCOLS.has(params?.protocolVersion) ? params.protocolVersion : DEFAULT_MCP_PROTOCOL;
      response = { jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "codex-image-context-runtime", title: "Codex Image Context Runtime", version: VERSION, description: "Durable, context-bounded image generation and inspection.", websiteUrl: "https://github.com/shixinnt/codex-image-context-runtime" }, instructions: "Use relative refs and Job IDs. Media bytes, base64, raw Provider responses, credentials, and absolute paths are forbidden in public results.", runtime: safeConfigSummary(runtime.config) } };
    } else if (method === "ping") response = { jsonrpc: "2.0", id, result: {} };
    else if (method === "tools/list") response = { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
    else if (method === "tools/call") response = { jsonrpc: "2.0", id, result: await service.call(params?.name, params?.arguments ?? {}) };
    else response = { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    if (byteLengthJson(response) > MCP_ENVELOPE_MAX_BYTES) {
      return { jsonrpc: "2.0", id: id ?? null, result: errorResult(Object.assign(new Error("envelope too large"), { code: "MCP_ENVELOPE_TOO_LARGE" }), "dispatch") };
    }
    return response;
  };
}
