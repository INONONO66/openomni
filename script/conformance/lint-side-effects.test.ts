import { describe, expect, test } from "bun:test";
import { validateSideEffectRules } from "../lint-side-effects";

const sessionMessagesPath = "packages/ledger/src/session/messages.ts";

function sessionMessageSource(operations: string): string {
  return `
export function addMessage() {
  ${operations}
}
export function addPart() {
  adapter.part.set(messageID, part);
  Storage.publishObservation(Event.Updated, { info: updated });
}
export function nextFunction() {}
`;
}

describe("side-effect ordering gate", () => {
  test("requires publication after both addMessage storage writes", () => {
    const valid = sessionMessageSource(`
      adapter.message.set(sessionID, message);
      adapter.session.set(sessionID, updated);
      Storage.publishObservation(Event.Updated, { info: updated });
    `);
    expect(validateSideEffectRules(sessionMessagesPath, valid)).toEqual([]);

    const inverted = sessionMessageSource(`
      Storage.publishObservation(Event.Updated, { info: updated });
      adapter.message.set(sessionID, message);
      adapter.session.set(sessionID, updated);
    `);
    expect(validateSideEffectRules(sessionMessagesPath, inverted)).toHaveLength(2);
  });
});
