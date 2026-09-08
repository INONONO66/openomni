import { PersonStore } from "@openomni/ledger";
import type { PlainValue, SessionTransition } from "@openomni/protocol";
import { ContactOperation, contactDomainRevisions } from "./contact-mutations";

function operationDomainRevisions(
  operation: PlainValue | undefined,
): Readonly<Record<string, number>> | undefined {
  if (operation !== null && typeof operation === "object" && !Array.isArray(operation)) {
    const contact = ContactOperation.safeParse(operation);
    if (contact.success) return contactDomainRevisions(contact.data);
    if (operation.op === "contact_add") return personDomainRevisions(operation.args);
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
