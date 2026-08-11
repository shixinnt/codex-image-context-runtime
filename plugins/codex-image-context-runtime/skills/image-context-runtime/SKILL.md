---
name: image-context-runtime
description: Use for image-heavy Codex work when generated or inspected media should stay behind a bounded MCP boundary and the controlling task should receive only durable Job IDs, hashes, relative references, and compact text handoffs.
---

# Image Context Runtime

Use this workflow for repeated image generation, image inspection, storyboard work, design assets, visual research, or visual QA when returning raw media through the controlling task would add unnecessary context pressure.

## Core boundary

- Treat the local Runtime as the owner of image bytes and durable Job state.
- Do not ask an MCP tool to return an image, data URL, base64 payload, or raw Provider response.
- Keep the controlling task text-only unless the user explicitly asks Codex to open a particular image.
- An explicit image open is a separate visual-context decision; this plugin does not make it free.
- The default mock Provider is offline. A real Provider must be explicitly configured and may incur cost.

## Generate an image

1. Confirm one bounded prompt, output name, size, quality, and stable idempotency key.
2. Call <code>submit_image_generation</code>.
3. Keep the returned <code>job_id</code>.
4. Poll with <code>get_image_job</code>; do not resubmit the same intent.
5. When terminal, call <code>get_image_handoff</code>.
6. Report the relative artifact ref, SHA-256, dimensions, and compact handoff.
7. Do not load the generated image into the controlling task unless the user needs direct visual judgment.

## Inspect an image

1. Use a path under a configured workspace root. Never send inline media.
2. Ask one bounded inspection question.
3. Call <code>submit_image_inspection</code> with a stable idempotency key.
4. Poll by Job ID.
5. Retrieve the bounded inspection handoff.
6. Make clear that the handoff is Provider analysis, not human approval.

## Restart and recovery

- Completed jobs remain queryable by Job ID after restart.
- A queued pre-dispatch job may resume safely.
- A job interrupted after Provider dispatch can enter <code>needs_review</code>.
- Do not automatically redispatch an ambiguous paid request.
- Use <code>resume_image_job</code> only after reviewing its diagnostic and acknowledging possible duplicate cost when the tool requires it.

## Failure behavior

- If workspace roots are not configured, stop and provide the configuration command.
- If a path is absolute, outside the configured roots, traverses upward, or escapes through a symlink, do not work around the rejection.
- If the public-result budget is exceeded, return the bounded diagnostic rather than provider data.
- If another live process owns the Runtime directory, do not delete its lock; stop that worker or use a distinct configuration and Runtime directory.
- Never echo API keys, authorization headers, private configuration, or raw exception bodies.
