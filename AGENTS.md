# AGENTS.md

This repository is the public, image-only Image Context Runtime for Codex.

## Public boundary

- Do not add personal names, email addresses, machine-specific user paths, private project identifiers, production media, credentials, Provider responses, or copied private Git history.
- Use generic fixtures created at test time.
- Keep video generation and domain-specific governance out of v0.1.
- Keep all default tests offline and free of paid Provider calls.

## Runtime contract

- Provider-returned media bytes remain behind the public MCP boundary.
- Public MCP content blocks are text-only; compact structured JSON is allowed.
- Public results are capped at 32 KiB of UTF-8 serialized JSON.
- Handoffs are capped at 16 KiB of UTF-8 text.
- Public results must not contain data URLs, base64 media, binary values, absolute paths, API keys, authorization headers, raw Provider responses, or plaintext idempotency keys.
- Tool callers cannot configure new workspace roots.

## Changes

- Update tests whenever the public tool catalog changes.
- Run <code>npm test</code>, <code>npm run benchmark:verify</code>, and <code>npm run check:privacy</code>.
- Do not describe the synthetic payload benchmark as a Codex token, latency, memory, or native-image benchmark.
- Do not claim that Codex can never slow down.
