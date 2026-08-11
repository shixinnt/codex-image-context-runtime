# v0.1.0 Validation Receipt

Date: 2026-08-11
Scope: public source tree at release candidate `v0.1.0`

## Offline release gates

| Gate | Result |
|---|---:|
| Plugin runtime and hardening tests | 28 / 28 passed |
| Repository, benchmark, packaging, and privacy tests | 15 / 15 passed |
| Deterministic benchmark verifier | PASS |
| Public-tree privacy and secret-shape audit | PASS |
| Codex plugin manifest validator | PASS |
| Codex skill validator | PASS |

The default test suite used Node.js 22, deterministic local Providers, temporary generic fixtures, and zero live Provider calls. The OpenAI adapter was tested with injected local fetch doubles; no credential or network access was required.

## Contracts covered

- text-only, size-bounded MCP results and handoffs;
- image-byte, raw-base64, absolute-path, secret, and raw-response rejection;
- generation and inspection persistence;
- idempotent replay and crash-window recovery;
- output reservation, case aliases, filesystem aliases, and no-overwrite behavior;
- bounded retry of transient Windows filesystem contention without retrying destination-exists errors;
- restart reconciliation and ambiguous-dispatch fail-safe behavior;
- exclusive Runtime ownership and concurrent stale-lock takeover;
- pre-dispatch cancellation and reservation release;
- Provider dispatch concurrency capped at two;
- fixed OpenAI endpoint/request shapes, redirect rejection, bounded response streaming, and closed errors;
- MCP protocol negotiation, notification behavior, EOF shutdown, and Runtime-lock release;
- portable configuration discovery and canonical root isolation.

## Synthetic payload proxy

The checked-in deterministic 20 × 1 MiB scenario measured:

- naive inline-image result transport: 27,990,140 serialized bytes;
- reference-only transport: 27,060 serialized bytes;
- reduction in this proxy: 99.903323%;
- largest reference-only result: 739 bytes;
- candidate growth from 64 KiB to 4 MiB images: 2 bytes.

This is not a Codex token, latency, memory, responsiveness, or native-image benchmark. See [Benchmark methodology](benchmark-methodology.md).

## Reproduce

```powershell
npm run check
```

The repository CI repeats the offline release gates on Windows and Linux with Node.js 22.
