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
const DEFAULT_ITERATIONS = 2000;
const WARMUP_ITERATIONS = 200;
const PART_TEXT = "x".repeat(400);

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

function createEngine() {
  return PolicyEngine.create({ audit: false });
}

async function measureNsPerDispatch(
  messageCount: number,
  registeredPolicies: number,
  iterations: number,
): Promise<number> {
  const engine = createEngine();
  for (let index = 0; index < registeredPolicies; index += 1) {
    engine.register(inertPolicy(index));
  }

  const sessionID = "bench-session";
  const context = {
    sessionId: sessionID,
    runId: "bench-run",
    actorId: "bench-actor",
    turnIndex: 0,
    messages: buildHistory(messageCount, sessionID),
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };

  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
    await engine.dispatchPoint("run.turn.pre", context);
  }

  const start = Bun.nanoseconds();
  for (let i = 0; i < iterations; i += 1) {
    await engine.dispatchPoint("run.turn.pre", context);
  }
  return (Bun.nanoseconds() - start) / iterations;
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

  // Fail loudly if the bench context stops satisfying the point contract —
  // otherwise the numbers would measure the contract-rejection path.
  const probe = createEngine();
  assertDispatchAllowed(
    await probe.dispatchPoint("run.turn.pre", {
      sessionId: "bench-session",
      runId: "bench-run",
      turnIndex: 0,
      messages: buildHistory(1, "bench-session"),
    }),
  );

  const scenarios: Array<{
    registeredPolicies: number;
    nsPerDispatchByHistorySize: Record<string, number>;
    growthFactor: number;
  }> = [];
  for (const registeredPolicies of REGISTERED_POLICY_COUNTS) {
    const byHistory: Record<string, number> = {};
    for (const messageCount of HISTORY_SIZES) {
      byHistory[String(messageCount)] = Number(
        (await measureNsPerDispatch(messageCount, registeredPolicies, iterations)).toFixed(1),
      );
    }
    const smallest = byHistory[String(HISTORY_SIZES[0])] ?? 0;
    const largest = byHistory[String(HISTORY_SIZES.at(-1))] ?? 0;
    scenarios.push({
      registeredPolicies,
      nsPerDispatchByHistorySize: byHistory,
      growthFactor: Number((largest / smallest).toFixed(2)),
    });
  }

  const result = {
    benchmark: "policy-dispatch-history-scaling",
    measuredAt: new Date().toISOString(),
    commit: await gitHead(),
    platform: `${process.platform}/${process.arch} bun ${process.versions.bun}`,
    point: "run.turn.pre",
    iterations,
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
