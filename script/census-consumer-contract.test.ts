import { expect, test } from "bun:test";
import { censusConsumerFindings, type CensusConsumerRow } from "./check-dead-exports";

function finding(row: CensusConsumerRow) {
  return censusConsumerFindings([row]);
}

test("census refuses an event with no production publisher", () => {
  expect(
    finding({
      class: "publisher",
      definition: { path: "packages/protocol/src/events.ts", line: 7, symbol: "Ready" },
      consumers: [],
    }),
  ).toEqual([
    {
      path: "packages/protocol/src/events.ts",
      line: 7,
      symbol: "Ready",
      class: "publisher",
      message: "event has no production publisher",
    },
  ]);
});

test("census refuses an export consumed only by tests and barrels", () => {
  expect(
    finding({
      class: "export",
      definition: { path: "packages/agent/src/value.ts", line: 3, symbol: "value" },
      consumers: [{ role: "test" }, { role: "barrel" }],
    }),
  ).toEqual([
    {
      path: "packages/agent/src/value.ts",
      line: 3,
      symbol: "value",
      class: "export",
      message: "export has no production consumer; tests and barrels do not count",
    },
  ]);
});

test("census refuses a store that is registered but never read", () => {
  expect(
    finding({
      class: "store",
      definition: { path: "packages/ledger/src/store.ts", line: 11, symbol: "SessionStore" },
      consumers: [{ role: "register" }],
    }),
  ).toEqual([
    {
      path: "packages/ledger/src/store.ts",
      line: 11,
      symbol: "SessionStore",
      class: "store",
      message: "store is registered but never read in production",
    },
  ]);
});

test("census refuses alias collisions before consumer classification", () => {
  expect(() =>
    censusConsumerFindings([
      {
        class: "export",
        definition: { path: "packages/a/src/index.ts", line: 1, symbol: "valueA" },
        aliases: ["shared"],
        consumers: [{ role: "production" }],
      },
      {
        class: "export",
        definition: { path: "packages/b/src/index.ts", line: 2, symbol: "valueB" },
        aliases: ["shared"],
        consumers: [{ role: "production" }],
      },
    ]),
  ).toThrow(
    "CENSUS_ALIAS_COLLISION shared: packages/a/src/index.ts:1 valueA <> " +
      "packages/b/src/index.ts:2 valueB",
  );
});
