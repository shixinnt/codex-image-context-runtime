# Synthetic MCP Result Payload Benchmark

This benchmark compares two deliberately small transport models:

1. a naive MCP result that embeds each generated image as an MCP `ImageContent` base64 block; and
2. an otherwise identical result that returns only text, relative references, hashes, byte counts, and a Job ID.

It is self-contained. It generates deterministic synthetic bytes in memory and makes no network or Provider calls.

## Run

```powershell
node benchmark/context-payload.mjs --verify
```

Print the machine-readable report:

```powershell
node benchmark/context-payload.mjs --verify --json
```

The checked-in default report is [`results/v0.1.0-payload-proxy.json`](results/v0.1.0-payload-proxy.json). The benchmark test verifies that it is still identical to a fresh default run.

Use a smaller smoke scenario:

```powershell
node benchmark/context-payload.mjs --jobs 2 --image-bytes 65536 --handoff-bytes 128
```

## Default claim gates

- at least `99%` fewer serialized MCP tool-result bytes than the included naive inline-image baseline;
- no candidate result larger than `32 KiB`;
- no more than `128` bytes of candidate-result growth when the synthetic image changes from `64 KiB` to `4 MiB`;
- zero inline image blocks on the reference-only path; and
- zero network and real Provider calls.

These gates apply only to the included deterministic payload proxy. See [`../docs/benchmark-methodology.md`](../docs/benchmark-methodology.md) before quoting a result.
