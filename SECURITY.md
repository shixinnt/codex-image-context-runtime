# Security Policy

## Supported versions

Security fixes are provided for the latest tagged release. The default branch may contain unreleased changes and is not a supported production release.

## Report a vulnerability privately

Use the repository's **Report a vulnerability** button to open a private GitHub Security Advisory. Do not include credentials, private images, provider responses, local paths, or other sensitive data in a public issue.

If a credential may have been exposed, revoke or rotate it before preparing the report. Use synthetic reproduction data whenever possible.

Useful reports include:

- the affected release and operating system;
- the smallest reproducible sequence of calls;
- the expected and observed security boundary;
- sanitized logs or bounded text receipts; and
- whether provider dispatch or filesystem writes occurred.

## Security boundaries

Treat any of the following as a security defect:

- credentials, media bytes, or raw provider responses appearing in MCP results or logs;
- access outside configured input and output roots;
- caller-controlled workspace or runtime roots bypassing fixed configuration;
- unbounded provider downloads, command output, or text handoffs;
- duplicate paid dispatch after an idempotent retry;
- a second Broker worker bypassing the exclusive Runtime ownership lock;
- unauthenticated, non-loopback, unbounded, or configuration-mismatched Broker access;
- unexpected network access outside an explicitly enabled provider; or
- live provider calls during the default offline test suite.

Provider credentials must be supplied at runtime and must never be committed. Generated media and durable job state remain local unless a configured provider must receive an authorized input to perform the requested operation.

The v0.2 Broker listens only on `127.0.0.1`, authenticates bridges with a random token and configuration hash stored in an owner-only Runtime descriptor, and bounds unauthenticated time, request frames, in-flight work, and response buffering. It is not designed to isolate mutually untrusted processes running as the same operating-system user.

## Public disclosure

Please allow time for investigation and a coordinated fix before public disclosure. After a fix is released, the advisory may acknowledge reporters using only the attribution they explicitly approve.
