import { ActorRegistry, PersonStore } from "@openomni/ledger";
import type { PlainValue, SessionTransition } from "@openomni/protocol";
import { authorityDomainRevisions } from "../authority/approval";

function operationDomainRevisions(
  operation: PlainValue | undefined,
): Readonly<Record<string, number>> | undefined {
  if (operation !== null && typeof operation === "object" && !Array.isArray(operation)) {
    if (operation.op === "contact_promote" && typeof operation.actorId === "string")
      return authorityDomainRevisions(ActorRegistry, {
        operation: { op: operation.op, actorId: operation.actorId },
      });
    if (
      operation.op === "endpoint_merge" &&
      typeof operation.endpointId === "string" &&
      typeof operation.toActorId === "string"
    )
      return authorityDomainRevisions(ActorRegistry, {
        operation: {
          op: operation.op,
          endpointId: operation.endpointId,
          toActorId: operation.toActorId,
        },
      });
    if (operation.op === "person_declare") return personDomainRevisions(operation.args);
  }
}

function personDomainRevisions(
  args: PlainValue | undefined,
): Readonly<Record<string, number>> | undefined {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const manifest = args.manifest;
    if (
      manifest !== null &&
      typeof manifest === "object" &&
      !Array.isArray(manifest) &&
      typeof manifest.id === "string"
    )
      return { [manifest.id]: PersonStore.get(manifest.id)?.revision ?? -1 };
  }
}

/** Product read-back injected into the generic request owner, including dormant answers. */
export function requestDomainRevisions(
  request: SessionTransition.Request,
): Readonly<Record<string, number>> {
  if (Object.keys(request.domainRevisions).length === 0) return {};
  const input = request.parsedInput;
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const revisions = operationDomainRevisions(input.operation);
    if (revisions !== undefined) return revisions;
  }
  throw new Error(`unrecognized request domain preconditions: ${request.requestId}`);
}
