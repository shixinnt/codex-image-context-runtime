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

On filesystems that support hard links, a generated artifact is fully written and synced to a temporary file before an exclusive no-overwrite publish. Some Windows, SMB, or removable-volume filesystems reject hard links; the Runtime then uses an exclusive destination write that still prevents overwriting an existing file, but a process or host crash during that final write can leave a partial destination. Restart reconciliation treats an existing destination conservatively rather than automatically redispatching a paid request.

Windows can also briefly deny rename or exclusive-open operations while security software or indexing inspects a new file. The Runtime retries only `EPERM`, `EBUSY`, and `EACCES`: ordinary operations use a fixed approximately 1.5-second budget, while atomic replacement of frequently updated state files uses a separate approximately five-second budget. It never retries `EEXIST`, so transient-error handling cannot turn a no-overwrite operation into a replacement write.

### Shared broker in v0.2

One Runtime directory permits one Broker-owned Runtime worker. Each Codex task uses a thin stdio MCP bridge authenticated through an owner-only descriptor to the IPv4-loopback Broker. Startup serializes acquisition and stale takeover with an atomic guard, then acquires a durable PID-and-token lock before reconciling jobs. Concurrent bridge autostart converges on one owner; losing candidates exit before dispatch.

Authentication time, per-client in-flight requests, broker response buffering, request frames, and bridge backpressure are bounded. The same-user local process boundary is not a sandbox: another process able to read the Runtime directory can read durable prompts and the Broker token. Remote and LAN transport are not supported.

## Workspace binding

Image inspection accepts only files under configured workspace roots. Configuration is performed outside the MCP tool surface. Tool callers cannot select a new root.

Generation artifacts are written under the selected fixed workspace root. Output names are sanitized relative paths, never absolute paths. v0.2 has no separate configured output directory or Runtime artifact directory.

## Restart behavior

- Completed jobs remain queryable and are not re-executed.
- Queued jobs that never reached Provider dispatch can be resumed.
- A synchronous Provider request interrupted after dispatch has ambiguous cost and output state. It becomes <code>needs_review</code> instead of being automatically repeated.
- Future asynchronous Provider adapters may implement external-ID resume without changing the public tool contract.

## Provider boundary

The default Provider is deterministic and offline. The OpenAI Provider is loaded only when explicitly configured and reads its API key from the process environment. Provider response bodies remain private Runtime data and are reduced to receipts, short analysis text, or sanitized diagnostics.

## Non-goals for v0.2

- Video generation.
- A hosted public MCP service.
- A universal claim about Codex latency or token usage.
- Provider-level resume for APIs without an external Job ID.
- Multiple simultaneous MCP workers sharing one Runtime directory.
- Automatic human aesthetic approval.
