# MCP Tool Reference

The plugin exposes seven bounded tools. Configure fixed workspace roots before starting the MCP server. Tool callers cannot add or change roots.

When the Provider is `mock`, submit tools are offline. When the Provider is `openai`, generation prompts and inspection images are sent to the OpenAI API and may incur cost.

## Submit tools

### `submit_image_generation`

Queues one PNG generation Job.

Required arguments:

- `output_path`: workspace-relative `.png` destination;
- `size`: `1024x1024`, `1024x1536`, or `1536x1024`;
- `quality`: `low`, `medium`, or `high`;
- `idempotency_key`: stable caller-generated key, 8–256 characters.

Provide exactly one of `prompt` or `prompt_ref`. `workspace_id` is optional only when one workspace is configured.

The Runtime refuses to overwrite an existing path. Durable output reservation allows at most one concurrent request for a destination to reach Provider dispatch; competing requests fail closed before dispatch. Reservations conservatively case-fold paths on every platform. Output parents that traverse symlinks or junctions are rejected so two relative refs cannot alias one physical destination.

### `submit_image_inspection`

Queues inspection of one workspace-relative PNG, JPEG, or bounded WebP input.

Required arguments:

- `image_path`: workspace-relative image ref;
- `idempotency_key`: stable caller-generated key, 8–256 characters.

Optional arguments are `workspace_id`, at most one of `prompt` or `prompt_ref`, and `mode` (`inspect` or `qa`). If no prompt is provided, the Runtime uses a bounded technical-inspection prompt.

## Control tools

| Tool | Purpose |
|---|---|
| `get_image_job` | Read one compact Job projection by Job ID. |
| `get_image_handoff` | Read the terminal bounded text handoff. |
| `resume_image_job` | Resume only a queued or provably pre-dispatch failed Job. It may dispatch to a configured remote Provider. |
| `cancel_image_job` | Cancel before dispatch; after dispatch, fail safe to `needs_review`. |
| `list_image_jobs` | List up to 25 compact Job projections with an optional stable cursor, status filter, and workspace ID. |

## Maintenance CLI

`codex-image-context-compact` previews eligible records by default. After stopping Codex and the shared broker, add `--apply` to replace a bounded batch of completed or cancelled Job bodies with privacy-minimized tombstones. Idempotency bindings and compact artifact receipts remain, so replay cannot silently become a new paid dispatch. This is data minimization, not a claim of secure erasure.

## Job states

| State | Meaning |
|---|---|
| `queued` | Persisted and waiting for execution. |
| `running` | Local execution or Provider work is in progress. |
| `completed` | Terminal result is persisted and queryable. |
| `failed` | Terminal failure with a bounded diagnostic. A pre-dispatch failure may be resumable. |
| `needs_review` | Dispatch may have occurred; automatic redispatch is blocked. |
| `cancelled` | Cancelled before Provider dispatch. |

## Public result shape

Submit, status, resume, and cancel calls return a compact Job projection containing:

- Job ID, status, task type, and workspace ID;
- relative artifact and handoff refs;
- artifact SHA-256, media type, byte count, and dimensions when available;
- Provider state;
- bounded diagnostic code and stage;
- resumability and timestamps.

`get_image_handoff` adds at most 16 KiB of text. The complete serialized MCP tool result is capped at 32 KiB. Content blocks are text-only; image bytes, data URLs, raw Provider responses, credentials, absolute paths, and plaintext idempotency keys are forbidden.

## Recovery rule

Never automatically repeat a `needs_review` Job. Review local artifacts and Provider-side evidence, then create a new Job with a new key only when duplicate output or cost is acceptable.
