# Conversation and message IO

Messages cross one boundary: `sendMessage({to, type, content, replyTo?, deadline?})` and `gateway.ingest(sender, envelope)`. [Gateway Design](gateway-design.md) describes the implementation ownership; [Kernel Contract](kernel-contract.md) is normative. [Implementation Status](implementation-status.md) separates shipped behavior from proposals.

The former Conversation, Lease and engagement lifecycles were removed without replacement. Their design history remains in git, not as an alternate message path.

## Inbound facts and contact identity

A driver authenticates platform origin and submits facts: event id, physical channel/workspace, external addressees, DM status, reply/thread/ancestor metadata, structured payload and rendered text. Only the gateway resolves `(surface, externalId, workspace)` to an actor, derives standing and classifies the addressee. Self-reported roles are not authority.

Owner-declared channel grants remain a ceiling. A personal tier takes precedence over a channel default, never over a blocked channel. Broadcast input remains evidence-only. Default observer standing does not authorize instructions. Blacklist refusal precedes Wait correlation and ordinary surface routing.

Opted-in provisional contact minting is bounded by the existing channel policy and rolling window. It records observed identity, not promoted authority, and stays evidence-only. Durable Person declarations and credentials are owned by [Provisioning and Providers](provisioning-and-providers.md).

## Delivery

Session mail becomes a prompt at atomic inbox commit and passes the receiving session's prompt pre-policy. New child configuration and first mail share that commit. Session delivery has no external receipt classification.

Actor sends use existing grants, exact endpoint resolution, egress budget and stable platform idempotency keys. Their executed values distinguish accepted, rejected and unknown. A committed first contact can create a bounded, endpoint-scoped reply grant. The indexed durable projection survives restart without replaying routing history; endpoint rebinding cannot expand its scope.

A final assistant answer is a separate actor send. A driver never turns a returned handler value into a platform response. WebSocket admission receipts and later message frames are distinct. Rendering and chunking remain provider-owned, after admission.

## Correlation and terminal mail

Explicit reply/message ids, thread ids, token hashes and external conversation ids retain their deterministic Wait precedence. Same-tier ambiguity is refused; structured requested actions remain data for the Wait fold. Physical surface routing is independent of conversation correlation.

A child terminal crosses gateway admission, then atomically appends one parent inbox message preserving final text, terminal kind and original reply binding. Processes transport session ids and committed doorbells; they have no parallel settlement or acknowledgement lifecycle. The parent interprets the returned letter; no task-satisfaction authority is recreated.

Deadlines are durable alarm rows. Answer and timeout compete on one source-action CAS; late replies remain input. Startup expiry is wired. Continuous live alarm dispatch is #947, not a second timer in message IO.

## Approval and remaining proposals

The existing executor consumes typed authenticated approval answers bound to the captured request, input hash and generation. Gateway authentication transports evidence; it does not execute a protected body or invent a policy verdict. Free prose is not approval evidence.

The current approval tool/store and generic channel Wait lifecycle remain until #969. This PR does not implement unified lifecycle replacement, broader contact promotion automation, a new negotiation budget, or a new conversation store. Additional rendering/disclosure UX and first-contact autonomy require their own approved policy changes.
