import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  collectP2Sources,
  discoverP2Producers,
  generateP2Manifest,
  type P2Manifest,
  type SourceTree,
  validateP2Manifest,
} from "./p2-manifests.js";

setDefaultTimeout(15_000);

type MutableManifest = {
  -readonly [Section in keyof P2Manifest]: Array<Record<string, unknown>>;
};

let checked: MutableManifest;
let sources: Map<string, string>;

beforeAll(async () => {
  checked = JSON.parse(
    readFileSync("script/conformance/p2-manifests.json", "utf8"),
  ) as MutableManifest;
  sources = await collectP2Sources();
  generateP2Manifest(sources);
});

function generateFixture(extra: ReadonlyMap<string, string>): P2Manifest {
  const baselinePath = "packages/session/migration/0001_p2_clean_baseline/migration.sql";
  return generateP2Manifest(
    new Map([[baselinePath, required(sources.get(baselinePath))], ...extra]),
  );
}

function fixture(): MutableManifest {
  return structuredClone(checked);
}

function sourceFixture(extra: ReadonlyMap<string, string>): SourceTree {
  return extra.size === 0 ? sources : new Map([...sources, ...extra]);
}

function issues(manifest: MutableManifest, extra: ReadonlyMap<string, string> = new Map()) {
  return validateP2Manifest(manifest, sourceFixture(extra));
}

function families(
  manifest: MutableManifest,
  extra: ReadonlyMap<string, string> = new Map(),
): Set<string> {
  return new Set(issues(manifest, extra).map((entry) => entry.family));
}

function expectFamilies(actual: Set<string>, expected: readonly string[]): void {
  for (const family of expected) expect(actual.has(family)).toBe(true);
}

function omit(section: keyof MutableManifest, index = 0): MutableManifest {
  const manifest = fixture();
  manifest[section].splice(index, 1);
  return manifest;
}

describe("P2-00 exhaustive checked manifest discrimination", () => {
  test("checked manifest is exact and currently green", () => {
    expect(issues(fixture())).toEqual([]);
  });

  test("ships every production mutation authority without planned, uncovered, or legacy producers", () => {
    const manifest = fixture();
    expect(
      manifest["production-mutation"].every(
        (row) =>
          row.status === "current" &&
          row.targetShipped === true &&
          !String(row.test).startsWith("uncovered:") &&
          !/legacy|dormant/i.test(String(row.writer)),
      ),
    ).toBe(true);
    expect(
      manifest["durable-surface"].filter((row) => row.classification === "current-delete-at-p2-04"),
    ).toEqual([]);
    for (const section of [
      "final-schema",
      "native-transition",
      "blob-exception",
      "projection",
    ] as const)
      expect(manifest[section].every((row) => row.targetShipped === true)).toBe(true);
  });

  test.each([
    ["native-transition", "native-catalog"],
    ["final-schema", "schema-catalog"],
    ["projection", "projection-catalog"],
    ["store-disposition", "store-disposition"],
    ["durable-surface", "unknown-producer"],
    ["effect-scope", "unscoped-mutation"],
    ["secret-boundary", "unsanitized-boundary"],
    ["p3-disposition", "p3-catalog"],
    ["blob-exception", "blob-catalog"],
  ] as const)("rejects one omitted %s row for its intended reason", (section, family) => {
    expect(families(omit(section)).has(family)).toBe(true);
  });

  test("rejects every duplicate catalog row", () => {
    const manifest = fixture();
    manifest["native-transition"].push(structuredClone(required(manifest["native-transition"][0])));
    expectFamilies(families(manifest), ["duplicate-row", "native-catalog"]);
  });

  test("rejects an added unmanifested producer without a blanket escape", () => {
    const extra = new Map([
      [
        "packages/rogue/src/new-writer.ts",
        "export function persist(db: any) { db.query('INSERT INTO rogue_store VALUES (?)').run(1); }",
      ],
    ]);
    const result = families(fixture(), extra);
    expect(result.has("unknown-producer")).toBe(true);
    expect(result.has("mutation-catalog")).toBe(true);
  });

  test("rejects broad paths and duplicate exact classifications", () => {
    const broad = fixture();
    broad["durable-surface"].push({
      ...broad["durable-surface"][0],
      id: "surface.alias",
      path: "**",
    });
    expectFamilies(families(broad), ["blanket-surface", "unknown-producer"]);

    const duplicate = fixture();
    duplicate["durable-surface"].push({
      ...duplicate["durable-surface"][0],
      id: "surface.duplicate",
    });
    expectFamilies(families(duplicate), ["duplicate-classification", "unknown-producer"]);
  });

  test("rejects independent DML against a ledger authority table", () => {
    const extra = new Map([
      [
        "packages/rogue/src/ledger.ts",
        "export function replace(db: any) { db.exec('UPDATE ledger_head SET owner_seq = 2'); }",
      ],
    ]);
    expect(families(fixture(), extra).has("second-writer")).toBe(true);
  });

  test("does not mistake projection checkpoint DML or quoted examples for a second ledger writer", () => {
    const extra = new Map([
      [
        "packages/rogue/src/projection.ts",
        "export function project(db: any) { db.query('INSERT INTO projection_checkpoint VALUES (?)').run(1); }",
      ],
      [
        "packages/rogue/src/example.ts",
        "export const example = 'INSERT INTO ledger_event VALUES (?)';",
      ],
    ]);
    expect(families(fixture(), extra).has("second-writer")).toBe(false);
  });

  test("pins caller ownership to the containing function through nested control flow", () => {
    const generated = discoverP2Producers(
      new Map([
        [
          "packages/fixture/src/nested.ts",
          `export function persist(db: any, rows: unknown[]) {
            if (rows.length) {
              for (const row of rows) {
                while (row) {
                  switch (rows.length) {
                    case 1: db.exec("UPDATE fixture SET value = 1"); return;
                  }
                }
              }
            }
          }`,
        ],
      ]),
    );
    expect(required(generated.find((row) => row.kind === "dml")).symbol).toBe("persist");
    expect(generated.some((row) => ["if", "for", "while", "switch"].includes(row.symbol))).toBe(
      false,
    );
  });

  test("forged sole-writer disposition cannot bless rogue ledger DML", () => {
    const roguePath = "packages/rogue/src/ledger.ts";
    const rogueSources = new Map([
      ...sources,
      [
        roguePath,
        "export function replace(db: any) { db.exec('UPDATE ledger_head SET owner_seq = 2'); }",
      ] as const,
    ]);
    const forged = generateP2Manifest(rogueSources) as unknown as MutableManifest;
    const rogue = required(forged["production-mutation"].find((row) => row.file === roguePath));
    rogue.writer = "sole-ledger-writer";
    expectFamilies(
      families(forged, new Map([[roguePath, required(rogueSources.get(roguePath))]])),
      ["second-writer", "mutation-disposition"],
    );
  });

  test("treats recursively composed lexical SELECT SQL as read-only", () => {
    const discovered = discoverP2Producers(
      new Map([
        [
          "packages/fixture/src/composed-select.ts",
          `export function read(db: any) {
             const statement = EVENT_SELECT + FILTER;
             db.query(statement).all();
           }
           const EVENT_SELECT = \`SELECT id FROM ledger_event\`;
           const FILTER = \` WHERE owner_key = ?\`;`,
        ],
      ]),
    );
    expect(discovered.filter((row) => row.kind === "dml")).toEqual([]);
  });

  test("finds recursively composed lexical UPDATE SQL as a rogue writer", () => {
    const extra = new Map([
      [
        "packages/rogue/src/const-ledger.ts",
        `export function replace(db: any) {
           const sql = PREFIX + \`\${TABLE} SET owner_seq = 2\`;
           db.exec(sql);
         }
         const TABLE = "ledger_head";
         const PREFIX = "UPDATE ";`,
      ],
    ]);
    expectFamilies(families(fixture(), extra), ["second-writer"]);
  });

  test("fails closed for unresolved dynamic SQL", () => {
    const unresolved = new Map([
      [
        "packages/rogue/src/dynamic-sql.ts",
        "export function execute(db: any, sql: string) { db.exec(sql); }",
      ],
    ]);
    expectFamilies(families(fixture(), unresolved), ["unknown-producer", "mutation-catalog"]);
  });

  test("resolves SQL identifiers by lexical binding across separate and nested shadows", () => {
    const discovered = discoverP2Producers(
      new Map([
        [
          "packages/fixture/src/shadowed-sql.ts",
          `const SQL = "UPDATE module_table SET value = 1";
           export function first(db: any) {
             const SQL = "UPDATE first_table SET value = 1";
             db.exec(SQL);
           }
           export function second(db: any) {
             const SQL = "DELETE FROM second_table";
             db.exec(SQL);
             function nested(SQL: string) { db.exec(SQL); }
           }
           export function moduleBinding(db: any) { db.exec(SQL); }`,
        ],
      ]),
    );
    expect(
      discovered
        .filter((row) => row.kind === "dml")
        .map((row) => `${row.symbol}:${row.operation}`)
        .sort(),
    ).toEqual([
      "first:UPDATE:first_table",
      "moduleBinding:UPDATE:module_table",
      "nested:UNRESOLVED-SQL",
      "second:DELETE FROM:second_table",
    ]);
  });

  test("finds unresolved client, pool, element, aliased, destructured, and tagged SQL", () => {
    const discovered = discoverP2Producers(
      new Map([
        [
          "packages/fixture/src/sql-apis.ts",
          `interface Database { query(statement: string): unknown; }
           export function clientQuery(client: any, statement: string) { client.query(statement); }
           export function poolQuery(pool: any, statement: string) { pool.query(statement); }
           export function typedRepository(repository: Database, statement: string) { repository.query(statement); }
           export function elementQuery(client: any, statement: string) { client["query"](statement); }
           export function aliasedQuery(client: any, statement: string) {
             const runner = client;
             runner.query(statement);
           }
           export function directQuery(pool: any, statement: string) {
             const execute = pool.query;
             execute(statement);
           }
           export function destructuredQuery(client: any, statement: string) {
             const { query: execute } = client;
             execute(statement);
           }
           export function taggedQuery(value: string) { sql\`UPDATE account SET value = \${value}\`; }
           export function taggedClient(client: any, value: string) { client\`DELETE FROM account WHERE id = \${value}\`; }
           export function propertyTag(client: any, value: string) { client.sql\`UPDATE account SET value = \${value}\`; }
           export function aliasedTag(value: string) { const tag = sql; tag\`UPDATE account SET value = \${value}\`; }
           export function staticTag() { sql\`DELETE FROM account\`; }`,
        ],
      ]),
    );
    const unresolved = discovered.filter(
      (row) => row.kind === "dml" && row.operation === "UNRESOLVED-SQL",
    );
    expect(unresolved.map((row) => row.symbol).sort()).toEqual([
      "aliasedQuery",
      "aliasedTag",
      "clientQuery",
      "destructuredQuery",
      "directQuery",
      "elementQuery",
      "poolQuery",
      "propertyTag",
      "taggedClient",
      "taggedQuery",
      "typedRepository",
    ]);
    expect(
      discovered.some(
        (row) => row.symbol === "staticTag" && row.operation === "DELETE FROM:account",
      ),
    ).toBe(true);
  });

  test("finds direct, property, element, aliased, and destructured environment access", () => {
    const generated = generateFixture(
      new Map([
        [
          "packages/fixture/src/env-access.ts",
          `declare function consume(value: unknown): void;
           export function direct() { consume(process.env); }
           export function directBun() { consume(Bun.env); }
           export function property() { consume(process.env.API_TOKEN); }
           export function element() { consume(Bun.env["API_TOKEN"]); }
           export function alias() { const runtime = process.env; consume(runtime.API_TOKEN); }
           export function aliasChain() { const runtime = Bun.env; const inherited = runtime; consume(inherited["API_TOKEN"]); }
           export function destructured() { const { API_TOKEN, HOME: ownerHome } = process.env; consume(API_TOKEN); consume(ownerHome); }
           export function parameter({ API_TOKEN } = Bun.env) { consume(API_TOKEN); }`,
        ],
      ]),
    );
    const environments = generated["durable-surface"].filter(
      (row) => row.producerKind === "environment",
    );
    expect(environments.map((row) => row.operation).sort()).toEqual([
      "Bun.env",
      "Bun.env.API_TOKEN",
      'Bun.env["API_TOKEN"]',
      'inherited["API_TOKEN"]',
      "process.env",
      "process.env.API_TOKEN",
      "process.env.API_TOKEN",
      "process.env.HOME",
      "runtime.API_TOKEN",
    ]);
    expect(
      environments.every((surface) =>
        generated["secret-boundary"].some((boundary) => boundary.surfaceId === surface.id),
      ),
    ).toBe(true);
  });

  test("pins every semantic value in independently derived rows", () => {
    const manifest = fixture();
    const expected: string[] = [];
    for (const section of [
      "final-schema",
      "store-disposition",
      "blob-exception",
      "projection",
      "effect-scope",
      "secret-boundary",
    ] as const) {
      const row = required(manifest[section][0]);
      const key = required(
        Object.keys(row).find((candidate) => !["id", "evidence"].includes(candidate)),
      );
      row[key] = typeof row[key] === "boolean" ? true : "forged";
      expected.push(`${section}-signature`);
    }
    expectFamilies(families(manifest), expected);
  });

  test("rejects schema DDL drift and receipt text false positives", () => {
    const baselinePath = "packages/session/migration/0001_p2_clean_baseline/migration.sql";
    const driftedBaseline = required(sources.get(baselinePath)).replace(
      "owner_seq INTEGER NOT NULL CHECK (owner_seq > 0)",
      "owner_seq TEXT NOT NULL",
    );
    const manifest = fixture();
    required(manifest["blob-exception"][0]).testIds = [
      "packages/rogue/test/receipt.test.ts#proves blob integrity",
    ];
    const mutatedSources = new Map([
      [baselinePath, driftedBaseline],
      [
        "packages/rogue/test/receipt.test.ts",
        "// test('proves blob integrity', () => {});\nexport const note = 'proves blob integrity';",
      ],
    ]);
    expectFamilies(families(manifest, mutatedSources), [
      "final-schema-signature",
      "missing-receipt",
    ]);
  });

  test("fails closed when target DDL is missing or loses STRICT without losing its name", () => {
    const baselinePath = "packages/session/migration/0001_p2_clean_baseline/migration.sql";
    const baselineSource = required(sources.get(baselinePath));
    const missing = new Map(sources);
    missing.set(
      baselinePath,
      baselineSource.replace(/CREATE TABLE ledger_head[\s\S]*?\) STRICT;\n/, ""),
    );
    expect(() => generateP2Manifest(missing)).toThrow(
      "missing STRICT baseline table DDL: ledger_head",
    );
    const missingFamilies = new Set(
      validateP2Manifest(fixture(), missing).map((entry) => entry.family),
    );
    expect(missingFamilies.has("schema-catalog")).toBe(true);
    expect(missingFamilies.has("schema-ddl")).toBe(true);

    const nonStrict = new Map(sources);
    nonStrict.set(
      baselinePath,
      baselineSource.replace(
        /CREATE TABLE ledger_head([\s\S]*?\)) STRICT;/,
        "CREATE TABLE ledger_head$1;",
      ),
    );
    const nonStrictIssues = validateP2Manifest(fixture(), nonStrict);
    expect(nonStrictIssues.some((entry) => entry.family === "schema-ddl")).toBe(true);
    expect(
      nonStrictIssues.some(
        (entry) => entry.family === "schema-catalog" && entry.subject === "ledger_head",
      ),
    ).toBe(false);
  });

  test("rejects bad, missing, and source-as-test receipts", () => {
    const manifest = fixture();
    manifest["native-transition"][0] = {
      ...manifest["native-transition"][0],
      test: "TC-does-not-exist",
    };
    manifest["blob-exception"][0] = { ...manifest["blob-exception"][0], testIds: [] };
    const current = required(manifest["effect-scope"].find((row) => row.status === "current"));
    current.testIds = [String((current.evidence as readonly string[])[0])];
    expect(families(manifest).has("missing-receipt")).toBe(true);
  });

  test("rejects path-only, unrelated, commented, skipped, and unreachable receipts", () => {
    const receiptPath = "packages/rogue/test/receipt.test.ts";
    const invalidReceipts = [
      receiptPath,
      `${receiptPath}#unrelated`,
      `${receiptPath}#commented`,
      `${receiptPath}#skipped`,
      `${receiptPath}#skipped-suite`,
      `${receiptPath}#dead`,
      `${receiptPath}#false-branch`,
    ];
    const activeReceipt = `${receiptPath}#active`;
    const source = `test("different", () => {});
      // test("commented", () => {});
      test.skip("skipped", () => {});
      describe.skip("suite", () => test("skipped-suite", () => {}));
      function dead() { test("dead", () => {}); }
      if (false) { test("false-branch", () => {}); }
      describe("active suite", () => test("active", () => {}));`;
    const manifest = fixture();
    const row = required(manifest["blob-exception"][0]);
    row.testIds = [...invalidReceipts, activeReceipt];
    row.evidence = [...(row.evidence as readonly string[]), receiptPath];
    const missing = issues(manifest, new Map([[receiptPath, source]])).filter(
      (entry) => entry.family === "missing-receipt" && entry.subject === row.id,
    );
    for (const receipt of invalidReceipts)
      expect(missing.some((entry) => entry.message.startsWith(`${receipt} does`))).toBe(true);
    expect(missing.some((entry) => entry.message.startsWith(`${activeReceipt} does`))).toBe(false);
  });

  test("rejects declaration-only P2 manifest receipts", () => {
    const receiptPath = "packages/rogue/test/receipt.test.ts";
    const manifest = fixture();
    required(manifest["blob-exception"][0]).testIds = ["TC-declaration-only"];
    const declarationOnly = new Map([
      [receiptPath, `export const P2_MANIFEST_RECEIPTS = ["TC-declaration-only"];`],
    ]);
    expect(families(manifest, declarationOnly).has("missing-receipt")).toBe(true);
  });

  test("rejects an Auth writer but permits current source/registry exceptions", () => {
    const extra = new Map([
      [
        "packages/rogue/src/auth-writer.ts",
        "export function save(authStore: any) { authStore.set('token', 'raw'); }",
      ],
    ]);
    expect(families(fixture(), extra).has("auth-writer")).toBe(true);
    expect(families(fixture()).has("auth-writer")).toBe(false);
  });

  test("discriminates exact effect roles without permissive defaults", () => {
    const generated = generateFixture(
      new Map([
        [
          "packages/fixture/src/catalog.ts",
          "const catalog = new Set<string>(); export function register(value: string) { catalog.add(value); }",
        ],
      ]),
    );
    const catalog = required(
      generated["durable-surface"].find((row) => row.path === "packages/fixture/src/catalog.ts"),
    );
    expect(catalog.classification).toBe("process-local-non-authoritative-collection");
    const catalogMutation = required(
      generated["production-mutation"].find((row) => row.surfaceId === catalog.id),
    );
    expect(
      generated["effect-scope"].find((row) => row.mutationId === catalogMutation.id)?.scope,
    ).toBe("process-local-not-applicable");
    expect(() =>
      generateFixture(
        new Map([
          [
            "packages/fixture/src/writer.ts",
            "export function persist(store: { set(key: string, value: string): void }) { store.set('key', 'value'); }",
          ],
        ]),
      ),
    ).toThrow("unclassified external mutation");
    expect(() =>
      generateFixture(
        new Map([
          [
            "packages/permissive-default/src/local.ts",
            "export function persist(store: { set(key: string, value: string): void }) { store.set('key', 'value'); }",
          ],
        ]),
      ),
    ).toThrow("unclassified external mutation");
  });

  test("grounds non-authoritative classifications and writer-owned projection checkpoints", () => {
    const manifest = fixture();
    const localCollections = manifest["durable-surface"].filter(
      (row) => row.classification === "process-local-non-authoritative-collection",
    );
    expect(
      manifest["durable-surface"].some(
        (row) =>
          row.path === "packages/session/src/ledger/projection.ts" &&
          row.operation === "INSERT INTO:projection_checkpoint" &&
          row.classification === "current-target-authority",
      ),
    ).toBe(true);
    expect(
      localCollections.some(
        (row) =>
          row.path === "packages/openomni/src/evidence/verifier-registry.ts" &&
          row.operation === "add",
      ),
    ).toBe(true);
    expect(
      localCollections.some(
        (row) =>
          row.path === "packages/llm/src/auth/boundary-sanitizer.ts" && row.operation === "add",
      ),
    ).toBe(true);
    expect(
      localCollections.some(
        (row) =>
          row.path === "packages/openomni/src/execution-runtime/workspace-identity.ts" &&
          row.operation === "set",
      ),
    ).toBe(true);
    const localMutations = manifest["production-mutation"].filter((row) =>
      localCollections.some((surface) => surface.id === row.surfaceId),
    );
    expect(localMutations.length).toBeGreaterThan(0);
    expect(
      localMutations.every((mutation) =>
        manifest["effect-scope"].some(
          (scope) =>
            scope.mutationId === mutation.id && scope.scope === "process-local-not-applicable",
        ),
      ),
    ).toBe(true);

    const checkpoint = manifest["production-mutation"].filter(
      (row) =>
        row.file === "packages/session/src/ledger/projection.ts" &&
        row.operation === "INSERT INTO:projection_checkpoint",
    );
    expect(checkpoint).toHaveLength(1);
    expect(required(checkpoint[0]).writer).toBe("sole-ledger-writer");
    expect(
      manifest.projection.every(
        (row) =>
          row.caller ===
          "SynchronousLedgerWriter.applyProjections inside the authoritative append transaction",
      ),
    ).toBe(true);
    expect(JSON.stringify(manifest).includes("SqliteLedgerProjection")).toBe(false);

    const drifted = fixture();
    const local = required(
      drifted["durable-surface"].find((row) => row.id === required(localCollections[0]).id),
    );
    local.classification = "current-effect-or-runtime-state";
    expect(families(drifted).has("surface-classification")).toBe(true);
  });

  test("rejects authoritative model cache language", () => {
    const extra = new Map([
      [
        "packages/rogue/src/model-cache.ts",
        "const modelCache = new Map(); const authority = modelCache;",
      ],
    ]);
    expect(families(fixture(), extra).has("model-cache-authority")).toBe(true);
  });

  test("rejects unsafe markers", () => {
    const extra = new Map([["packages/rogue/src/unsafe.ts", "export const unsafeMarker = true;"]]);
    expect(families(fixture(), extra).has("unsafe-marker")).toBe(true);
  });

  test("rejects unscoped mutation and missing exact resolver", () => {
    const manifest = omit("effect-scope");
    expect(families(manifest).has("unscoped-mutation")).toBe(true);
    const row = fixture();
    row["effect-scope"][0] = { ...row["effect-scope"][0], resolver: "" };
    expect(families(row).has("schema")).toBe(true);
  });

  test("derives effect consumers only from executable resolved value flow", () => {
    const controller = "packages/fixture/src/unrelated-controller.ts";
    const extra = new Map([
      [
        controller,
        `import { EffectScopeRegistry as ImportedRegistry } from "@openomni/openomni";
         const Registry = ImportedRegistry;
         export function execute() {
           const registry = new Registry();
           return registry.resolve("workspace");
         }`,
      ],
    ]);
    const generated = generateFixture(extra);
    expect(
      generated["effect-scope"].some(
        (row) => row.mutationId === "none" && row.toolOrDriver === controller,
      ),
    ).toBe(true);
    const omitted = structuredClone(generated) as MutableManifest;
    const index = omitted["effect-scope"].findIndex(
      (row) => row.mutationId === "none" && row.toolOrDriver === controller,
    );
    omitted["effect-scope"].splice(index, 1);
    const fixturePath = "packages/session/test/ledger/fixture.ts";
    const fixtureSources = new Map([[fixturePath, required(sources.get(fixturePath))], ...extra]);
    expect(
      validateP2Manifest(omitted, fixtureSources).some(
        (entry) => entry.family === "effect-catalog",
      ),
    ).toBe(true);

    for (const [path, source] of [
      [
        "packages/fixture/src/shadowed-effect.ts",
        `import { EffectScopeRegistry as Registry } from "@openomni/openomni";
         export function execute(Registry: new () => unknown) { return new Registry(); }`,
      ],
      [
        "packages/fixture/src/type-only-effect.ts",
        `import type { EffectScopeRegistry as Registry } from "@openomni/openomni";
         type Alias = Registry;
         const unused: Alias | undefined = undefined;`,
      ],
      ["packages/fixture/src/effect-scope-controller.ts", "export const unrelated = true;"],
    ] as const) {
      const negative = generateFixture(new Map([[path, source]]));
      expect(
        negative["effect-scope"].some(
          (row) => row.mutationId === "none" && row.toolOrDriver === path,
        ),
      ).toBe(false);
    }
  });

  test("discriminates executable secret sink roles and rejects raw egress", () => {
    const cases = [
      ["run", `declare function emitRun(value: unknown): void; emitRun({ secret: true });`],
      [
        "Bus",
        `import { Bus as Api } from "event-api"; declare const target: Api; target.publish({ secret: true });`,
      ],
      [
        "Bus-error",
        `import { Bus as Api } from "event-api"; declare const target: Api; const error = new Error("failure"); target.publish({ error: String(error) });`,
      ],
      [
        "result",
        `declare function emitResult(value: unknown): void; emitResult({ secret: true });`,
      ],
      [
        "log",
        `import { Logger as Api } from "logging-api"; declare const target: Api; target.info("secret");`,
      ],
      [
        "IPC",
        `import { IPC as Api } from "transport-api"; declare const target: Api; target.send("secret");`,
      ],
      [
        "worker",
        `import { WorkerManager as Api } from "runtime-api"; declare const target: Api; target.deliver("secret");`,
      ],
      [
        "connector",
        `import { Connector as Api } from "connector-api"; declare const target: Api; target.request("secret");`,
      ],
    ] as const;
    for (const [_sink, source] of cases) {
      const path = "packages/fixture/src/unrelated-controller.ts";
      expect(() => generateFixture(new Map([[path, source]]))).toThrow("unsanitized secret egress");
    }
  });

  test("classifies canonical ledger facts and process-local collections without effect or sanitizer claims", () => {
    const generated = generateFixture(
      new Map([
        [
          "packages/fixture/src/canonical.ts",
          `const facts = new Map<string, string>();
           export function canonical(fact: { readonly id: string }) {
             facts.set(fact.id, fact.id);
             return JSON.stringify(fact);
           }`,
        ],
      ]),
    );
    expect(
      generated["effect-scope"].some((row) => row.scope === "process-local-not-applicable"),
    ).toBe(true);
    expect(
      generated["secret-boundary"].some(
        (row) => row.sanitizer === "not-a-secret-boundary" && row.targetShipped === true,
      ),
    ).toBe(true);
  });

  test("rejects current boundary rows without executable receipts", () => {
    const manifest = fixture();
    const boundary = required(manifest["secret-boundary"][0]);
    boundary.testIds = [];
    expect(families(manifest).has("missing-receipt")).toBe(true);
  });

  test("rejects duplicate sanitizer dispositions", () => {
    const duplicate = fixture();
    duplicate["secret-boundary"].push({
      ...duplicate["secret-boundary"][0],
      id: "boundary.second-sanitizer",
    });
    expect(families(duplicate).has("unsanitized-boundary")).toBe(true);
  });

  test("classifies SecretRegistry serialization prohibitions as exact boundary exceptions", () => {
    const generated = generateFixture(
      new Map([
        [
          "packages/llm/src/auth/secret-registry.ts",
          `export interface SecretHandle { toJSON(): never; }
          export class SecretRegistry {
            readonly toJSON = (): never => { throw new Error("prohibited"); };
            static create(): SecretRegistry {
              const handle = { toJSON(): never { throw new Error("prohibited"); } };
              return new SecretRegistry();
            }
          }`,
        ],
      ]),
    );
    const surfaces = generated["durable-surface"].filter(
      (row) => row.path === "packages/llm/src/auth/secret-registry.ts",
    );
    expect(surfaces.map((row) => row.symbol).sort()).toEqual(["<module>", "<module>", "create"]);
    expect(new Set(surfaces.map((row) => row.callsite)).size).toBe(3);
    expect(surfaces.every((row) => row.classification === "boundary-sink")).toBe(true);
    expect(surfaces.some((row) => row.symbol === "register")).toBe(false);

    const boundaries = generated["secret-boundary"].filter((row) =>
      surfaces.some((surface) => surface.id === row.surfaceId),
    );
    expect(boundaries).toHaveLength(3);
    expect(
      boundaries.every(
        (row) =>
          row.sanitizer === "throwing-secret-serialization-prohibition" &&
          row.exception ===
            "SecretRegistry and its opaque handles throw before secret custody objects can be serialized",
      ),
    ).toBe(true);

    const unrelated = generateFixture(
      new Map([
        [
          "packages/llm/src/auth/secret-registry.ts",
          `export class SecretRegistry {
            register(): void {
              const value = { toJSON(): never { throw new Error("unrelated"); } };
            }
          }`,
        ],
      ]),
    );
    expect(unrelated["secret-boundary"][0]).toMatchObject({
      status: "current",
      sanitizer: "not-a-secret-boundary",
      targetShipped: true,
    });
  });

  test("rejects native field drift and family cardinality drift", () => {
    const manifest = fixture();
    manifest["native-transition"][0] = {
      ...manifest["native-transition"][0],
      command: "kernel.alias.transition.v1",
    };
    expectFamilies(families(manifest), ["native-catalog"]);
  });

  test("rejects schema and projection aliases", () => {
    const manifest = fixture();
    manifest["final-schema"][0] = { ...manifest["final-schema"][0], objectName: "ledger_events" };
    manifest.projection[0] = { ...manifest.projection[0], projectionId: "work_projection_alias" };
    expectFamilies(families(manifest), ["schema-catalog", "projection-catalog"]);
  });

  test("rejects stale compatibility/upcast wording and production cutover claims", () => {
    const manifest = fixture();
    manifest["store-disposition"][0] = {
      ...manifest["store-disposition"][0],
      disposition: "legacy compatibility upcast",
    };
    manifest["final-schema"][0] = {
      ...manifest["final-schema"][0],
      status: "planned-p3",
      targetShipped: false,
    };

    expectFamilies(families(manifest), ["stale-compatibility", "production-claim"]);
  });

  test.each([
    "_migrations",
    "schema_meta",
    "artifact_reference_projection",
    "actor_identity_projection",
    "actor_endpoint_projection",
    "blacklist_projection",
    "channel_grant_projection",
    "connector_installation_projection",
  ])("rejects omission of production baseline table %s", (table) => {
    const baselinePath = "packages/session/migration/0001_p2_clean_baseline/migration.sql";
    const omitted = new Map(sources);
    omitted.set(
      baselinePath,
      required(sources.get(baselinePath)).replace(
        new RegExp(`CREATE TABLE ${table}\\s*\\([\\s\\S]*?\\) STRICT;\\n`),
        "",
      ),
    );
    expect(() => generateP2Manifest(omitted)).toThrow(
      `missing STRICT baseline table DDL: ${table}`,
    );
  });

  test.each([
    "AF",
    "AI",
    "AE",
    "BL",
    "CG",
    "CI",
  ])("rejects omission from non-core family %s", (family) => {
    const manifest = fixture();
    const index = manifest["native-transition"].findIndex((row) =>
      String(row.catalogId).startsWith(`${family}-`),
    );
    manifest["native-transition"].splice(index, 1);
    expect(families(manifest).has("native-catalog")).toBe(true);
  });

  test("rejects P3 export/caller/move aliases", () => {
    const manifest = fixture();
    manifest["p3-disposition"][0] = {
      ...manifest["p3-disposition"][0],
      export: "CompatibilityLedger",
    };
    expectFamilies(families(manifest), ["p3-catalog", "package-export"]);
  });
  test("normalizes DB run targets with quoted and schema-qualified identifiers", () => {
    const path = "packages/rogue/src/quoted-run.ts";
    const discovered = discoverP2Producers(
      new Map([
        [
          path,
          `export function write(db: any) { db.run('UPDATE "main"."LEDGER_HEAD" SET owner_seq = 2'); }`,
        ],
      ]),
    );
    expect(
      discovered.some((row) => row.kind === "dml" && row.operation === "UPDATE:ledger_head"),
    ).toBe(true);
    expect(
      families(
        fixture(),
        new Map([
          [
            path,
            `export function write(db: any) { db.run('UPDATE "main"."LEDGER_HEAD" SET owner_seq = 2'); }`,
          ],
        ]),
      ).has("second-writer"),
    ).toBe(true);
  });

  test("discovers direct, aliased, destructured, and computed producer calls by binding", () => {
    const discovered = discoverP2Producers(
      new Map([
        [
          "packages/fixture/src/calls.tsx",
          `import { writeFile as saveDirect } from "node:fs";
           export function calls(fs: any) {
             saveDirect("a", "b");
             const save = saveDirect; save("c", "d");
             const { writeFile: picked } = fs; picked("e", "f");
             fs["writeFile"]("g", "h");
           }`,
        ],
      ]),
    );
    expect(discovered.filter((row) => row.kind === "filesystem")).toHaveLength(4);
    expect(new Set(discovered.map((row) => row.callsite)).size).toBeGreaterThanOrEqual(4);
  });

  test("scanner trivia masking preserves offsets without treating string or template markers as comments", () => {
    const path = "packages/fixture/src/comment-markers.ts";
    const discovered = discoverP2Producers(
      new Map([
        [
          path,
          `export function write(store: Map<string, string>) {
             const slash = "// not a comment";
             const block = \`/* not a comment */\`;
             // store.set("commented", slash);
             /* store.set("also-commented", block); */
             store.set("live", slash + block);
           }`,
        ],
      ]),
    ).filter((row) => row.kind === "mutator" && row.operation === "set");
    expect(discovered).toHaveLength(1);
    expect(required(discovered[0]).callsite).toBe("6:14");
  });

  test("keeps same-operation callsites distinct while classifying process-local maps", () => {
    const discovered = discoverP2Producers(
      new Map([
        [
          "packages/session/src/ledger/projection.ts",
          `export function createLedgerProjection(definitions: Map<string, string>, rogue: Map<string, string>) {
             definitions.set("safe", "value");
             rogue.set("unsafe", "value");
           }`,
        ],
      ]),
    ).filter((row) => row.kind === "mutator" && row.operation === "set");
    expect(discovered).toHaveLength(2);
    expect(new Set(discovered.map((row) => row.id)).size).toBe(2);
    expect(discovered.every((row) => row.authority === "internal-collection")).toBe(true);
  });

  test("classifies exact sanitizer Set writes as process-local custody state", () => {
    const discovered = discoverP2Producers(
      new Map([
        [
          "packages/llm/src/auth/boundary-sanitizer.ts",
          `export class BoundarySanitizer {
             readonly #strings = new Set<string>();

             registerExactSecret(form: string): void {
               this.#strings.add(form);
               this.#strings.add(form);
             }
           }`,
        ],
      ]),
    ).filter((row) => row.kind === "mutator" && row.operation === "add");
    expect(discovered).toHaveLength(2);
    expect(discovered.every((row) => row.authority === "internal-collection")).toBe(true);
  });

  test("grants crypto exemption only to aliased node:crypto imports and denies local or shadowed factories", () => {
    const discovered = discoverP2Producers(
      new Map([
        [
          "packages/fixture/src/hash.ts",
          `import { createHmac as importedHmac } from "node:crypto";
           export function sign(fake: { update(value: string): void }) {
             const mac = importedHmac("sha256", "key");
             mac.update("safe");
             fake.update("unsafe");
           }
           export function local() {
             const createHash = () => ({ update(_value: string) {} });
             const hash = createHash();
             hash.update("local");
           }
           export function shadow() {
             const importedHmac = () => ({ update(_value: string) {} });
             const mac = importedHmac();
             mac.update("shadowed");
           }`,
        ],
      ]),
    ).filter((row) => row.kind === "mutator" && row.operation === "update");
    expect(discovered.map((row) => row.authority).sort()).toEqual([
      "authoritative",
      "authoritative",
      "authoritative",
      "cryptographic-builder",
    ]);
  });

  test("environment aliases respect lexical shadowing and reassignment", () => {
    const discovered = discoverP2Producers(
      new Map([
        [
          "packages/fixture/src/env-reassign.ts",
          `export function read() {
             let env = process.env;
             consume(env.FIRST);
             env = { SECOND: "not-secret" };
             consume(env.SECOND);
             { const env = { THIRD: "not-secret" }; consume(env.THIRD); }
           }`,
        ],
      ]),
    ).filter((row) => row.kind === "environment");
    expect(discovered.map((row) => row.operation)).toEqual(["env.FIRST"]);
  });

  test("discovers executable SQL in an arbitrary repository SQL root and fails closed dynamically", () => {
    const discovered = discoverP2Producers(
      new Map([
        ["schema/root/bootstrap.sql", "DELETE FROM [main].[ledger_request];"],
        [
          "packages/fixture/src/dynamic.ts",
          "export function run(database: Database, statement: string) { database.run(statement); }",
        ],
      ]),
    );
    expect(discovered.some((row) => row.operation === "DELETE FROM:ledger_request")).toBe(true);
    expect(discovered.some((row) => row.operation === "UNRESOLVED-SQL")).toBe(true);
  });

  test("rejects textual P3 export lookalikes and native lifecycle metadata drift", () => {
    const p3 = fixture();
    const module = "packages/openomni/src/dispatch/index.ts";
    const fakeModule = 'const note = "DispatchRuntime";';
    expect(families(p3, new Map([[module, fakeModule]])).has("package-export")).toBe(true);

    const native = fixture();
    required(native["native-transition"][0]).evidence = ["packages/rogue/src/fake.ts"];
    expect(families(native).has("native-catalog")).toBe(true);
  });
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("required conformance fixture is missing");
  return value;
}
