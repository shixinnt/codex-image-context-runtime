[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/shixinnt-codex-image-context-runtime-badge.png)](https://mseep.ai/app/shixinnt-codex-image-context-runtime)

[简体中文](README.zh-CN.md)

<p align="center">
  <img src="plugins/codex-image-context-runtime/assets/logo.svg" alt="Image Context Runtime logo" width="144">
</p>

# Image Context Runtime for Codex

**Keep image-heavy Codex workflows responsive, resumable, and context-bounded.**

![A conceptual workstation comparison of image-heavy Codex tasks with and without Image Context Runtime](docs/assets/image-context-runtime-workstation-comparison.png)

*Fictional concept interface—not an actual Codex UI or a measured context, token, speed, or latency benchmark.*

Image Context Runtime for Codex is an experimental open-source Codex plugin backed by a durable local MCP runtime. It runs image generation and inspection as persisted jobs, keeps provider-returned media bytes behind the public MCP boundary, and returns only bounded text results, hashes, relative references, and Job IDs.

Use it when Codex is:

- creating short-drama character sheets, location concepts, or storyboards;
- producing image assets for websites and slide decks;
- organizing image-heavy news, books, screenshots, or research;
- generating many visual variations or running repeated visual QA.

> **Important:** This project reduces one source of context pressure. It does not claim that Codex can never slow down, that images use zero tokens, or that explicitly opening an image adds no visual context.

The plugin does not patch or intercept Codex's built-in image features or other image tools. The bounded boundary applies only when Codex uses this plugin's MCP tools and follows its bundled skill.

## What it is

**User-facing shape:** a Codex plugin.

**Execution shape:** a bundled local MCP server plus a durable image-job runtime.

~~~text
Codex skill
    |
    v
bounded MCP tools
    |
    v
durable local jobs ----> optional OpenAI API
    |
    +----> configured-workspace image artifacts
    |
    +----> bounded text handoffs, hashes, refs, and Job IDs
~~~

The plugin is the installable workflow. MCP is the tool boundary. The Runtime owns Job state, controls media transfer, and writes generated artifacts only to configured workspace-relative paths.

## Public v0.2 scope

- Text-to-image jobs.
- Image inspection jobs.
- Durable status and text handoffs.
- Idempotent submission.
- Restart reconciliation and explicit recovery.
- Offline deterministic mock provider.
- Optional OpenAI Image API and Responses API provider.
- Strict public-result budgets with no MCP image, audio, or resource blocks.
- One authenticated loopback broker shared safely by multiple Codex task bridges.
- Cursor-based Job history and explicit privacy-minimizing terminal-record compaction.

Video generation is intentionally out of scope for v0.2.

## Requirements

- Node.js 22 or later.
- Codex desktop app or Codex CLI with plugin support.
- No API key for the default mock provider.
- <code>OPENAI_API_KEY</code> only when the OpenAI provider is explicitly enabled.

## Install and configure

Clone the tagged release, then run the following commands from its root. The configuration helper runs outside Codex, so a local clone is required:

~~~powershell
git clone --depth 1 --branch v0.2.0 https://github.com/shixinnt/codex-image-context-runtime.git
cd codex-image-context-runtime
~~~

~~~powershell
codex plugin marketplace add .
codex plugin add codex-image-context-runtime@codex-image-context-runtime
~~~

The default provider is offline and deterministic, so installing the plugin cannot accidentally spend API credits.

For a first installation, choose **one** Provider configuration. For the offline mock:

~~~powershell
npm run configure -- --workspace "C:\path\to\your\project" --provider mock
~~~

Workspace paths may be absolute or relative to the repository clone's current directory. Custom `--config` and `--runtime-dir` paths must be absolute.

Or, for the optional OpenAI Provider, make the key available to the Codex process and configure OpenAI from the start:

~~~powershell
$env:OPENAI_API_KEY = "set-this-outside-the-repository"
npm run configure -- --workspace "C:\path\to\your\project" --provider openai
~~~

The configuration file stores paths and model choices only. It never stores the API key.

The PowerShell environment assignment applies only to that shell and child processes. Launch Codex CLI from that shell, or use your operating system's environment/credential workflow before starting the desktop app. Restart Codex after configuration or credential changes.

To switch an existing mock setup to OpenAI, first stop the active worker, then replace the config and use a new Runtime directory so in-flight state is not mixed:

~~~powershell
npm run configure -- --workspace "C:\path\to\your\project" --provider openai --runtime-dir "C:\path\to\image-runtime-openai" --force
~~~

Check the installation without exposing local paths or credentials:

~~~powershell
npm run doctor
npm run doctor -- --json
~~~

Preview privacy-minimizing Job-record compaction without changing data:

~~~powershell
npm run compact -- --older-than-days 30 --limit 25 --json
~~~

To apply a bounded batch, stop Codex tasks using the configuration, wait for the Broker to exit, review the dry run, then add `--apply`. Compaction keeps retired idempotency tombstones and compact artifact receipts; it does not delete workspace images or guarantee secure erasure.

For Bash-compatible shells, export the key before starting Codex:

~~~sh
export OPENAI_API_KEY="set-this-outside-the-repository"
npm run configure -- --workspace "/path/to/your/project" --provider openai
~~~

### Update an existing installation

Stop active image jobs, update the clone to the new tag, then refresh the installed plugin cache:

~~~powershell
git fetch --tags
git checkout v0.2.0
codex plugin remove codex-image-context-runtime@codex-image-context-runtime
codex plugin add codex-image-context-runtime@codex-image-context-runtime
~~~

Configuration and Runtime data are outside the clone and are not deleted by reinstalling the plugin. Restart Codex after the update.

## Example prompts

~~~text
Use Image Context Runtime to generate one 1024x1024 storyboard frame.
Keep the image bytes outside this task and return the Job ID.

Inspect images/frame-001.png for composition, continuity, and obvious text defects.
Return only the bounded inspection handoff.
~~~

The bundled skill instructs Codex to submit the job, poll by Job ID, and retrieve the compact handoff instead of asking the MCP server to return pixels.

## Providers

### Mock provider

- Default.
- Offline and deterministic.
- Creates a synthetic PNG for generation jobs.
- Returns metadata-oriented inspection text.
- Validates transport and persistence behavior, not visual quality.

### OpenAI provider

- Opt-in only.
- Uses <code>gpt-image-2</code> by default for image generation.
- Uses <code>gpt-5.6</code> by default for image inspection.
- Model names can be overridden in configuration.
- Media sent to the API is subject to the applicable service terms, pricing, and data controls.

This is an independent open-source project. It is not affiliated with or endorsed by OpenAI.

## Privacy boundary

Public MCP results:

- never contain provider-returned image bytes;
- never contain data URLs or base64 media;
- never contain API keys or raw provider responses;
- use relative artifact and handoff references;
- are capped by a UTF-8 byte budget.

The runtime can still send an image to an explicitly enabled remote provider for inspection. Local runtime ownership is not the same as offline processing.

The local job records persist prompts, inspection questions, relative references, and provider state. Protect the configured Runtime directory as project data.

## v0.2 shared Runtime boundary

Each Codex task receives a thin stdio MCP bridge. Bridges using the same fixed configuration authenticate to one IPv4-loopback broker, which owns the only durable Runtime worker, Provider semaphore, idempotency index, and output reservations. Concurrent bridge startup converges on one broker owner instead of treating another task's live Job as interrupted.

The broker token and configuration hash are stored in an owner-only descriptor in the Runtime directory. Authentication time, per-client in-flight work, response buffering, and stdio-to-socket pressure are bounded. The broker listens only on <code>127.0.0.1</code>; it is not a remote service or a sandbox against another process running as the same operating-system user.

After the last bridge disconnects and active Jobs settle, the broker shuts down after a bounded idle interval. Forced interruption after Provider dispatch remains ambiguous and becomes <code>needs_review</code>; it is never automatically repeated.

See [Architecture](docs/architecture.md), [Tool reference](docs/tool-reference.md), [v0.2 claims](docs/claims-v0.2.md), [Benchmark methodology](docs/benchmark-methodology.md), [v0.2.0 validation receipt](docs/validation-v0.2.0.md), [Troubleshooting](docs/troubleshooting.md), [Privacy](PRIVACY.md), [Support](SUPPORT.md), [Terms](TERMS.md), [Roadmap](ROADMAP.md), [Security](SECURITY.md), [Third-party services](THIRD_PARTY_SERVICES.md), and [Contributing](CONTRIBUTING.md).

## Synthetic payload benchmark

The included benchmark compares:

1. a deliberately naive MCP result that inlines synthetic image bytes; and
2. this runtime's bounded ref/hash/Job-ID result shape.

Run it with:

~~~powershell
npm run benchmark
~~~

This is a deterministic serialized-payload proxy. It is **not** a measurement of Codex tokens, latency, memory usage, or native image handling.

The checked-in v0.1 scenario models 20 jobs with 1 MiB synthetic images:

| Transport | Serialized MCP result bytes | Largest result |
|---|---:|---:|
| Naive inline-image baseline | 27,990,140 | 1,398,617 |
| Reference-only candidate | 27,060 | 739 |

That is a 99.903% reduction for this synthetic result-payload comparison only. See the methodology and reproducible JSON report before quoting it.

## Development

~~~powershell
npm test
npm run benchmark:verify
npm run check:privacy
~~~

All default tests are offline and make zero real provider calls.

## Status

v0.2.0 is an experimental public release. Review the threat model and data path before enabling a paid provider in a sensitive project.

If you try it in a real image-heavy workflow, open a GitHub Discussion with your operating system, Codex surface/version, approximate image workload, and whether a fresh task remained responsive. Report reproducible defects with the issue templates; never upload private Runtime state.

## License

Apache License 2.0. This independent project is not affiliated with or endorsed by OpenAI.
