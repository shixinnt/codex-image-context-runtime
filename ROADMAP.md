# Roadmap

The roadmap is evidence-driven. Features move only after their public boundary, failure behavior, and offline tests are defined.

## v0.1 - Image context boundary

- Codex plugin and repository marketplace.
- Durable text-to-image and image-inspection jobs.
- Bounded text-only MCP content plus compact JSON metadata.
- Offline deterministic Provider for tests and demos.
- Optional OpenAI Provider.
- Idempotent submission, restart reconciliation, and explicit ambiguous-dispatch review.
- Synthetic serialized-payload benchmark.
- Fresh-clone installation and offline validation.
- Privacy-safe configuration diagnostics.
- Windows, Linux, and macOS CI.

## v0.2 - Shared Runtime and bounded history

- Authenticated loopback broker shared by multiple thin stdio MCP bridges.
- Global Provider concurrency, idempotency, and output reservations across Codex tasks.
- Bounded authentication timeout, per-client in-flight work, response buffering, and stdio backpressure.
- Cursor pagination and explicit privacy-minimizing compaction with retired idempotency tombstones.
- Conservative `server/discover` fallback without advertising unverified MCP 2026-07-28 conformance or Tasks.

## v0.3 candidates

- Provider interface conformance suite.
- Reference-image editing with bounded file and hash contracts.
- Release-archive privacy verification.
- Fully crash-atomic artifact publication on filesystems without hard-link support.

## Later candidates

- Asynchronous Provider adapters with external Job ID resume.
- Optional local vision backends.
- Configurable artifact lifecycle and secure deletion.
- Additional image formats after parser and metadata review.
- Public plugin-directory packaging if deployment requirements fit the local-first boundary.

## Not currently planned

- Returning image bytes through MCP results.
- Automatic aesthetic approval.
- Hidden paid Provider fallback.
- Caller-selected workspace or Runtime roots.
- Claims that the plugin eliminates all Codex slowdown.
- Video generation before the image-only contracts have stable external use.
