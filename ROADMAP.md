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
- Windows and Linux CI.

## v0.2 candidates

- Pagination and retention controls for long-running job histories.
- Authenticated multi-client broker or durable worker leases for shared Runtime directories.
- Provider interface conformance suite.
- Reference-image editing with bounded file and hash contracts.
- macOS CI.
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
