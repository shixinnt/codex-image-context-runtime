# Public claims for v0.2

## Supported claims

- Image Context Runtime is an independent Codex plugin backed by a local MCP bridge, an authenticated IPv4-loopback Broker, and one durable image Job Runtime.
- Multiple Codex task bridges using the same fixed configuration share one Broker-owned Runtime, Provider concurrency limit, idempotency index, and output-reservation index.
- Public MCP responses remain text-only and bounded; Provider-returned media bytes are written behind the MCP boundary rather than embedded in MCP results.
- Job history supports bounded cursor pagination.
- The explicit compaction command defaults to a dry run and can replace eligible completed or cancelled Job bodies with privacy-minimized tombstones while retaining retired idempotency bindings and compact artifact receipts.
- Broker authentication time, request frames, per-client in-flight work, response buffering, and stdio backpressure are bounded.
- Interrupted work that may already have reached Provider dispatch becomes `needs_review` instead of being automatically repeated.

## Boundary conditions

- The Broker is local-only, not a remote service or a sandbox against another process running as the same operating-system user.
- Compaction is data minimization, not automatic retention or guaranteed secure erasure.
- Workspace artifacts are governed separately and are not deleted by Job compaction.
- The conservative `server/discover` response advertises only proven legacy protocol revisions. v0.2 does not claim full MCP 2026-07-28 or Tasks conformance.
- The OpenAI Provider is opt-in, may send prompts or images to a remote API, and may incur cost.

## Unsupported claims

- Codex can never slow down or freeze.
- Images consume zero tokens or context.
- The plugin intercepts Codex built-in image tools, attachments, or other MCP servers.
- The synthetic serialized-payload benchmark measures Codex latency, memory, token use, or native image behavior.
- Local Broker transport makes remote Provider processing local.
- Every filesystem provides fully crash-atomic artifact publication.
