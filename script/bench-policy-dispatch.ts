#!/usr/bin/env bun
// Policy dispatch cost as a function of conversation history length.
//
// Every lifecycle point the agent loop dispatches carries the run's message
// history in its context. If dispatch cost tracks that history, a run pays
// O(turns² · messages) over its lifetime — the loop dispatches ~12 points per
// turn and the history grows every turn.
//
// The headline number is `growthFactor`: dispatch cost at the largest history
// divided by cost at the smallest. Constant-cost dispatch scores ~1.
//
// Usage:
//   bun run script/bench-policy-dispatch.ts [--out <path>] [--iterations <n>]

import { PolicyEngine } from "../packages/policy/src/index";
import type {
  CanonicalPolicyRegistrationGeneric,
  GenericPolicyContext,
} from "../packages/policy/src/index";
import { PolicyDecision } from "../packages/protocol/src/index";
import type { Message, Policy } from "../packages/protocol/src/index";

const HISTORY_SIZES = [8, 64, 512] as const;
const REGISTERED_POLICY_COUNTS = [0, 1, 3] as const;
/**
 * `minimal` carries only the two cheap string correlation fields (`sessionId`,
 * `runId`); `correlated` adds the object-valued ones a real dispatch carries.
 * They diverge sharply once a point stops materializing its context, because
 * correlation capture then becomes the whole cost.
 */
const CONTEXT_SHAPES = ["minimal", "correlated"] as const;
const DEFAULT_ITERATIONS = 2000;
const WARMUP_ITERATIONS = 200;
/**
 * A single pass through the cells is order-biased: on a ~µs operation the cell
 * measured last is fastest because JIT and GC warm-up dominate. Rounds are
 * rotated so no cell is always first, but the median is what removes the bias —
 * only round 0 is cold, so it is discarded as an outlier of five.
 */
const REPEATS = 5;
const PART_TEXT = "x".repeat(400);

type ContextShape = (typeof CONTEXT_SHAPES)[number];

interface Args {
  readonly outPath?: string;
  readonly iterations: number;
}

function parseArgs(argv: readonly string[]): Args {
  let outPath: string | undefined;
  let iterations = DEFAULT_ITERATIONS;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== "--out" && flag !== "--iterations") {
      throw new Error(`unknown argument: ${flag} (usage: [--out <path>] [--iterations <n>])`);
    }
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--out") {
      outPath = value;
    } else {
      iterations = Number(value);
      if (!Number.isInteger(iterations) || iterations <= 0) {
        throw new Error("--iterations must be a positive integer");
      }
    }
    i += 1;
  }
  return { outPath, iterations };
}

function buildHistory(messageCount: number, sessionID: string): Message.WithParts[] {
  const history: Message.WithParts[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    const id = `msg-${index}`;
    const role = index % 2 === 0 ? "user" : "assistant";
    history.push({
      info: {
        id,
        sessionID,
        role,
        time: { created: 1_700_000_000_000 + index },
        agent: "bench",
        model: { providerID: "bench", modelID: "bench" },
        ...(role === "assistant"
          ? { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
          : {}),
      } as Message.Info,
      parts: [{ id: `${id}-part`, sessionID, messageID: id, type: "text", text: PART_TEXT }],
    });
  }
  return history;
}

/**
 * A policy that reads nothing from the context. Dispatch overhead measured with
 * these registered is pure engine cost, not policy cost.
 */
function inertPolicy(index: number): CanonicalPolicyRegistrationGeneric<GenericPolicyContext> {
  return {
    kind: "point",
    name: `bench:inert-${index}`,
    pointIds: ["run.turn.pre"],
    effectCapabilities: { "run.turn.pre": [] },
    priority: index,
    fn: () => PolicyDecision.allow({ policyId: `bench.inert.${index}` }),
  };
}

/**
 * Binds a no-op `auditEmit`, matching the agent loop and the dispatch runtime.
 * That is the conservative configuration: an engine with audit unbound — the
 * completion-admission engine is built as `PolicyEngine.create()` with no
 * options — skips correlation capture entirely and measures faster.
 */
function createEngine() {
  return PolicyEngine.create({ auditEmit: () => undefined });
}

interface Cell {
  readonly shape: ContextShape;
  readonly registeredPolicies: number;
  readonly messageCount: number;
}

/**
 * The dispatch parameter shape for `run.turn.pre`, derived from the protocol's
 * point-input contract so the bench context can never drift from what
 * `dispatchPoint` actually requires.
 */
type RunTurnPreContext = GenericPolicyContext &
  Policy.PolicyPointInputMap["run.turn.pre"] &
  Record<string, unknown>;

function buildContext(cell: Cell): RunTurnPreContext {
  const sessionID = "bench-session";
  const base = {
    sessionId: sessionID,
    runId: "bench-run",
    actorId: "bench-actor",
    turnIndex: 0,
    messages: buildHistory(cell.messageCount, sessionID),
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
  if (cell.shape === "minimal") return base;
  return {
    ...base,
    traceContext: { traceId: "bench-trace", sessionId: sessionID, runId: "bench-run" },
    resourceDescriptor: {
      id: "tool:bench",
      kind: "tool",
      labels: ["source:agent"],
      capabilities: [],
      effects: [],
    },
    correlation: { dispatchId: "bench-dispatch" },
  };
}

function buildEngine(cell: Cell): ReturnType<typeof createEngine> {
  const engine = createEngine();
  for (let index = 0; index < cell.registeredPolicies; index += 1) {
    engine.register(inertPolicy(index));
  }
  return engine;
}

async function measureNsPerDispatch(cell: Cell, iterations: number): Promise<number> {
  const engine = buildEngine(cell);
  const context = buildContext(cell);

  // Guard every measured cell, not just one: a context the point contract
  // rejects short-circuits dispatch, and the artifact would record that path's
  // timings as if they were normal dispatch.
  assertDispatchAllowed(await engine.dispatchPoint("run.turn.pre", context));

  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
    await engine.dispatchPoint("run.turn.pre", context);
  }

  const start = Bun.nanoseconds();
  for (let i = 0; i < iterations; i += 1) {
    await engine.dispatchPoint("run.turn.pre", context);
  }
  return (Bun.nanoseconds() - start) / iterations;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function cellKey(cell: Cell): string {
  return `${cell.shape}/${cell.registeredPolicies}/${cell.messageCount}`;
}

/** Rotates the cell order each round so no cell is always measured cold or last. */
async function measureAllCells(
  cells: readonly Cell[],
  iterations: number,
): Promise<Map<string, number>> {
  const samples = new Map<string, number[]>();
  for (let round = 0; round < REPEATS; round += 1) {
    for (let offset = 0; offset < cells.length; offset += 1) {
      const cell = cells[(offset + round) % cells.length];
      if (cell === undefined) continue;
      const sample = await measureNsPerDispatch(cell, iterations);
      const key = cellKey(cell);
      samples.set(key, [...(samples.get(key) ?? []), sample]);
    }
  }
  return new Map([...samples].map(([key, values]) => [key, Number(median(values).toFixed(1))]));
}

async function gitHead(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  return (await new Response(proc.stdout).text()).trim() || "unknown";
}

function assertDispatchAllowed(decision: Policy.PolicyDecision): void {
  if (decision.verdict !== "allow") {
    throw new Error(`bench context was rejected by the point contract: ${decision.reasonCodes}`);
  }
}

if (import.meta.main) {
  const { outPath, iterations } = parseArgs(process.argv.slice(2));

  const cells: Cell[] = [];
  for (const shape of CONTEXT_SHAPES) {
    for (const registeredPolicies of REGISTERED_POLICY_COUNTS) {
      for (const messageCount of HISTORY_SIZES) {
        cells.push({ shape, registeredPolicies, messageCount });
      }
    }
  }

  const measured = await measureAllCells(cells, iterations);

  const scenarios: Array<{
    contextShape: ContextShape;
    registeredPolicies: number;
    nsPerDispatchByHistorySize: Record<string, number>;
    growthFactor: number;
  }> = [];
  for (const shape of CONTEXT_SHAPES) {
    for (const registeredPolicies of REGISTERED_POLICY_COUNTS) {
      const byHistory: Record<string, number> = {};
      for (const messageCount of HISTORY_SIZES) {
        byHistory[String(messageCount)] =
          measured.get(cellKey({ shape, registeredPolicies, messageCount })) ?? 0;
      }
      const smallest = byHistory[String(HISTORY_SIZES[0])] ?? 0;
      const largest = byHistory[String(HISTORY_SIZES.at(-1))] ?? 0;
      scenarios.push({
        contextShape: shape,
        registeredPolicies,
        nsPerDispatchByHistorySize: byHistory,
        growthFactor: Number((largest / smallest).toFixed(2)),
      });
    }
  }

  const result = {
    benchmark: "policy-dispatch-history-scaling",
    measuredAt: new Date().toISOString(),
    commit: await gitHead(),
    platform: `${process.platform}/${process.arch} bun ${process.versions.bun}`,
    point: "run.turn.pre",
    iterations,
    repeats: REPEATS,
    aggregate: "median",
    historySizes: HISTORY_SIZES,
    scenarios,
  };

  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outPath) {
    await Bun.write(outPath, serialized);
    console.log(`[bench-policy-dispatch] wrote ${outPath}`);
  }
  console.log(serialized);
}
