# v0.2.0 Validation Receipt

Date: 2026-08-15

This receipt records release-candidate evidence for Image Context Runtime for Codex v0.2.0. All default validation is offline and uses no live Provider credentials or paid API calls.

## Source identity

- Release candidate: `v0.2.0`
- License: Apache-2.0
- Runtime requirement: Node.js 22 or later
- Public MCP tools: 7
- Default Provider: deterministic local mock
- Validated implementation commit and GitHub Actions run: recorded in the final receipt update before tagging

## Local release gates

| Gate | Result |
|---|---:|
| Plugin tests | 45 / 45 passed |
| Repository, benchmark, privacy, and package tests | 18 / 18 passed |
| Shared Broker multi-client/idempotency test | PASS |
| Global Provider concurrency across clients | PASS; maximum 2 |
| Wrong-token and unauthenticated-timeout tests | PASS |
| Concurrent detached Broker autostart | PASS; one owner |
| Shutdown after Provider dispatch | PASS; `needs_review`, no automatic replay |
| Cursor pagination and terminal compaction | PASS |
| Compacted same-intent replay | PASS; original Job, zero redispatch |
| Synthetic payload proxy verification | PASS |
| Public-tree and Git metadata privacy audit | PASS |
| Official Codex plugin validator | PASS |
| Official skill validator | PASS |

## Claims boundary

The checked-in benchmark remains a deterministic comparison of serialized MCP result payload shapes. It is not a Codex token, latency, memory, responsiveness, or native image benchmark.

The loopback Broker is authenticated and bounded, but it is not a sandbox against another process running as the same operating-system user. Compaction minimizes eligible durable Job bodies but is not secure erasure and does not delete workspace artifacts.

Full MCP 2026-07-28 and Tasks conformance are not advertised.

## Cross-platform CI and install verification

The final receipt update records the Windows, Ubuntu, macOS, Node.js 24, fresh-install, and v0.1.1 upgrade evidence after the release-candidate commit is published.
