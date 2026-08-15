# v0.2.0 Validation Receipt

Date: 2026-08-15

This receipt records release evidence for Image Context Runtime for Codex v0.2.0. All default validation is offline and uses no live Provider credentials or paid API calls.

## Source identity

- Release candidate: `v0.2.0`
- License: Apache-2.0
- Runtime requirement: Node.js 22 or later
- Public MCP tools: 7
- Default Provider: deterministic local mock
- Validated implementation commit: `998daf53072327afa8a476a72854219a68107486`
- GitHub Actions run: [31876951701](https://github.com/shixinnt/codex-image-context-runtime/actions/runs/31876951701)
- Local validation environment: Windows, Node.js `24.19.0`, Python `3.11.9`, Codex CLI `0.144.1`

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

## Cross-platform CI

GitHub Actions run `31876951701` completed successfully for the implementation commit on:

- Windows Server 2022 with Node.js 22;
- Ubuntu latest with Node.js 22;
- macOS latest with Node.js 22; and
- Ubuntu latest with Node.js 24.

Each job ran the offline release gates, including tests, the synthetic payload proxy, and the public-tree/privacy audit.

## Fresh-install verification

A clean shallow clone of `feature/v0.2-runtime-broker` at the validated implementation commit was installed into an isolated `CODEX_HOME` with Codex CLI `0.144.1`:

1. the local marketplace was added successfully;
2. the cached plugin resolved to version `0.2.0`;
3. a new mock configuration and Runtime directory were created outside the clone;
4. `doctor --json` returned `status: ok` and version `0.2.0`; and
5. the cached MCP bridge negotiated protocol `2025-06-18`, reported server version `0.2.0`, and returned all 7 tools through the detached Broker.

## v0.1.1 upgrade verification

An isolated installation was first created from the public `v0.1.1` tag and configured with the mock Provider. The source clone was then advanced to the validated v0.2.0 implementation commit, and the plugin was removed and re-added using the documented cache-refresh procedure.

The existing external configuration and Runtime directory remained present. The refreshed cache contained version `0.2.0`; `doctor --json` returned `status: ok`; and the cached MCP bridge negotiated protocol `2025-06-18` with server version `0.2.0`.
