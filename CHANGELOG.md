# Changelog

All notable changes to this project will be documented here.

## Unreleased

- Add an authenticated loopback broker foundation so multiple stdio MCP bridges can share one durable Runtime and global Provider concurrency limit.
- Add cursor-based pagination for bounded Job history traversal.
- Add dry-run-first terminal Job compaction that preserves retired idempotency bindings and compact artifact receipts.
- Add a conservative MCP `server/discover` probe without advertising 2026-07-28 conformance prematurely.

## 0.1.1 - 2026-08-15

- Add original project branding for the README, Codex plugin UI, and GitHub social preview.
- Add a privacy-safe `doctor` command for installation and Runtime diagnostics.
- Accept explicit relative workspace paths in the configuration helper.
- Add privacy, support, troubleshooting, community, and contribution guidance.
- Add repository issue and pull-request templates.
- Expand offline CI to macOS and Node.js 24 while retaining Node.js 22 and Windows coverage.
- Publish richer plugin metadata without adding personal contact information.

## 0.1.0 - 2026-08-11

- Initial public image-only Codex plugin and local MCP runtime.
- Durable generation and inspection jobs with bounded text handoffs.
- Offline mock provider and opt-in OpenAI provider.
- Synthetic serialized-payload benchmark and privacy checks.
- Bounded handling for transient Windows filesystem contention while preserving no-overwrite semantics.
