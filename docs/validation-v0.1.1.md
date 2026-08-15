# v0.1.1 Validation Receipt

Date: 2026-08-15

This receipt records release-candidate evidence for Image Context Runtime for Codex v0.1.1. All default validation was offline and used no live provider credentials or paid API calls.

## Source identity

- Release: `v0.1.1`
- License: Apache-2.0
- Runtime requirement: Node.js 22 or later
- Public MCP tools: 7
- Default provider: deterministic local mock

The release tag and commit digest are recorded by the GitHub release after publication. Cross-platform Actions evidence is appended before the tag is created.

## Local release gates

Environment:

- Windows
- Node.js 24.19.0
- Python 3.11.9

Results:

| Gate | Result |
|---|---:|
| Plugin tests | 34 / 34 passed |
| Repository, benchmark, privacy, and package tests | 18 / 18 passed |
| Synthetic payload proxy verification | PASS |
| Public-tree and Git metadata privacy audit | PASS |
| Official Codex plugin validator | PASS |
| Official skill validator | PASS |
| Isolated Codex plugin install and cached-package check | PASS; version 0.1.1 and doctor present |
| Mock configure and privacy-safe doctor smoke | PASS |
| MCP initialize and tool-list smoke | PASS; protocol 2025-06-18, version 0.1.1, 7 tools |

Commands:

```sh
npm run check
python path-to-plugin-validator plugins/codex-image-context-runtime
python path-to-skill-validator plugins/codex-image-context-runtime/skills/image-context-runtime
npm run configure -- --workspace path-to-test-workspace --provider mock
npm run doctor -- --json
```

Validator locations are intentionally described generically because local installation paths are not public release data.

## Claims boundary

The benchmark remains a deterministic comparison of serialized MCP result payload shapes. The checked-in scenario reports a 99.903323% reduction between a deliberately naive inline-media result and the reference-only candidate. It is not a Codex token, latency, memory, responsiveness, or native image benchmark.

The release does not claim that Codex can never slow down, that images consume zero context, that the plugin intercepts native image tools, or that remote Provider processing stays on the local machine.

## Cross-platform CI

The release workflow tests Node.js 22 on Windows, Ubuntu, and macOS, plus Node.js 24 on Ubuntu. The final successful run URL and conclusions will be recorded here before publication.
