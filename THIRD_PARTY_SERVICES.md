# Third-Party Services and Programs

This repository is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by OpenAI. Product and service names belong to their respective owners.

## Default behavior

The default test suite uses deterministic local fakes. It does not require credentials, submit paid jobs, or intentionally contact a media provider. Installing the plugin does not by itself authorize a live provider call.

## OpenAI image and vision APIs

An operator may explicitly configure the OpenAI API for image generation or visual inspection. The operator is responsible for:

- obtaining and protecting credentials;
- reviewing the provider's current terms, privacy policy, model availability, and pricing;
- confirming that submitted prompts and images are authorized for that provider;
- understanding the provider's retention and content-handling policy; and
- monitoring and limiting cost.

Credentials are runtime configuration. They must not be written to the repository, durable job receipts, MCP results, or logs.

## Adding another service

A new provider integration must remain optional, must be disabled in the default test suite, and must document credentials, network destinations, cost behavior, input handling, response retention, cancellation limits, and applicable service terms. Do not vendor a provider SDK, command-line tool, model, or binary until its license and required notices have been reviewed.
