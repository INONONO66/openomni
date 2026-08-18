import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildSymbolIndex,
  checkFixture,
  computeCounts,
  DISPOSITIONS,
  type Fixture,
  loadFixtures,
  readInventory,
  validateInventory,
  verify,
} from "../../../../script/check-protocol-disposition.ts";

const INVENTORY_PATH = join(import.meta.dir, "protocol-concept-disposition.json");
const FIXTURES_DIR = join(import.meta.dir, "fixtures");

const inventory = readInventory(INVENTORY_PATH);
const index = buildSymbolIndex(inventory);

function fixtureByName(name: string): Fixture {
  const found = loadFixtures(FIXTURES_DIR).find((entry) => entry.name === name);
  if (!found) {
    throw new Error(`fixture not found: ${name}`);
  }
  return found.fixture;
}

describe("#497 protocol dead-surface disposition ledger", () => {
  test("inventory has no orphan or ambiguous rows", () => {
    // When
    const validation = validateInventory(inventory);

    // Then
    expect(validation.problems).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  test("every row carries exactly one disposition from the allowed set", () => {
    const dispositions: readonly string[] = DISPOSITIONS;
    for (const row of inventory.symbols) {
      if (typeof row.disposition !== "string") throw new Error("shape");
      expect(dispositions).toContain(row.disposition);
    }
  });

  test("computed tally matches the inventory's declared tally field", () => {
    // When
    const counts = computeCounts(inventory);

    // Then
    expect(inventory.tally).toEqual(counts);
    expect(validateInventory(inventory).tallyMatches).toBe(true);
  });

  test("a manufactured orphan row is flagged by symbol name", () => {
    // Given — a row missing its disposition + reason + evidence
    const broken = {
      ...inventory,
      symbols: [...inventory.symbols, { symbol: "Bogus.Orphan" }],
    };

    // When
    const validation = validateInventory(broken);

    // Then
    expect(validation.ok).toBe(false);
    const orphanIssues = validation.problems.filter((problem) => problem.symbol === "Bogus.Orphan");
    expect(orphanIssues.map((problem) => problem.issue)).toEqual(
      expect.arrayContaining(["missing-disposition", "missing-reason", "missing-evidence"]),
    );
  });
});

describe("#497 fixture rules", () => {
  test("the happy retained-fail-closed fixture passes and shows one disposition per referenced surface", () => {
    // When
    const result = checkFixture(
      "retained-fail-closed.json",
      fixtureByName("retained-fail-closed.json"),
      index,
    );

    // Then — accepted, no rejections
    expect(result.ok).toBe(true);
    expect(result.rejectedSymbols).toBeUndefined();

    // ... and it exercises a deleted symbol, a test-pinned candidate, a retained
    // fail-closed path, and a deferred mapping, each with exactly one disposition.
    const bySymbol = new Map(result.references.map((ref) => [ref.symbol, ref]));

    const deleted = bySymbol.get("Ingress.ActorMetadata");
    expect(deleted?.disposition).toBe("delete");
    expect(deleted?.testPinned).toBe(false);

    const testPinned = bySymbol.get("Message.RetryPart");
    expect(testPinned?.disposition).toBe("delete");
    expect(testPinned?.testPinned).toBe(true);

    const retainedOwner = bySymbol.get("Adapter.Capabilities");
    expect(retainedOwner?.disposition).toBe("preserve");

    const deferred = bySymbol.get("Actor.Relationship");
    expect(deferred?.disposition).toBe("defer");
    expect(deferred?.handoff).toBe("#498");
  });

  test("the retained-recovery fixture stays green", () => {
    // When
    const result = checkFixture(
      "retained-recovery.json",
      fixtureByName("retained-recovery.json"),
      index,
    );

    // Then
    expect(result.ok).toBe(true);
    expect(result.rejectedSymbols).toBeUndefined();
  });

  test("the removed-api-import fixture is rejected by symbol AND rule", () => {
    // When
    const result = checkFixture(
      "removed-api-import.json",
      fixtureByName("removed-api-import.json"),
      index,
    );

    // Then
    expect(result.ok).toBe(false);
    expect(result.rejectedSymbols).toEqual(["Extension.Manifest"]);
    expect(result.rule).toBe("removed-export");
    expect(result.rejections).toEqual([{ symbol: "Extension.Manifest", rule: "removed-export" }]);
  });

  test("a fixture that omits a required fail-closed owner is rejected by that symbol", () => {
    // Given — claims to retain Adapter.Capabilities but omits Actor.Relationship
    const fixture: Fixture = {
      description: "omits a required owner",
      expect: "accept",
      crossPackage: true,
      retainsFailClosed: ["Adapter.Capabilities"],
      requiredOwners: ["Adapter.Capabilities", "Actor.Relationship"],
    };

    // When
    const result = checkFixture("omits-required-owner", fixture, index);

    // Then
    expect(result.ok).toBe(false);
    expect(result.rejectedSymbols).toEqual(["Actor.Relationship"]);
    expect(result.rule).toBe("missing-required-owner");
  });

  test("a cross-package import of an unexported symbol is rejected by symbol", () => {
    // Given — Actor.Kind is unexport (intra-package only)
    const fixture: Fixture = {
      description: "cross-package import of an intra-package symbol",
      expect: "reject",
      crossPackage: true,
      imports: ["Actor.Kind"],
    };

    // When
    const result = checkFixture("cross-package-unexport", fixture, index);

    // Then
    expect(result.ok).toBe(false);
    expect(result.rejectedSymbols).toEqual(["Actor.Kind"]);
    expect(result.rule).toBe("cross-package-unexport");
  });

  test("the same unexported symbol is accepted for an intra-package importer", () => {
    // Given — crossPackage:false models a same-package importer
    const fixture: Fixture = {
      description: "intra-package import of an unexported symbol",
      expect: "accept",
      crossPackage: false,
      imports: ["Actor.Kind"],
    };

    // When
    const result = checkFixture("intra-package-unexport", fixture, index);

    // Then
    expect(result.ok).toBe(true);
  });
});

describe("#497 verifier summary", () => {
  test("verify() folds the inventory + fixtures into one summary; only the bad fixture is red", () => {
    // When
    const fixtures = loadFixtures(FIXTURES_DIR);
    const summary = verify(inventory, fixtures, INVENTORY_PATH);

    // Then — inventory is clean, tally matches, one fixture rejected
    expect(summary.inventory.ok).toBe(true);
    expect(summary.inventory.tallyMatches).toBe(true);
    expect(summary.ok).toBe(false);

    const results = new Map(summary.fixtures.map((result) => [result.fixture, result]));
    expect(results.get("retained-fail-closed.json")?.ok).toBe(true);
    expect(results.get("retained-recovery.json")?.ok).toBe(true);
    expect(results.get("removed-api-import.json")?.ok).toBe(false);
    expect(results.get("removed-api-import.json")?.rejectedSymbols).toEqual(["Extension.Manifest"]);
  });
});
