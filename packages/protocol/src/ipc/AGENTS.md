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
| `coordinator.bootstrap` | Coordinator → Worker | Authenticate the supervisor connection and deliver worker bootstrap config. |
| `coordinator.spawn_run` | Coordinator → Worker | Spawn a new agent run on the worker. Injects credentials and permissions. |
| `coordinator.cancel_run` | Coordinator → Worker | Cancel an in-progress run by runId. |
| `worker.bootstrap_ready` | Worker → Coordinator | Worker authenticated bootstrap is applied and runs may be accepted. |
| `worker.deliver_message` | Coordinator → Worker | Deliver a follow-up message into an active run's injection queue. |
| `worker.shutdown_idle` | Coordinator → Worker | Ask an idle worker to acknowledge and exit gracefully. |
| `worker.tool_call` | Worker → Coordinator | Request coordinator to execute a tool call on behalf of the run. |
| `worker.tool_call_cancel` | Worker → Coordinator | Abort an in-flight relayed tool call. |
| `worker.tool_call_settled` | Coordinator → Worker | Confirm a relayed tool call fully settled (workspace lock release). |
| `worker.inbound_wait` | Worker → Coordinator | Block on an external answer (resident guidance/approval). |
| `worker.inbound_wait_cancel` | Worker → Coordinator | Abort an in-flight inbound wait. |

## Versioning Policy

The `v` field is a protocol version integer.

- Current version: `v: 2`
- Backward-incompatible changes (field removal, type change, semantic change) require bumping the version
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
