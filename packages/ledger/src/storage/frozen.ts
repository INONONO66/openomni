import type { NamedError } from "@openomni/protocol";

/**
 * S2 duplicate-logic audit — shared frozen-store write refusal. The frozen
 * ledger stores (#510 D2a PendingAsk, #548 PendingInteraction, #510 D2b
 * WorkerRunState) each refuse every retired write method by throwing their
 * own typed `NamedError` whose data carries the pinned `code`, the refused
 * `method`, and a store-specific message. This helper builds that
 * `frozenWrite(method): never` thrower once; each store supplies its error
 * constructor, pinned code, and message template, so error-class ownership,
 * data codes, and message text stay byte-for-byte identical to the
 * hand-rolled originals. The refused-method vocabulary is inferred from the
 * error constructor's `data.method`, keeping the FrozenError data the single
 * owner of that vocabulary (#498 C4).
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
