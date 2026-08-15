# v0.2 Design: Shared Runtime, Retention, and MCP Compatibility

Status: implementation design

## User problem

Version 0.1.1 safely permits only one MCP process per Runtime directory. A second Codex task fails closed because each stdio MCP process currently tries to own, reconcile, and execute the durable Runtime itself.

Version 0.2 should let several Codex tasks use one configured Runtime without creating several Provider workers, duplicating a paid dispatch, or letting one process misclassify another process's live job as interrupted.

## Decision: one local broker, many thin stdio bridges

The Runtime and Provider live in exactly one broker process. Every Codex task still receives its own normal stdio MCP process, but that process becomes a bounded bridge to the broker.

~~~text
Codex task A --- stdio bridge A --+
                                  |
Codex task B --- stdio bridge B --+--> authenticated loopback broker
                                  |         |
Codex task C --- stdio bridge C --+         +--> one ImageContextRuntime
                                            +--> one provider semaphore
                                            +--> one durable JobStore
~~~

This keeps the plugin shape compatible with Codex while moving all reconciliation, job locking, idempotency, output reservation, and Provider concurrency into one process.

## Broker transport and authentication

- Bind only to IPv4 loopback on an operating-system-selected port.
- Publish a bounded broker descriptor in the configured Runtime directory.
- Generate a cryptographically random bearer token and store it only in that descriptor.
- Require a constant-time token and configuration-hash check before accepting MCP messages.
- Apply the existing 128 KiB request and 32 KiB response limits at both bridge and broker boundaries.
- Never include the token, port, PID, or an absolute path in MCP results or public diagnostics.
- Give the descriptor owner-only file permissions where the filesystem supports them.

The local same-user process boundary is not a sandbox. Another process that can read the operator's Runtime directory can also read its durable prompts and broker token. Remote network access is not permitted.

## Startup and ownership

1. A stdio bridge loads the fixed configuration and attempts to authenticate to the published broker.
2. If no live broker answers, the bridge starts a detached broker using the same absolute configuration path and inherited Provider environment.
3. Concurrent bridges may race to start candidates. The existing durable Runtime lock permits exactly one broker to become the worker; losing candidates exit before dispatch.
4. Bridges poll for a short bounded startup interval, then fail closed with a sanitized `broker_unavailable` error.
5. The broker atomically replaces a stale descriptor only after it owns the Runtime lock and is listening.
6. On graceful shutdown, the broker removes only a descriptor whose token and PID still match its own.

## Lifecycle

- A broker stays alive while at least one bridge is connected or a job is active.
- After the last bridge disconnects and all jobs settle, a bounded idle timer closes the broker and releases the Runtime lock.
- A forced broker termination uses the existing restart reconciliation rules: pre-dispatch jobs can be resumed; post-dispatch ambiguity becomes `needs_review`.
- The OpenAI credential is inherited by the broker process that starts first. Changing credentials or Provider configuration requires stopping the broker and restarting Codex.

## Retention design

Deleting a completed job record blindly would break idempotent replay and could make an old paid intent dispatch again. Therefore retention is split into two layers:

1. **Pagination first:** add stable cursor-based listing so long histories do not require returning or sorting an unbounded public result.
2. **Explicit compaction later:** replace eligible terminal job bodies with privacy-minimized tombstones while retaining the Job ID, intent ownership, terminal status, artifact receipt, and a retired idempotency binding. Never silently turn a retired key into a new dispatch.

Automatic secure deletion is not claimed. Workspace artifacts are governed separately from Runtime records.

## MCP 2026-07-28 compatibility

The 2026-07-28 MCP revision removes the mandatory initialize handshake, makes each request self-describing, and adds `server/discover`; long-running Tasks are an opt-in extension. The existing visible Job ID already follows the recommended explicit-handle pattern.

The compatibility sequence is:

1. preserve current Codex stdio support for the 2025-06-18 and 2025-03-26 initialize flows;
2. accept self-contained tool requests without session state;
3. add deterministic `server/discover` metadata for 2026-07-28 clients;
4. do not advertise the Tasks extension until Codex supports it and the extension's conformance cases are covered;
5. keep Image Context Runtime Job IDs as the durable application handle in every protocol revision.

Primary reference: [MCP 2026-07-28 specification announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/).

## Required gates

- Two independent bridge clients can query and submit through one broker.
- Concurrent duplicate idempotency keys cause at most one Provider dispatch.
- Global Provider concurrency remains bounded across all clients.
- Wrong tokens and mismatched configuration hashes are rejected without echoing secrets.
- Concurrent broker startup results in exactly one Runtime owner.
- Broker death before and after Provider dispatch preserves existing reconciliation semantics.
- Windows, Ubuntu, and macOS CI pass with no live Provider calls.
- The public-tree privacy scanner, archive scan, plugin validator, and fresh-install test remain green.

## Non-goals for the first v0.2 implementation

- Remote or LAN broker access.
- Hosted public MCP deployment.
- Multi-user authentication or authorization.
- Returning media through the broker or MCP.
- Automatic deletion of generated workspace artifacts.
- Advertising MCP Tasks before client interoperability is demonstrated.
