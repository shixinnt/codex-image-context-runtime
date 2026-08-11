# Architecture

## Product boundary

Image Context Runtime for Codex is distributed as one Codex plugin containing:

- one workflow skill;
- one bundled stdio MCP server;
- one local durable image-job runtime;
- an offline mock Provider and an optional OpenAI Provider.

The public GitHub repository is also a Codex repository marketplace so users can add it by Git source.

## Data flow

~~~text
User intent
   |
   v
Codex + bundled skill
   |
   | small JSON arguments: prompt or workspace-relative image ref
   v
Local MCP server
   |
   | durable Job ID
   v
Job store and worker
   |
   +--> Mock Provider (default, offline)
   |
   +--> OpenAI Provider (explicit opt-in)
   |
   +--> runtime-written workspace artifacts + runtime-owned handoffs
   |
   v
Bounded public result: text blocks + small JSON metadata
~~~

## Closed public boundary

A public tool result may contain:

- Job ID and status;
- task type;
- relative artifact and handoff refs;
- SHA-256, MIME, byte size, and dimensions;
- a small sanitized diagnostic;
- a bounded text handoff.

It may not contain:

- image, audio, or resource MCP content blocks;
- Buffer, typed-array, binary, data-URL, or base64 media;
- absolute paths;
- API keys, authorization headers, or raw Provider responses;
- plaintext idempotency keys.

The entire MCP result is measured as UTF-8 JSON and must remain within 32 KiB. Handoff text is limited to 16 KiB.

## Storage

Runtime state lives outside the plugin source tree:

1. <code>CODEX_IMAGE_CONTEXT_HOME</code>, when set;
2. the Codex-provided plugin data directory, when available;
3. a platform-neutral user data directory fallback.

Job records, handoffs, idempotency claims, and output reservations are separate Runtime records. Generated artifacts are written to configured workspace-relative paths. Writes use atomic no-overwrite or create-or-replace patterns as appropriate.

On filesystems that support hard links, a generated artifact is fully written and synced to a temporary file before an exclusive no-overwrite publish. Some Windows, SMB, or removable-volume filesystems reject hard links; v0.1 then uses an exclusive destination write that still prevents overwriting an existing file, but a process or host crash during that final write can leave a partial destination. Restart reconciliation treats an existing destination conservatively rather than automatically redispatching a paid request.

### Exclusive worker in v0.1

One Runtime directory permits one active MCP worker. Startup serializes acquisition and stale takeover with an atomic guard, then acquires a durable PID-and-token lock before reconciling jobs. Another live process fails closed; a stale lock whose owner PID no longer exists can be recovered. An indeterminate acquisition guard is never removed automatically. This prevents a second Codex task from classifying a first task's live dispatch as an interrupted job.

Parallel Codex tasks must use distinct Runtime directories in v0.1. A shared multi-client broker or durable worker-lease design is deferred until it has its own failure and authentication tests.

## Workspace binding

Image inspection accepts only files under configured workspace roots. Configuration is performed outside the MCP tool surface. Tool callers cannot select a new root.

Generation artifacts are written under the selected fixed workspace root. Output names are sanitized relative paths, never absolute paths. v0.1 has no separate configured output directory or Runtime artifact directory.

## Restart behavior

- Completed jobs remain queryable and are not re-executed.
- Queued jobs that never reached Provider dispatch can be resumed.
- A synchronous Provider request interrupted after dispatch has ambiguous cost and output state. It becomes <code>needs_review</code> instead of being automatically repeated.
- Future asynchronous Provider adapters may implement external-ID resume without changing the public tool contract.

## Provider boundary

The default Provider is deterministic and offline. The OpenAI Provider is loaded only when explicitly configured and reads its API key from the process environment. Provider response bodies remain private Runtime data and are reduced to receipts, short analysis text, or sanitized diagnostics.

## Non-goals for v0.1

- Video generation.
- A hosted public MCP service.
- A universal claim about Codex latency or token usage.
- Provider-level resume for APIs without an external Job ID.
- Multiple simultaneous MCP workers sharing one Runtime directory.
- Automatic human aesthetic approval.
