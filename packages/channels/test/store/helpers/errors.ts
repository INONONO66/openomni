import { expect } from "bun:test";
import type { PlainValue } from "@openomni/protocol";

export function expectNamedFailure(
  operation: () => void,
  errorName: string,
  fields: Record<string, PlainValue>,
): void {
  const expectedFields: object = expect.objectContaining(fields);
  expect(operation).toThrow(
    expect.objectContaining({
      name: errorName,
      [Symbol.for("openomni.protocol.namedError")]: errorName,
      data: expectedFields,
    }),
  );
}
