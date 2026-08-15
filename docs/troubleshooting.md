# Troubleshooting

This guide applies to version 0.2.0. Commands are run from a local clone of the repository.

## Run the privacy-safe doctor

```sh
npm run doctor
npm run doctor -- --json
```

If configuration is stored at a nonstandard location:

```sh
npm run doctor -- --config "path-to-config.json"
```

The report intentionally omits absolute paths, credentials, prompts, and media. Review any output before posting it publicly.

## `config_required`

No valid configuration was found. Stop Codex, then create one:

```sh
npm run configure -- --workspace "path-to-your-project" --provider mock
```

Relative workspace paths resolve from the current directory. Custom configuration and Runtime paths must be absolute.

## `config_exists`

The helper refuses to replace an existing configuration by default. Inspect the current setup first. If replacement is intentional, stop the active worker and pass `--force`. When changing provider or workspace boundaries, prefer a new Runtime directory so active or ambiguous state is not mixed.

## `openai_api_key_missing`

The OpenAI provider is configured, but the Codex process cannot read `OPENAI_API_KEY`. Set the environment variable outside the repository, then start or restart Codex from an environment that inherits it. Never put the key in the configuration JSON.

## `runtime_already_running`

Version 0.2.0 permits one Broker-owned Runtime worker while multiple authenticated stdio bridges share it. If this error appears during ordinary Codex use, run `npm run doctor -- --json`; a live Broker-owned lock is normal, while an unavailable Broker or leftover acquisition guard requires investigation. Do not delete a live worker's lock.

## `broker_unavailable`

The stdio bridge could not authenticate to the descriptor or start one Broker within the bounded startup interval. Stop Codex tasks using this configuration, run the privacy-safe doctor, and verify that the Runtime directory is writable by the current user. A malformed or configuration-mismatched descriptor fails closed and is never deleted blindly.

## `runtime_lock_guard_present`

The acquisition guard makes lock takeover fail closed. First verify that no MCP worker is using the Runtime directory. Only then remove the empty `runtime.lock.guard` directory. If worker ownership is uncertain, leave it in place and use a new Runtime directory.

## `needs_review`

The Runtime cannot prove whether a provider dispatch or artifact publication completed safely. Inspect the job receipt and target output before resuming. Do not submit the same paid intent under a new idempotency key merely to bypass review; that can duplicate cost.

## `wait_timeout`

The wait call reached its bounded timeout; it does not prove that the job failed. Query the Job ID again. If the worker exited, restart it and follow the returned reconciliation state.

## Output already exists or is reserved

The Runtime never overwrites an existing destination and permits at most one dispatch for a reserved output. Choose a new relative output path, or resolve the earlier Job first. Do not manually remove reservations while a worker is active.

## Windows filesystem contention

Antivirus, indexing, and network or removable filesystems can temporarily block exclusive file operations. The Runtime uses bounded operation-specific retries and then fails closed. Prefer a local filesystem, check directory permissions, and avoid placing Runtime state in a heavily synchronized directory.

## Node.js or plugin command is unavailable

Confirm Node.js 22 or later and a Codex build with plugin support:

```sh
node --version
codex plugin --help
```

Then update the local clone, reinstall the marketplace entry, restart Codex, and run the doctor again.

## Still blocked

Follow [SUPPORT.md](../SUPPORT.md). Share the release, OS, Node and Codex versions, provider mode, bounded error code, and a synthetic reproduction. Do not upload the Runtime directory or private project data.
