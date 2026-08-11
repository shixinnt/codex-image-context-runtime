# Public claims for v0.1

This file defines what the project may and may not claim.

## Supported claims

The following claims require the repository tests to pass:

1. Provider-returned media bytes do not cross the public MCP result boundary.
2. Public MCP content blocks are text-only and structured metadata is bounded.
3. Every public tool result is capped at 32 KiB of UTF-8 serialized JSON.
4. Handoffs are capped at 16 KiB of UTF-8 text.
5. Completed jobs survive Runtime restart and remain queryable by Job ID.
6. Replaying the same idempotent request does not create another Provider dispatch.
7. A dispatch with unknown terminal state fails safe into review instead of automatic paid redispatch.
8. The default tests and benchmark make zero network and Provider calls.
9. A second live MCP process targeting the same Runtime directory fails closed before job reconciliation.

## Benchmark claim

The project may report the reduction in JSON-serialized MCP result bytes produced by the included deterministic synthetic benchmark.

The benchmark is a transport-payload proxy. It is not evidence of:

- Codex token savings;
- Codex UI latency;
- memory usage;
- native image-input behavior;
- universal application performance.

## Prohibited claims

Do not claim:

- Codex never becomes slow or stuck.
- Images consume zero context or zero tokens.
- The plugin provides zero-latency image work.
- Explicitly opening an image does not add visual context.
- All Provider calls can resume after interruption.
- Multiple live MCP workers can share one Runtime directory in v0.1.
- Local Runtime ownership means no data leaves the machine.
- A particular speedup or token-saving percentage without a separate reproducible measurement.
- Installing the plugin automatically changes or intercepts Codex's built-in image behavior.
- Artifact publication is crash-atomic on every local, removable, and network filesystem.

## Preferred wording

- reduces context pressure;
- context-bounded image workflow;
- designed to keep long-running image work responsive and recoverable;
- durable control-plane state by Job ID;
- provider media bytes do not cross the MCP result boundary;
- bounded text-only MCP content plus compact JSON metadata.
