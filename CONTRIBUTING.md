# Contributing

Thank you for helping improve Image Context Runtime for Codex.

## Project scope

The initial public release focuses on context-bounded image generation, image inspection, durable local jobs, resumable status, and small text-only MCP results. Video execution and domain-specific production policy are outside the initial scope.

Before proposing a large feature, open an issue describing the user problem, the proposed public contract, and its context, privacy, cost, and portability implications.

## Development requirements

- Node.js 22
- Git
- No provider credential is required for the default test suite
- Optional live services must remain opt-in

Run the complete offline release gates before opening a pull request:

```sh
npm run check
```

The default suite must not make network requests or dispatch paid jobs. Use dependency injection and deterministic fake providers in tests.

## Pull request checklist

- Keep changes limited to the public image-runtime problem.
- Add or update tests for public behavior and failure boundaries.
- Do not commit personal data, private project terminology, machine-specific user directories, credentials, provider responses, generated media, or runtime state.
- Keep MCP results bounded and text-only; return references and job identifiers instead of media payloads.
- Preserve idempotency and make cost-incurring operations explicit.
- Document new external programs or services in `THIRD_PARTY_SERVICES.md`.
- Run the repository privacy scanner before committing and again against the final Git history.

## Licensing contributions

Unless explicitly stated otherwise, a contribution intentionally submitted to this project is licensed under the Apache License, Version 2.0. Submit only work that you have the right to license. Retain applicable third-party notices and identify modified third-party files in the pull request.

Do not add a contributor's personal contact information to repository files. GitHub issues, pull requests, and private security advisories are the project communication channels.

The privacy gate also requires commit and tag identities to use a GitHub-provided `users.noreply.github.com` address. Enable **Keep my email addresses private** in GitHub before contributing.
