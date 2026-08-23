# packages/protocol/src/ipc

JSON-RPC 2.0-style IPC protocol for coordinator ↔ worker and machine host ↔ machine daemon communication over Unix Domain Sockets.

## Purpose

Defines the locked-in wire contract between the coordinator process and worker processes, and between a machine host and an attached machine daemon. All messages are JSON-serializable. The fixed version field (`v: 2`) rejects mixed-version traffic; generic envelopes remain permissive while `Ipc.Methods` records the current same-version parameter/result schemas.

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
| `machine.attach` | Machine daemon → Machine host | Offer a capability set; the host answers with the enrollment∩offer effective set or a typed refusal. |
| `machine.run_cell` | Machine host → Machine daemon | Run one code cell on the attachment's persistent interpreter under a required deadline. |
| `machine.call_tool` | Machine daemon → Machine host | A `tool.<name>()` call made from inside a running cell, answered by the host's injected tool port. |

## Versioning Policy

The `v` field is a protocol version integer.

- Current version: `v: 2`
- Backward-incompatible changes (field removal, type change, semantic change) require bumping the version
- Additive changes (new optional fields) are allowed without a version bump
- The transport rejects any schema-invalid JSON frame, including a version mismatch, with error code `4000`

## Error Codes

| Code | Meaning |
|------|---------|
| `1000` | Request handler failure or missing handler |
| `4000` | JSON parsed, but the IPC envelope schema (including version) is invalid |
| `4001` | Frame is not valid JSON or exceeds the transport frame cap |

The generic error envelope can carry other numeric codes, but current transport code emits only the codes above. Coordinator worker unavailability is a package-owned `WorkerDeliveryError` with code `worker_unavailable`, not an IPC error response.
