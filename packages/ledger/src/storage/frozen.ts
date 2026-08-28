import type { NamedError } from "@openomni/protocol";

/**
 * Shared frozen-store write refusal: a frozen ledger store (#510 D2b
 * WorkerRunState) refuses every retired write method by throwing its own
 * typed `NamedError` whose data carries the pinned `code`, the refused
 * `method`, and a store-specific message. The store supplies its error
 * constructor, pinned code, and message template. The refused-method
 * vocabulary is inferred from the error constructor's `data.method`, keeping
 * the FrozenError data the single owner of that vocabulary (#498 C4).
 */
export function frozenWriteRefusal<Method extends string, Code extends string>(
  ErrorCtor: new (data: { message: string; code: Code; method: Method }) => NamedError,
  code: Code,
  message: (method: Method) => string,
): (method: Method) => never {
  return (method) => {
    throw new ErrorCtor({ message: message(method), code, method });
  };
}
