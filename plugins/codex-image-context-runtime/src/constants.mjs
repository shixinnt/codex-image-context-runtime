export const MCP_ENVELOPE_MAX_BYTES = 32 * 1024;
export const VERSION = "0.2.0";
export const HANDOFF_MAX_BYTES = 16 * 1024;
export const PUBLIC_RESULT_MAX_BYTES = 12 * 1024;
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_INSPECTION_CHARS = 12_000;
export const MAX_INSPECTION_BYTES = 12 * 1024;
export const MAX_PROVIDER_CONCURRENCY = 2;
export const PROTOCOL_VERSION = "1.0";
export const JOB_SCHEMA = "codex-image-context-job-v1";
export const RESULT_SCHEMA = "codex-image-context-result-v1";
export const CONFIG_SCHEMA = "codex-image-context-config-v1";
export const JOB_STATUSES = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
  "needs_review",
  "cancelled"
]);
export const TERMINAL_STATUSES = new Set(["completed", "failed", "needs_review", "cancelled"]);
