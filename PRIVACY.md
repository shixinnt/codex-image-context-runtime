# Privacy

Image Context Runtime for Codex is a local-first workflow component. It does not include project telemetry, analytics, advertising, or an account system.

## Data kept on the local machine

The configured Runtime directory can contain:

- job state and dispatch checkpoints;
- prompts and inspection questions;
- relative input and output references;
- bounded text handoffs and artifact receipts; and
- idempotency and output-reservation records.

Generated images are written to configured workspace-relative output paths. The Runtime does not return provider image bytes, data URLs, or base64 media through its public MCP results.

Treat both the Runtime directory and generated workspace artifacts as project data. Version 0.1.1 has no automatic retention or secure-deletion policy; records remain until the operator removes them while the worker is stopped. Filesystem deletion may not be secure erasure on every storage device.

## Credentials

The optional OpenAI provider reads `OPENAI_API_KEY` from the process environment. The configuration helper does not write the key to its configuration file. Do not paste credentials into prompts, issues, logs, or repository files.

## Network behavior

The default mock provider is offline and deterministic. When the OpenAI provider is explicitly enabled, authorized prompts and input images required for the requested operation are sent to the OpenAI API. That processing is governed by the provider's current terms, privacy policy, pricing, and data controls.

The Runtime does not make a local operation offline merely because image bytes stay outside MCP results.

## Diagnostics and reports

`npm run doctor` reports only version, provider, model names, workspace identifiers, credential availability, and lock state. It does not print credentials, prompts, media, or filesystem paths.

Before sharing any output, review it yourself. Use synthetic reproduction data where possible. Report suspected vulnerabilities through the repository's private **Report a vulnerability** flow rather than a public issue.

## Scope

This policy describes version 0.1.1 of this independent open-source project. It does not replace the privacy terms of Codex, OpenAI APIs, GitHub, an operating system, or another service used alongside it.
