/**
 * Kernel-contract conformance gate — P0 increments (#467).
 *
 * Checks (numbering follows the issue):
 *   1. vocab-ratchet     protocol namespace ↔ core-model Tier-1/2 noun (injective),
 *                        grandfathered baseline + no-new-violations ratchet
 *   2. tool-lint         LLM tool surface: snake_case ≤3 segments, description
 *                        required, ≤5 public input fields; protocol naming rules
 *                        (banned nouns, no *Module wrappers) with the same ratchet
 *   6. earned-check      every dispatch action constant / registered tool has ≥1
 *                        non-definition production reference, or is baselined
 *   7. schema-snapshot   Greg Young lint: no field disappears/renames on existing
 *                        protocol event/schema types; new types and added fields
 *                        pass; `--update` regenerates the snapshot (Owner-review
 *                        moment)
 *
 * Modes:
 *   bun run script/lint-tools.ts               run all checks
 *   bun run script/lint-tools.ts --update      regenerate schema snapshot
 *   bun run script/lint-tools.ts --self-test   discrimination bench: every check
 *                                              must flag its known-bad fixture
 *
 * The verifier registry and replay-conformance primitives land independently
 * under #467 while this P0 gate remains active. #493 owns archived
 * projection/replay integration.
 */

import { readFileSync, writeFileSync } from "node:fs";

interface Violation {
  readonly check: "vocab-ratchet" | "tool-lint" | "naming" | "earned-check" | "schema-snapshot";
  readonly subject: string;
  readonly message: string;
}

interface Baseline {
  readonly vocab: { readonly unmappedNamespaces: readonly string[] };
  readonly tools: { readonly exceptions: Readonly<Record<string, readonly string[]>> };
  readonly naming: { readonly grandfathered: readonly string[] };
  readonly earned: {
    readonly dormantActions: readonly string[];
    readonly dormantTools: readonly string[];
  };
}

type SchemaSnapshot = Readonly<Record<string, readonly string[]>>;

const BASELINE_PATH = "script/conformance/lint-tools-baseline.json";
const SNAPSHOT_PATH = "script/conformance/schema-snapshot.json";
const PROTOCOL_SRC = "packages/protocol/src";
const CORE_MODEL_PATH = "docs/core-model.md";
const PRODUCTION_ROOTS = ["packages", "apps"];
const EXCLUDED_PATH_PARTS = ["/dist/", "/node_modules/", "/coverage/", "/generated/"];
const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".bench.ts"];

// ---------------------------------------------------------------------------
// check 1 — vocab ratchet
// ---------------------------------------------------------------------------

export function extractTierNouns(coreModelSource: string): Set<string> {
  const nouns = new Set<string>();
  const tierLines = coreModelSource
    .split("\n")
    .filter((line) => line.startsWith("**Tier 1") || line.startsWith("**Tier 2"));
  for (const line of tierLines) {
    const body = line.replace(/\*\*Tier \d[^*]*\*\*/, "");
    for (const match of body.matchAll(/[A-Z][A-Za-z]+/g)) {
      nouns.add(match[0]);
    }
  }
  return nouns;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[-_]/g, "");
}

export function unmappedNamespaces(
  namespaces: readonly string[],
  tierNouns: ReadonlySet<string>,
): string[] {
  const normalizedNouns = new Set(Array.from(tierNouns, normalizeToken));
  return namespaces.filter((namespace) => !normalizedNouns.has(normalizeToken(namespace)));
}

async function listProtocolNamespaces(): Promise<string[]> {
  const dirs = new Set<string>();
  const glob = new Bun.Glob(`${PROTOCOL_SRC}/*/index.ts`);
  for await (const filePath of glob.scan({ cwd: ".", onlyFiles: true })) {
    const segments = filePath.split("/");
    const dir = segments[segments.length - 2];
    if (dir) {
      dirs.add(dir);
    }
  }
  return Array.from(dirs).sort((a, b) => a.localeCompare(b));
}

async function checkVocabRatchet(baseline: Baseline): Promise<Violation[]> {
  const namespaces = await listProtocolNamespaces();
  const tierNouns = extractTierNouns(readFileSync(CORE_MODEL_PATH, "utf8"));
  const unmapped = unmappedNamespaces(namespaces, tierNouns);
  const grandfathered = new Set(baseline.vocab.unmappedNamespaces);

  const violations: Violation[] = unmapped
    .filter((namespace) => !grandfathered.has(namespace))
    .map((namespace) => ({
      check: "vocab-ratchet" as const,
      subject: namespace,
      message:
        "new protocol namespace maps to no core-model Tier-1/2 noun (injective namespace→noun); " +
        "either name it after a vocabulary noun or get Owner sign-off on a core-model addition",
    }));

  for (const stale of baseline.vocab.unmappedNamespaces) {
    if (!unmapped.includes(stale)) {
      violations.push({
        check: "vocab-ratchet",
        subject: stale,
        message: "baseline entry no longer unmapped — shrink the baseline (ratchet only tightens)",
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// check 2 — tool lint + protocol naming rules
// ---------------------------------------------------------------------------

export interface ToolSurface {
  readonly name: string;
  readonly description: string | undefined;
  readonly inputSchema: Record<string, unknown>;
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._][a-z][a-z0-9]*){0,2}$/;
const MAX_PUBLIC_FIELDS = 5;

function topLevelFieldCount(schema: Record<string, unknown>): number {
  const variants = Array.isArray(schema.oneOf)
    ? (schema.oneOf as Record<string, unknown>[])
    : [schema];
  let max = 0;
  for (const variant of variants) {
    const properties = variant.properties as Record<string, unknown> | undefined;
    max = Math.max(max, properties ? Object.keys(properties).length : 0);
  }
  return max;
}

export interface ToolLintFailure {
  readonly rule: "tool-name" | "tool-description" | "tool-max-fields";
  readonly message: string;
}

export function lintToolSurface(tool: ToolSurface): ToolLintFailure[] {
  const failures: ToolLintFailure[] = [];
  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    failures.push({
      rule: "tool-name",
      message: "name must be snake_case (dot namespacing allowed), ≤3 segments",
    });
  }
  if (!tool.description || tool.description.trim().length === 0) {
    failures.push({ rule: "tool-description", message: "description is required" });
  }
  if (topLevelFieldCount(tool.inputSchema) > MAX_PUBLIC_FIELDS) {
    failures.push({
      rule: "tool-max-fields",
      message: `public input schema exceeds ${MAX_PUBLIC_FIELDS} top-level fields`,
    });
  }
  // enum-over-free-string is not statically decidable from a JSON schema alone
  // (whether an axis *has* a finite vocabulary is a design fact) — reviewed, not linted.
  return failures;
}

async function collectToolSurfaces(): Promise<ToolSurface[]> {
  const { SystemToolProvider, AgentToolProvider, createChildAgentTool } = await import(
    "../packages/openomni/src/execution-runtime/tool/index.js"
  );

  const stubDispatchRuntime = {
    submit: () => Promise.reject(new Error("lint-only stub")),
  };
  const stubChildRuntime = {} as never;

  const tools = [
    ...new SystemToolProvider("/").listTools(),
    ...new AgentToolProvider({ dispatchRuntime: stubDispatchRuntime }).listTools(),
    createChildAgentTool(stubChildRuntime),
  ];

  return tools.map((tool) => ({
    name: tool.spec.name,
    description: tool.spec.description,
    inputSchema: tool.spec.inputSchema as Record<string, unknown>,
  }));
}

async function checkToolLint(baseline: Baseline): Promise<Violation[]> {
  const surfaces = await collectToolSurfaces();
  const violations: Violation[] = [];

  for (const surface of surfaces) {
    const exceptions = new Set(baseline.tools.exceptions[surface.name] ?? []);
    for (const failure of lintToolSurface(surface)) {
      if (!exceptions.has(failure.rule)) {
        violations.push({
          check: "tool-lint",
          subject: surface.name,
          message: `[${failure.rule}] ${failure.message}`,
        });
      }
    }
  }

  return violations;
}

const BANNED_NOUN_PATTERN =
  /\b(?:export\s+(?:const|type|interface|class|enum|namespace))\s+([A-Za-z]*(?:Runtime|Task|Envelope)[A-Za-z]*|[A-Za-z]+Module)\b/g;

export function namingOffenders(filePath: string, source: string): string[] {
  const offenders = new Set<string>();
  for (const match of source.matchAll(BANNED_NOUN_PATTERN)) {
    offenders.add(`${filePath}:${match[1]}`);
  }
  return Array.from(offenders);
}

async function checkNaming(baseline: Baseline): Promise<Violation[]> {
  const grandfathered = new Set(baseline.naming.grandfathered);
  const violations: Violation[] = [];
  const glob = new Bun.Glob(`${PROTOCOL_SRC}/**/*.ts`);
  for await (const filePath of glob.scan({ cwd: ".", onlyFiles: true })) {
    if (TEST_SUFFIXES.some((suffix) => filePath.endsWith(suffix))) {
      continue;
    }
    const source = await Bun.file(filePath).text();
    for (const offender of namingOffenders(filePath, source)) {
      if (!grandfathered.has(offender)) {
        violations.push({
          check: "naming",
          subject: offender,
          message:
            "new protocol identifier uses a banned noun (runtime/task/envelope) or a *Module wrapper name (#465 naming rules)",
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// check 6 — earned check
// ---------------------------------------------------------------------------

async function collectProductionSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const root of PRODUCTION_ROOTS) {
    const glob = new Bun.Glob(`${root}/*/src/**/*.ts`);
    for await (const filePath of glob.scan({ cwd: ".", onlyFiles: true })) {
      if (
        TEST_SUFFIXES.some((suffix) => filePath.endsWith(suffix)) ||
        EXCLUDED_PATH_PARTS.some((part) => filePath.includes(part))
      ) {
        continue;
      }
      sources.set(filePath, await Bun.file(filePath).text());
    }
  }
  return sources;
}

function parseDispatchActions(source: string): Map<string, string> {
  const actions = new Map<string, string>();
  const block = source.match(/export const Actions = \{([\s\S]*?)\} as const/);
  if (!block?.[1]) {
    return actions;
  }
  for (const entry of block[1].matchAll(/(\w+):\s*"([^"]+)"/g)) {
    const key = entry[1];
    const value = entry[2];
    if (key && value) {
      actions.set(key, value);
    }
  }
  return actions;
}

export function referenceCount(
  sources: ReadonlyMap<string, string>,
  needles: readonly string[],
  definitionPath: string,
): number {
  let count = 0;
  for (const [filePath, source] of sources) {
    if (filePath === definitionPath) {
      continue;
    }
    if (needles.some((needle) => source.includes(needle))) {
      count += 1;
    }
  }
  return count;
}

async function checkEarned(baseline: Baseline): Promise<Violation[]> {
  const sources = await collectProductionSources();
  const violations: Violation[] = [];

  const dispatchIndexPath = `${PROTOCOL_SRC}/dispatch/index.ts`;
  const actions = parseDispatchActions(readFileSync(dispatchIndexPath, "utf8"));
  const dormantActions = new Set(baseline.earned.dormantActions);
  for (const [key, value] of actions) {
    const referenced =
      referenceCount(sources, [`Actions.${key}`, `"${value}"`], dispatchIndexPath) > 0;
    if (!referenced && !dormantActions.has(value)) {
      violations.push({
        check: "earned-check",
        subject: value,
        message:
          "dispatch action constant has zero non-definition production references — a new verb needs a real consumer (abstraction is earned)",
      });
    }
    if (referenced && dormantActions.has(value)) {
      violations.push({
        check: "earned-check",
        subject: value,
        message: "baselined-dormant action now has consumers — shrink the baseline",
      });
    }
  }

  const surfaces = await collectToolSurfaces();
  const dormantTools = new Set(baseline.earned.dormantTools);
  const toolDefinitionRoot = "packages/openomni/src/execution-runtime/tool/";
  for (const surface of surfaces) {
    const referencingFiles = Array.from(sources.entries()).filter(
      ([filePath, source]) =>
        !filePath.startsWith(toolDefinitionRoot) && source.includes(`"${surface.name}"`),
    );
    if (referencingFiles.length === 0 && !dormantTools.has(surface.name)) {
      violations.push({
        check: "earned-check",
        subject: surface.name,
        message:
          "registered tool has zero references outside the tool pipeline — a new tool needs a real consumer",
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// check 7 — schema snapshot (Greg Young lint)
// ---------------------------------------------------------------------------

interface ZodObjectLike {
  readonly shape?: Record<string, unknown>;
  readonly options?: readonly unknown[];
  readonly safeParse?: unknown;
  readonly _def?: Readonly<Record<string, unknown>>;
}

function isZodSchema(value: unknown): value is ZodObjectLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ZodObjectLike).safeParse === "function"
  );
}

function shapeKeys(schema: ZodObjectLike, seen: Set<unknown> = new Set()): string[] | undefined {
  if (seen.has(schema)) return undefined;
  seen.add(schema);
  if (schema.shape && typeof schema.shape === "object") {
    return Object.keys(schema.shape).sort((a, b) => a.localeCompare(b));
  }
  for (const candidate of [
    schema._def?.schema,
    schema._def?.innerType,
    schema._def?.type,
    schema._def?.out,
  ]) {
    if (isZodSchema(candidate)) {
      const keys = shapeKeys(candidate, seen);
      if (keys) return keys;
    }
  }
  return undefined;
}

export async function buildSchemaSnapshot(): Promise<SchemaSnapshot> {
  const protocol = (await import("../packages/protocol/src/index.js")) as Record<string, unknown>;
  const snapshot: Record<string, readonly string[]> = {};

  for (const [namespaceName, namespaceValue] of Object.entries(protocol)) {
    if (typeof namespaceValue !== "object" || namespaceValue === null) {
      continue;
    }
    for (const [exportName, exportValue] of Object.entries(namespaceValue)) {
      if (!isZodSchema(exportValue)) {
        continue;
      }
      const keys = shapeKeys(exportValue);
      if (keys) {
        snapshot[`${namespaceName}.${exportName}`] = keys;
        continue;
      }
      if (Array.isArray(exportValue.options)) {
        exportValue.options.forEach((option, index) => {
          if (isZodSchema(option)) {
            const optionKeys = shapeKeys(option);
            if (optionKeys) {
              snapshot[`${namespaceName}.${exportName}#${index}`] = optionKeys;
            }
          }
        });
      }
    }
  }

  return Object.fromEntries(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b)));
}

export function diffSnapshots(previous: SchemaSnapshot, current: SchemaSnapshot): Violation[] {
  const violations: Violation[] = [];
  for (const [typeName, previousFields] of Object.entries(previous)) {
    const currentFields = current[typeName];
    if (!currentFields) {
      violations.push({
        check: "schema-snapshot",
        subject: typeName,
        message:
          "protocol type disappeared from the snapshot — removing/renaming an event type silently corrupts the ledger fold; introduce a new type and upcast on read (run --update only with Owner sign-off)",
      });
      continue;
    }
    const currentSet = new Set(currentFields);
    const removed = previousFields.filter((field) => !currentSet.has(field));
    if (removed.length > 0) {
      violations.push({
        check: "schema-snapshot",
        subject: typeName,
        message: `field(s) removed or renamed: ${removed.join(", ")} — a changed meaning is a new event type; shape evolution is upcast-on-read (run --update only with Owner sign-off)`,
      });
    }
  }
  return violations;
}

async function checkSchemaSnapshot(): Promise<Violation[]> {
  const previous = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as SchemaSnapshot;
  const current = await buildSchemaSnapshot();
  return diffSnapshots(previous, current);
}

// ---------------------------------------------------------------------------
// self-test — every check must flag a known-bad fixture (discrimination bench)
// ---------------------------------------------------------------------------

function selfTest(): void {
  const failures: string[] = [];

  const nouns = extractTierNouns(
    "**Tier 1 (philosophy):** Actor, Ledger.\n**Tier 2 (specification):** Wait, WorkItem.",
  );
  if (unmappedNamespaces(["actor", "totally-new-thing"], nouns).join() !== "totally-new-thing") {
    failures.push("vocab-ratchet did not flag an unmapped namespace");
  }
  if (unmappedNamespaces(["work-item"], nouns).length !== 0) {
    failures.push("vocab-ratchet flagged a mapped namespace (work-item→WorkItem)");
  }

  const badTool: ToolSurface = {
    name: "DoThingNowFastPlease",
    description: "",
    inputSchema: {
      type: "object",
      properties: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {} },
    },
  };
  if (lintToolSurface(badTool).length !== 3) {
    failures.push("tool-lint did not flag name/description/field-count on a known-bad tool");
  }
  if (
    lintToolSurface({
      name: "read",
      description: "ok",
      inputSchema: { type: "object", properties: { path: {} } },
    }).length !== 0
  ) {
    failures.push("tool-lint flagged a known-good tool");
  }

  if (namingOffenders("x.ts", "export const FooTaskEnvelope = 1;").length === 0) {
    failures.push("naming lint did not flag a banned noun");
  }
  if (namingOffenders("x.ts", "export const WaitSchema = 1;").length !== 0) {
    failures.push("naming lint flagged a clean identifier");
  }

  const sources = new Map([["a.ts", 'registry.register("worker.spawn", handler)']]);
  if (referenceCount(sources, ['"worker.spawn"'], "def.ts") !== 1) {
    failures.push("earned-check reference counter missed a real consumer");
  }
  if (referenceCount(sources, ['"worker.never"'], "def.ts") !== 0) {
    failures.push("earned-check reference counter hallucinated a consumer");
  }

  const snapshotViolations = diffSnapshots(
    { "Tool.Call": ["id", "input", "tool"] },
    { "Tool.Call": ["id", "payload", "tool"] },
  );
  if (snapshotViolations.length !== 1 || !snapshotViolations[0]?.message.includes("input")) {
    failures.push("schema-snapshot did not flag a field rename");
  }
  if (diffSnapshots({ "Tool.Call": ["id"] }, { "Tool.Call": ["id", "extra"] }).length !== 0) {
    failures.push("schema-snapshot flagged an additive change");
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`SELF-TEST FAIL: ${failure}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    "OK: lint-tools self-test — all checks discriminate on known-bad fixtures\n",
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (args.has("--self-test")) {
    selfTest();
    return;
  }

  if (args.has("--update")) {
    const snapshot = await buildSchemaSnapshot();
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    process.stdout.write(
      `OK: schema snapshot regenerated (${Object.keys(snapshot).length} types) — this diff is the Owner-sign-off surface\n`,
    );
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  const violations = [
    ...(await checkVocabRatchet(baseline)),
    ...(await checkToolLint(baseline)),
    ...(await checkNaming(baseline)),
    ...(await checkEarned(baseline)),
    ...(await checkSchemaSnapshot()),
  ];

  if (violations.length === 0) {
    process.stdout.write(
      "OK: conformance lint — vocab ratchet, tool lint, naming, earned, schema snapshot\n",
    );
    return;
  }

  for (const violation of violations) {
    process.stderr.write(
      `VIOLATION [${violation.check}] ${violation.subject} — ${violation.message}\n`,
    );
  }
  process.exit(1);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${message}\n`);
    process.exit(1);
  });
}
