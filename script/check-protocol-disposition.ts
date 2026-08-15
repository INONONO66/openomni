/**
 * #497 protocol dead-surface disposition verifier.
 *
 * Two jobs, both deterministic and independent of the live repo — they read
 * ONLY the disposition ledger + fixture files, so the subsequent kill batches
 * can land in any order without perturbing this check:
 *
 *   1. inventory validation — every symbol row carries exactly ONE disposition
 *      in the allowed set, a non-empty `reason`, and the four required
 *      `evidence` keys. Orphan/ambiguous rows fail (exit 1) BY SYMBOL NAME.
 *
 *   2. fixture validation — a fixture describes a hypothetical importer plus the
 *      surfaces it keeps / asserts gone. It is REJECTED (by symbol + rule name)
 *      when it imports a removed export, cross-package-imports an un-exported
 *      symbol, declares a still-retained symbol "removed", or omits a required
 *      fail-closed owner. A clean retained fixture is green.
 *
 * The fixture rules never touch packages/protocol/src — they resolve every
 * symbol through the ledger only — so a fixture's verdict is the same before
 * and after any concept-diet deletion lands.
 *
 * Modes:
 *   bun run script/check-protocol-disposition.ts
 *   bun run script/check-protocol-disposition.ts --inventory <path>
 *   bun run script/check-protocol-disposition.ts --fixtures <dir>
 *   bun run script/check-protocol-disposition.ts --fixture <name>
 *   bun run script/check-protocol-disposition.ts --json
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const DISPOSITIONS = [
  "delete",
  "unexport",
  "preserve",
  "defer",
  "wire",
  "already-removed",
] as const;

type Disposition = (typeof DISPOSITIONS)[number];

const DISPOSITION_SET = new Set<string>(DISPOSITIONS);

/** preserve/defer rows are the fail-closed owners a fixture may legitimately retain. */
const FAIL_CLOSED_DISPOSITIONS = new Set<Disposition>(["preserve", "defer"]);

/** delete/already-removed rows are gone (or going) — importing them is a defect. */
const REMOVED_DISPOSITIONS = new Set<Disposition>(["delete", "already-removed"]);

const REQUIRED_EVIDENCE_KEYS = [
  "productionConsumers",
  "testPins",
  "snapshotPin",
  "runtimeConsumer",
] as const;

const DEFAULT_INVENTORY_PATH = ".omo/evidence/p3/protocol-concept-disposition.json";
const DEFAULT_FIXTURES_DIR = "packages/protocol/test/concept-diet/fixtures";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

interface SymbolEvidence {
  readonly productionConsumers?: unknown;
  readonly testPins?: unknown;
  readonly snapshotPin?: unknown;
  readonly runtimeConsumer?: unknown;
}

interface SymbolRow {
  readonly symbol?: unknown;
  readonly family?: string;
  readonly disposition?: unknown;
  readonly reason?: unknown;
  readonly evidence?: SymbolEvidence;
  readonly handoff?: string;
}

export interface Inventory {
  readonly dispositions?: readonly string[];
  readonly tally?: Readonly<Record<string, number>>;
  readonly symbols: readonly SymbolRow[];
}

export type DispositionCounts = Record<Disposition, number>;

interface InventoryProblem {
  readonly symbol: string;
  readonly issue: string;
}

export interface InventoryValidation {
  readonly ok: boolean;
  readonly problems: readonly InventoryProblem[];
  readonly counts: DispositionCounts;
  readonly tallyMatches: boolean;
}

export interface SymbolIndexEntry {
  readonly symbol: string;
  readonly disposition: Disposition | undefined;
  readonly testPinned: boolean;
  readonly handoff: string | undefined;
  readonly family: string | undefined;
}

export type SymbolIndex = ReadonlyMap<string, SymbolIndexEntry>;

export interface Fixture {
  readonly description?: string;
  readonly expect?: "accept" | "reject";
  readonly crossPackage?: boolean;
  readonly imports?: readonly string[];
  readonly removed?: readonly string[];
  readonly retainsFailClosed?: readonly string[];
  readonly requiredOwners?: readonly string[];
  readonly rule?: string;
}

type ReferenceRole = "import" | "removed" | "retained-owner" | "required-owner";

interface FixtureReference {
  readonly symbol: string;
  readonly role: ReferenceRole;
  readonly disposition: Disposition | "unknown";
  readonly testPinned: boolean;
  readonly handoff?: string;
}

interface FixtureRejection {
  readonly symbol: string;
  readonly rule: string;
}

export interface FixtureResult {
  readonly fixture: string;
  readonly ok: boolean;
  readonly expect: "accept" | "reject";
  readonly references: readonly FixtureReference[];
  readonly rejectedSymbols?: readonly string[];
  readonly rule?: string;
  readonly rejections?: readonly FixtureRejection[];
}

export interface VerifierSummary {
  readonly ok: boolean;
  readonly inventory: {
    readonly path: string;
    readonly ok: boolean;
    readonly counts: DispositionCounts;
    readonly tallyMatches: boolean;
    readonly problems: readonly InventoryProblem[];
  };
  readonly fixtures: readonly FixtureResult[];
}

// ---------------------------------------------------------------------------
// pure logic — no filesystem, no live-repo dependency
// ---------------------------------------------------------------------------

function emptyCounts(): DispositionCounts {
  return {
    delete: 0,
    unexport: 0,
    preserve: 0,
    defer: 0,
    wire: 0,
    "already-removed": 0,
  };
}

function isDisposition(value: unknown): value is Disposition {
  return typeof value === "string" && DISPOSITION_SET.has(value);
}

/** Counts each row's disposition; unknown/missing dispositions are not counted. */
export function computeCounts(inventory: Inventory): DispositionCounts {
  const counts = emptyCounts();
  for (const row of inventory.symbols) {
    if (isDisposition(row.disposition)) {
      counts[row.disposition] += 1;
    }
  }
  return counts;
}

function tallyMatches(inventory: Inventory, counts: DispositionCounts): boolean {
  const tally = inventory.tally;
  if (!tally) {
    return false;
  }
  return DISPOSITIONS.every((disposition) => (tally[disposition] ?? 0) === counts[disposition]);
}

/**
 * Every row must have exactly one allowed disposition, a non-empty reason, and
 * the four evidence keys. Problems are reported by symbol name; a nameless row
 * is reported as `<row N>`.
 */
export function validateInventory(inventory: Inventory): InventoryValidation {
  const problems: InventoryProblem[] = [];
  const seen = new Set<string>();
  const counts = emptyCounts();

  inventory.symbols.forEach((row, index) => {
    const hasName = typeof row.symbol === "string" && row.symbol.length > 0;
    const symbol = hasName ? (row.symbol as string) : `<row ${index}>`;

    if (!hasName) {
      problems.push({ symbol, issue: "missing-symbol-name" });
    } else if (seen.has(symbol)) {
      problems.push({ symbol, issue: "duplicate-symbol-row" });
    }
    seen.add(symbol);

    if (row.disposition === undefined || row.disposition === null || row.disposition === "") {
      problems.push({ symbol, issue: "missing-disposition" });
    } else if (!isDisposition(row.disposition)) {
      problems.push({ symbol, issue: `unknown-disposition:${String(row.disposition)}` });
    } else {
      counts[row.disposition] += 1;
    }

    if (typeof row.reason !== "string" || row.reason.trim().length === 0) {
      problems.push({ symbol, issue: "missing-reason" });
    }

    const evidence = row.evidence;
    if (typeof evidence !== "object" || evidence === null) {
      problems.push({ symbol, issue: "missing-evidence" });
    } else {
      for (const key of REQUIRED_EVIDENCE_KEYS) {
        if (!(key in evidence)) {
          problems.push({ symbol, issue: `missing-evidence:${key}` });
        }
      }
    }
  });

  return {
    ok: problems.length === 0,
    problems,
    counts,
    tallyMatches: tallyMatches(inventory, counts),
  };
}

/** Maps each symbol name to its disposition + test-pin flag for fixture checks. */
export function buildSymbolIndex(inventory: Inventory): Map<string, SymbolIndexEntry> {
  const index = new Map<string, SymbolIndexEntry>();
  for (const row of inventory.symbols) {
    if (typeof row.symbol !== "string" || row.symbol.length === 0) {
      continue;
    }
    const testPins = row.evidence?.testPins;
    index.set(row.symbol, {
      symbol: row.symbol,
      disposition: isDisposition(row.disposition) ? row.disposition : undefined,
      testPinned: Array.isArray(testPins) && testPins.length > 0,
      handoff: row.handoff,
      family: row.family,
    });
  }
  return index;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Resolves a fixture's declared surfaces against the ledger and returns its
 * references (for reporting) plus any rejections (with the violated rule).
 */
export function checkFixture(name: string, fixture: Fixture, index: SymbolIndex): FixtureResult {
  const crossPackage = fixture.crossPackage !== false;
  const imports = fixture.imports ?? [];
  const removed = fixture.removed ?? [];
  const retained = fixture.retainsFailClosed ?? [];
  const required = fixture.requiredOwners ?? [];

  const references: FixtureReference[] = [];
  const rejections: FixtureRejection[] = [];

  const pushReference = (symbol: string, role: ReferenceRole): SymbolIndexEntry | undefined => {
    const entry = index.get(symbol);
    references.push({
      symbol,
      role,
      disposition: entry?.disposition ?? "unknown",
      testPinned: entry?.testPinned ?? false,
      handoff: entry?.handoff,
    });
    return entry;
  };

  for (const symbol of imports) {
    const entry = pushReference(symbol, "import");
    if (!entry || entry.disposition === undefined) {
      rejections.push({ symbol, rule: "unknown-symbol" });
      continue;
    }
    if (REMOVED_DISPOSITIONS.has(entry.disposition)) {
      rejections.push({ symbol, rule: "removed-export" });
    } else if (crossPackage && entry.disposition === "unexport") {
      rejections.push({ symbol, rule: "cross-package-unexport" });
    }
  }

  for (const symbol of removed) {
    const entry = pushReference(symbol, "removed");
    if (!entry || entry.disposition === undefined) {
      rejections.push({ symbol, rule: "unknown-symbol" });
      continue;
    }
    if (!REMOVED_DISPOSITIONS.has(entry.disposition)) {
      rejections.push({ symbol, rule: "retained-symbol-declared-removed" });
    }
  }

  const retainedSet = new Set<string>([...imports, ...retained]);
  for (const symbol of retained) {
    pushReference(symbol, "retained-owner");
  }

  for (const symbol of required) {
    const entry = pushReference(symbol, "required-owner");
    if (!entry || entry.disposition === undefined) {
      rejections.push({ symbol, rule: "unknown-symbol" });
      continue;
    }
    if (!FAIL_CLOSED_DISPOSITIONS.has(entry.disposition)) {
      rejections.push({ symbol, rule: "required-owner-not-fail-closed" });
    }
    if (!retainedSet.has(symbol)) {
      rejections.push({ symbol, rule: "missing-required-owner" });
    }
  }

  const seenRejection = new Set<string>();
  const dedupedRejections = rejections.filter((rejection) => {
    const key = `${rejection.symbol}::${rejection.rule}`;
    if (seenRejection.has(key)) {
      return false;
    }
    seenRejection.add(key);
    return true;
  });

  const ok = dedupedRejections.length === 0;
  const expect: "accept" | "reject" = fixture.expect === "reject" ? "reject" : "accept";

  if (ok) {
    return { fixture: name, ok, expect, references };
  }
  return {
    fixture: name,
    ok,
    expect,
    references,
    rejectedSymbols: uniqueStrings(dedupedRejections.map((rejection) => rejection.symbol)),
    rule: dedupedRejections[0]?.rule,
    rejections: dedupedRejections,
  };
}

export interface NamedFixture {
  readonly name: string;
  readonly fixture: Fixture;
}

/** Runs the inventory validation + every fixture and folds them into one summary. */
export function verify(
  inventory: Inventory,
  fixtures: readonly NamedFixture[],
  inventoryPath: string,
): VerifierSummary {
  const inventoryValidation = validateInventory(inventory);
  const index = buildSymbolIndex(inventory);
  const fixtureResults = fixtures
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, fixture }) => checkFixture(name, fixture, index));

  const ok = inventoryValidation.ok && fixtureResults.every((result) => result.ok);

  return {
    ok,
    inventory: {
      path: inventoryPath,
      ok: inventoryValidation.ok,
      counts: inventoryValidation.counts,
      tallyMatches: inventoryValidation.tallyMatches,
      problems: inventoryValidation.problems,
    },
    fixtures: fixtureResults,
  };
}

// ---------------------------------------------------------------------------
// filesystem helpers — only the CLI reads files
// ---------------------------------------------------------------------------

export function readInventory(path: string): Inventory {
  return JSON.parse(readFileSync(path, "utf8")) as Inventory;
}

function readFixture(path: string): Fixture {
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

export function loadFixtures(dir: string, only?: string): NamedFixture[] {
  const names = only
    ? [only]
    : readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .sort((a, b) => a.localeCompare(b));
  return names.map((name) => ({ name, fixture: readFixture(join(dir, name)) }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  readonly inventory: string;
  readonly fixtures: string;
  readonly fixture?: string;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let inventory = DEFAULT_INVENTORY_PATH;
  let fixtures = DEFAULT_FIXTURES_DIR;
  let fixture: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--inventory":
        i += 1;
        inventory = argv[i] ?? inventory;
        break;
      case "--fixtures":
        i += 1;
        fixtures = argv[i] ?? fixtures;
        break;
      case "--fixture":
        i += 1;
        fixture = argv[i];
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }

  return { inventory, fixtures, fixture, json };
}

function reportHuman(summary: VerifierSummary): void {
  const { inventory, fixtures } = summary;
  if (inventory.ok) {
    const counts = DISPOSITIONS.map(
      (disposition) => `${disposition}=${inventory.counts[disposition]}`,
    ).join(" ");
    process.stdout.write(
      `OK: inventory ${inventory.path} — ${counts}${inventory.tallyMatches ? " (tally matches)" : " (tally MISMATCH)"}\n`,
    );
  } else {
    for (const problem of inventory.problems) {
      process.stderr.write(`VIOLATION [inventory] ${problem.symbol} — ${problem.issue}\n`);
    }
  }
  if (!inventory.tallyMatches) {
    process.stderr.write(
      "VIOLATION [inventory] <tally> — declared tally does not match counted dispositions\n",
    );
  }

  for (const result of fixtures) {
    if (result.ok) {
      process.stdout.write(
        `OK: fixture ${result.fixture} — retained (${result.references.length} references, expect=${result.expect})\n`,
      );
      continue;
    }
    for (const rejection of result.rejections ?? []) {
      process.stderr.write(
        `VIOLATION [${rejection.rule}] ${result.fixture}: ${rejection.symbol} — rejected importer surface\n`,
      );
    }
  }
}

function main(): void {
  const options = parseArgs(Bun.argv.slice(2));
  const inventory = readInventory(options.inventory);
  const fixtures = loadFixtures(options.fixtures, options.fixture);
  const summary = verify(inventory, fixtures, options.inventory);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    reportHuman(summary);
  }

  // tally mismatch is a ledger defect even though it is not a per-row problem.
  process.exit(summary.ok && summary.inventory.tallyMatches ? 0 : 1);
}

if (import.meta.main) {
  try {
    main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${message}\n`);
    process.exit(1);
  }
}
