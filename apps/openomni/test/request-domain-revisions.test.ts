import { afterEach, beforeEach, expect, test } from "bun:test";
import { PersonStore, Storage } from "@openomni/ledger";
import { type PlainValue, SessionTransition } from "@openomni/protocol";
import { requestDomainRevisions } from "../src/tools/core/request-domain-revisions";

beforeEach(() => Storage.initialize({ dbPath: ":memory:" }));
afterEach(() => Storage.reset());

function request(
  parsedInput: PlainValue,
  domainRevisions: Record<string, number>,
): SessionTransition.Request {
  return SessionTransition.Request.parse({
    requestId: "request",
    sessionId: "session",
    turnId: null,
    callId: "call",
    mode: "approval",
    parsedInput,
    inputHash: "input",
    effectHash: "effect",
    generation: 1,
    toolsGeneration: 1,
    toolsHash: "tools",
    systemHash: "system",
    domainRevisions,
    deadline: 1000,
    expectedResponders: ["owner"],
    correlation: {},
    allowedActions: ["report_result"],
    bindingDigest: "binding",
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "open",
    outcome: null,
    createdAt: 1,
  });
}

const manifest = {
  id: "person:sunwoo",
  kind: "human" as const,
  trustTier: "manager" as const,
  endpoints: [] as { channel: string; externalId: string }[],
};

test("person_declare reads back the live Person revision, absent as -1", () => {
  const declare = request(
    { operation: { op: "person_declare", args: { manifest } } },
    { [manifest.id]: -1 },
  );
  expect(requestDomainRevisions(declare)).toEqual({ [manifest.id]: -1 });
  PersonStore.put({
    ...manifest,
    displayName: "Sunwoo",
    revision: 4,
    createdBy: "resident",
    updatedAt: 1,
  });
  expect(requestDomainRevisions(declare)).toEqual({ [manifest.id]: 4 });
});

test("a request without domain preconditions reads back nothing", () => {
  expect(requestDomainRevisions(request({ operation: { op: "status", args: {} } }, {}))).toEqual(
    {},
  );
});

test("domain preconditions on an unrecognized operation fail closed", () => {
  const inputs: PlainValue[] = [
    { operation: { op: "channel_declare", args: {} } },
    { operation: { op: "person_declare", args: { manifest: "not-a-manifest" } } },
    "not-an-input",
  ];
  for (const parsedInput of inputs) {
    expect(() => requestDomainRevisions(request(parsedInput, { persons: 1 }))).toThrow(
      "unrecognized request domain preconditions: request",
    );
  }
});
