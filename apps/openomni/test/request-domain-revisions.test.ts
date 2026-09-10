import { afterEach, beforeEach, expect, test } from "bun:test";
import { PersonStore, Storage } from "@openomni/ledger";
import type { PlainValue } from "@openomni/protocol";
import { approvalRequest } from "./helpers/approval-request";
import { requestDomainRevisions } from "../src/tools/core/request-domain-revisions";

beforeEach(() => Storage.initialize({ dbPath: ":memory:" }));
afterEach(() => Storage.reset());

const manifest = {
  id: "person:sunwoo",
  kind: "human" as const,
  trustTier: "manager" as const,
  endpoints: [] as { channel: string; externalId: string }[],
};

test("contact_add reads back the live Person revision, absent as -1", () => {
  const declare = approvalRequest(
    { operation: { op: "contact_add", args: { manifest } } },
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
  expect(
    requestDomainRevisions(approvalRequest({ operation: { op: "status", args: {} } }, {})),
  ).toEqual({});
});

test("domain preconditions on an unrecognized operation fail closed", () => {
  const inputs: PlainValue[] = [
    { operation: { op: "channel_declare", args: {} } },
    { operation: { op: "contact_add", args: { manifest: "not-a-manifest" } } },
    "not-an-input",
  ];
  for (const parsedInput of inputs) {
    expect(() => requestDomainRevisions(approvalRequest(parsedInput, { persons: 1 }))).toThrow(
      "unrecognized request domain preconditions: request",
    );
  }
});
