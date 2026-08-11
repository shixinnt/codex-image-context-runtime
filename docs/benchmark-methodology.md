# Benchmark Methodology: Serialized MCP Result Payload Proxy

## Question being measured

How many UTF-8 bytes are present in JSON-serialized MCP tool results when an image-heavy control loop returns image bytes inline, compared with returning a compact artifact reference and bounded text handoff?

The metric is:

```text
sum(Buffer.byteLength(JSON.stringify(toolResult), "utf8"))
```

It is intentionally named a **payload proxy**. It is useful for detecting accidental image-byte transport and unbounded result growth, but it is not a direct model-context measurement.

## Default deterministic scenario

The default scenario creates:

- 20 modeled jobs;
- one 1 MiB deterministic PNG-shaped payload in each modeled completed result;
- a 512-byte synthetic text handoff per job;
- a fixed unsigned 32-bit seed (`20260811`); and
- three MCP tool results per job: accepted, completed, and handoff.

The benchmark builds the bytes in memory. It does not read private assets, inspect environment credentials, access the network, or call a real image Provider.

## Compared transports

### Naive inline-image baseline

The completed result includes a standard MCP-style image content block:

```json
{
  "type": "image",
  "mimeType": "image/png",
  "data": "<base64>"
}
```

This is a deliberately naive comparison implementation. It is **not** a measurement or characterization of Codex's native image implementation.

### Reference-only candidate

The candidate contains the same status text and JSON metadata, but the completed result contains only:

- Job ID and status;
- a relative artifact reference;
- a relative handoff reference;
- SHA-256;
- media type; and
- artifact byte count.

The image content block is omitted. Accepted and handoff results are identical in both transports, so the modeled variable is whether generated media bytes cross the MCP result boundary.

## Reproducibility

Run the default scenario and enforce its conservative gates:

```powershell
node benchmark/context-payload.mjs --verify
```

Produce JSON suitable for review or release evidence:

```powershell
node benchmark/context-payload.mjs --verify --json
```

The report deliberately excludes wall-clock time, operating-system paths, host identifiers, current timestamps, and machine metadata. Given the same script and arguments, its measured byte counts are deterministic.

The v0.1 reference report is committed at [`../benchmark/results/v0.1.0-payload-proxy.json`](../benchmark/results/v0.1.0-payload-proxy.json). A test compares that file with a fresh default run so stale evidence fails CI.

Supported arguments:

```text
--jobs <1..1000>
--image-bytes <8..33554432>
--handoff-bytes <0..16384>
--seed <0..4294967295>
--json
--verify
```

## Conservative claim gates

The default verifier requires all of the following:

| Gate | Threshold |
|---|---:|
| Serialized result reduction | at least 99% |
| Largest reference-only result | at most 32 KiB |
| Reference-only size delta, 64 KiB to 4 MiB image | at most 128 bytes |
| Inline image blocks in candidate | 0 |
| Network and real Provider calls | 0 |

The scaling sweep checks a 64 KiB, 1 MiB, and 4 MiB synthetic image. The candidate may change by a few bytes because the decimal `byte_size` field changes length; it must not scale with the artifact itself.

## Claim wording permitted by this benchmark

When the default verifier passes, a release may say:

> In the included synthetic 20 × 1 MiB benchmark, the reference-only transport reduced JSON-serialized MCP tool-result bytes by more than 99% compared with the included naive inline-image MCP baseline.

The following disclaimer must remain adjacent:

> This is a deterministic transport-payload proxy, not a measurement of Codex tokens, latency, memory use, responsiveness, or native image handling. Explicitly opening an image in Codex can still add visual context.

## What this benchmark does not prove

It does not prove that:

- Codex will never slow down;
- model token use falls by the same percentage;
- task latency or memory use improves by a stated amount;
- the plugin's production MCP server enforces its result-size boundary;
- media bytes are correctly persisted, recovered, or protected on disk;
- Job restart, recovery, or idempotency behavior is correct; or
- a visual-analysis result has the same semantic quality as direct image inspection.

Those properties require independent contract and integration tests against the actual plugin runtime. This self-contained benchmark remains separate so that it cannot silently become dependent on a Provider, local credential, private asset, or unfinished plugin implementation.
