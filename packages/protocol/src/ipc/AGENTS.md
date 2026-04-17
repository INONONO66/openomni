# packages/protocol/src/ipc

JSON-RPC 2.0-style IPC protocol for coordinator ↔ worker communication over Unix Domain Sockets.

## Purpose

Defines the locked-in wire contract between the coordinator process and worker processes. All messages are JSON-serializable. Version field (`v`) enables future breaking-change detection.

## Message Types

| Type | Description |
|------|-------------|
| `request` | Bidirectional call expecting a `response`. Has `id`. |
| `response` | Reply to a `request`. Carries `result` or `error`. |
| `notification` | Fire-and-forget. No `id`, no reply expected. |

## Method Table

| Method | Direction | Description |
|--------|-----------|-------------|
| `coordinator.spawn_run` | Coordinator → Worker | Spawn a new agent run on the worker. Injects credentials and permissions. |
| `coordinator.cancel_run` | Coordinator → Worker | Cancel an in-progress run by runId. |
| `coordinator.check_permission` | Coordinator → Worker (reply) | Response to worker's tool permission query. |
| `worker.ready` | Worker → Coordinator | Worker process has started and is ready to accept runs. |
| `worker.heartbeat` | Worker → Coordinator | Periodic liveness + resource report. |
| `worker.run_started` | Worker → Coordinator | Notify that a run has begun execution. |
| `worker.run_completed` | Worker → Coordinator | Notify run terminal state (succeeded/failed/cancelled/interrupted). |
| `worker.tool_call` | Worker → Coordinator | Request coordinator to execute a tool call on behalf of the run. |
| `worker.state_update` | Worker → Coordinator | Emit a fine-grained state event (turn_start, tool_start, etc.). |
| `worker.request_restart` | Worker → Coordinator | Worker requests graceful restart (e.g. memory threshold exceeded). |

## Versioning Policy

The `v` field is a protocol version integer.

- Current version: `v: 1`
- Backward-incompatible changes (field removal, type change, semantic change) require bumping to `v: 2`
- Additive changes (new optional fields) are allowed without a version bump
- Version mismatch should cause the receiver to reject the message with error code `4000`

## Error Codes

| Code | Meaning |
|------|---------|
| `1000` | Internal error (unhandled exception in handler) |
| `2000` | Method not found |
| `3000` | Invalid params (Zod parse failure) |
| `4000` | Protocol version mismatch |
| `5000` | Run not found |
| `5001` | Run already completed |
| `5002` | Worker not ready |
| `6000` | Permission denied |
